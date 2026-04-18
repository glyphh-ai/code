/**
 * ConnectorAgent — LLM-powered DOM analysis.
 *
 * Two-pass analysis:
 *   Pass 1: Classify the app and map standard commands (grab, input, submit, new, search)
 *   Pass 2: Deep-map category-specific commands (chat, email, project, docs, social, code)
 *
 * Produces a comprehensive command set that the navigator agent can execute.
 */

import { WebContents } from "electron";
import { CommandMapping, CATEGORY_COMMANDS } from "./app-connector";
import { extractDomStructure, validateSelector } from "./dom-bridge";
import { LLMConfig, createCompletion } from "./llm-config";

interface AgentResult {
  commands: Record<string, CommandMapping>;
  meta: {
    description: string;
    category: string;
    capabilities: string[];
  };
}

// ── Pass 1: Classify + Standard Commands ────────────────

const PASS1_SYSTEM = `You are a DOM analysis agent for YoSup, a desktop workspace that bridges web applications.

Your job: Given a structured DOM scan of a web page, do TWO things:
1. CLASSIFY the app into a category
2. MAP the standard commands to specific DOM selectors

## App Categories
- chat: Conversational AI, messaging (ChatGPT, Claude, Gemini, Slack, Discord)
- email: Email clients (Gmail, Outlook, Yahoo Mail)
- project: Project management, issue tracking (Linear, Jira, Notion databases, Trello, Asana)
- docs: Document editors, note-taking (Google Docs, Notion pages, Confluence)
- social: Social media, feeds (Twitter/X, Reddit, LinkedIn, YouTube)
- code: Code editors, IDEs, repositories (GitHub, GitLab, VS Code web)
- generic: Anything else

## Standard Commands (map ALL that exist on the page)

- grab: Extract the main content area. Use "extractText" action. Target the scrollable conversation, feed, document body, or main content container — NOT the whole page. Pick the most specific container.
- input: The primary text input where the user types messages/queries. Use "setValue" action. For contenteditable divs, target the editable element itself. For chat apps this is the chat box; for email it's the body field; for search-heavy apps it's the search bar.
- submit: The primary submit/send button next to the input. Use "click" action. This is the send button, submit button, or search button paired with the input.
- new: Start a new item. Use "click" action. New chat, compose email, new document, create issue, etc.
- search: The search input or search trigger button. Use "setValue" if it's an input, "click" if it's a button that opens search.

## Selector Rules
1. PREFER: #id, [data-testid="..."], [aria-label="..."], [placeholder="..."]
2. AVOID: class-based selectors that look generated/hashed (random strings)
3. For contenteditable, target the [contenteditable="true"] or [role="textbox"] element
4. Use the "zone" field to disambiguate: "bottom-center" inputs are usually chat boxes, "top-center" inputs are usually search bars
5. Use "nearInput" on buttons to match submit buttons to their inputs

## Response Format
Return ONLY valid JSON:
{
  "category": "chat|email|project|docs|social|code|generic",
  "commands": {
    "grab": { "selector": "...", "action": "extractText", "description": "..." },
    "input": { "selector": "...", "action": "setValue", "description": "..." },
    "submit": { "selector": "...", "action": "click", "description": "..." },
    "new": { "selector": "...", "action": "click", "description": "..." },
    "search": { "selector": "...", "action": "setValue", "description": "..." }
  },
  "meta": {
    "description": "Brief description of the app",
    "capabilities": ["what", "this", "app", "can", "do"]
  }
}

IMPORTANT:
- Only include commands you're CONFIDENT about. Skip rather than guess wrong.
- Every selector must actually exist in the DOM scan provided.
- The "description" should be human-readable: "Send message", "Extract chat history", etc.
- For "grab", prefer the conversation/content area with scrollable=true if available.`;

// ── Pass 2: Category-Specific Deep Commands ─────────────

const PASS2_SYSTEM = `You are a DOM analysis agent performing a DEEP MAPPING pass on a web application.

You already know the app's category and have its standard commands mapped. Now map the category-specific commands.

## Selector Rules
1. PREFER: #id, [data-testid="..."], [aria-label="..."], [placeholder="..."]
2. For "click" actions, find the actual button/link element
3. For "setValue" actions, find the actual input/textarea/contenteditable element
4. For "extractText" actions, find the content container
5. For complex multi-step actions, use "custom" action with a JavaScript snippet

## Custom Scripts
For "custom" action, provide a "script" field with JavaScript that runs in page context.
- The variable \`__value__\` contains any input value passed by the agent.
- The script should return a string result.
- Keep scripts under 500 chars.
- Scripts can click, read, scroll, wait (use setTimeout sparingly).

Example custom script for "copy last response in a chat app":
  "script": "var msgs = document.querySelectorAll('[data-testid=\\"message\\"]'); var last = msgs[msgs.length-1]; return last ? last.innerText : 'No messages';"

## waitFor Field
If a command triggers a UI change (like opening a modal), set "waitFor" to the CSS selector
of an element that appears AFTER the action. The system will wait for it before proceeding.

Example: clicking "Compose" in Gmail opens a compose window, so:
  { "selector": "[aria-label='Compose']", "action": "click", "waitFor": "[aria-label='New Message']", "description": "Open compose window" }

## Response Format
Return ONLY valid JSON with the discovered commands:
{
  "commands": {
    "command-name": {
      "selector": "...",
      "action": "extractText|extractHTML|setValue|click|custom",
      "description": "...",
      "script": "..." (only for custom),
      "waitFor": "..." (optional)
    }
  }
}

Only include commands you're CONFIDENT about. Map as many as you can find in the DOM.`;

// ── ConnectorAgent ──────────────────────────────────────

export class ConnectorAgent {
  private llmConfig: LLMConfig | null = null;

  constructor() {}

  setLLMConfig(config: LLMConfig): void { this.llmConfig = config; }

  /**
   * Analyze a page's DOM and return comprehensive command mappings.
   * Two-pass: classify + standard, then category-specific deep mapping.
   */
  async analyze(
    webContents: WebContents,
    appName: string,
    appUrl: string,
    onProgress?: (status: string) => void,
  ): Promise<AgentResult> {
    if (!this.llmConfig?.apiKey) {
      throw new Error("No API key configured. Set your LLM provider in Settings.");
    }

    // ── Extract DOM ──────────────────────────────
    onProgress?.("Scanning DOM structure...");
    const domJson = await extractDomStructure(webContents);

    // Truncate if massive (some SPAs have huge DOMs)
    const domTruncated = domJson.length > 30000
      ? domJson.slice(0, 30000) + "\n... [truncated, DOM too large]"
      : domJson;

    // ── Pass 1: Classify + Standard Commands ─────
    onProgress?.("Classifying app and mapping standard commands...");
    const pass1 = await this.llmCall(
      PASS1_SYSTEM,
      `Analyze this web app and map standard commands.\n\nApp: ${appName}\nURL: ${appUrl}\n\nDOM Scan:\n${domTruncated}`,
    );

    const category = (pass1.category as string) || "generic";
    const standardCommands = (pass1.commands || {}) as Record<string, CommandMapping>;
    const meta = (pass1.meta || {}) as Record<string, unknown>;

    // ── Validate Pass 1 selectors ────────────────
    onProgress?.("Validating selectors...");
    const validStandard = await this.validateCommands(webContents, standardCommands);

    // ── Pass 2: Category-Specific Deep Mapping ───
    const categoryDefs = CATEGORY_COMMANDS[category];
    let deepCommands: Record<string, CommandMapping> = {};

    if (categoryDefs && categoryDefs.length > 0) {
      onProgress?.(`Deep-mapping ${category} commands...`);

      const commandList = categoryDefs
        .filter((c: { key: string; description: string }) => !validStandard[c.key])
        .map((c: { key: string; description: string }) => `- ${c.key}: ${c.description}`)
        .join("\n");

      if (commandList) {
        const pass2Prompt = `The app "${appName}" (${appUrl}) is a ${category} app.

Standard commands already mapped: ${Object.keys(validStandard).join(", ")}

Now map these category-specific commands (skip any that don't exist on this page):
${commandList}

DOM Scan:
${domTruncated}`;

        try {
          const pass2 = await this.llmCall(PASS2_SYSTEM, pass2Prompt);
          deepCommands = (pass2.commands || {}) as Record<string, CommandMapping>;
        } catch {
          // Pass 2 failure is non-fatal — we still have standard commands
        }

        // Validate Pass 2 selectors
        if (Object.keys(deepCommands).length > 0) {
          onProgress?.("Validating deep commands...");
          deepCommands = await this.validateCommands(webContents, deepCommands);
        }
      }
    }

    // ── Merge results ────────────────────────────
    const allCommands = { ...validStandard, ...deepCommands };

    onProgress?.(`Mapped ${Object.keys(allCommands).length} commands.`);

    return {
      commands: allCommands,
      meta: {
        description: (meta.description as string) || appName,
        category,
        capabilities: (meta.capabilities as string[]) || [],
      },
    };
  }

  /** Single LLM call — parses JSON from response. */
  private async llmCall(system: string, userPrompt: string): Promise<Record<string, unknown>> {
    const response = await createCompletion(this.llmConfig!, {
      system,
      messages: [{ role: "user", content: userPrompt }],
      maxTokens: 4096,
    });

    const block = response.content[0];
    if (block.type !== "text") {
      throw new Error("Unexpected response from LLM");
    }

    try {
      return JSON.parse(block.text);
    } catch {
      // Try to extract JSON from markdown code block
      const match = block.text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match) {
        return JSON.parse(match[1]);
      }
      throw new Error("Failed to parse LLM response as JSON");
    }
  }

  /** Validate selectors against live DOM, return only valid ones. */
  private async validateCommands(
    webContents: WebContents,
    commands: Record<string, CommandMapping>,
  ): Promise<Record<string, CommandMapping>> {
    const validated: Record<string, CommandMapping> = {};

    // Validate all in parallel for speed
    const entries = Object.entries(commands);
    const results = await Promise.allSettled(
      entries.map(async ([key, mapping]) => {
        // Custom scripts with empty selector are valid
        if (mapping.action === "custom" && mapping.script && !mapping.selector) {
          return { key, mapping, valid: true };
        }
        if (!mapping.selector) return { key, mapping, valid: false };
        const exists = await validateSelector(webContents, mapping.selector);
        return { key, mapping, valid: exists };
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value.valid) {
        validated[result.value.key] = result.value.mapping;
      }
    }

    return validated;
  }
}
