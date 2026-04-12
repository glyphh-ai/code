/**
 * ConnectorAgent — LLM-powered DOM analysis.
 *
 * Given a page's DOM structure, the agent identifies interactive
 * elements and maps standard commands (grab, push, submit, clear, read)
 * plus discovers app-specific actions.
 *
 * Does 99% of the connector work. DOM picker handles the rest.
 */

import { WebContents } from "electron";
import { CommandMapping, STANDARD_COMMANDS } from "./app-connector";
import { extractDomStructure, validateSelector } from "./dom-bridge";

interface AgentResult {
  commands: Record<string, CommandMapping>;
  meta: {
    description: string;
    capabilities: string[];
  };
}

const AGENT_SYSTEM_PROMPT = `You are a DOM connector agent for YoSup, a desktop app that bridges web applications.

Your job: Given a simplified DOM tree of a web page, map standard commands to CSS selectors and discover app-specific actions.

## Standard Commands to Map
- grab: Extract the main content area (conversation, feed, document body). Use "extractText" or "extractHTML" action.
- push: Target the primary text input (chat box, compose area, search bar). Use "setValue" action.
- submit: The send/submit button. Use "click" action.
- clear: How to clear the input. Usually the same selector as push but with "custom" action and a script.
- read: Lightweight read of visible content. Use "extractText" action on the main content area.

## App-Specific Commands
Discover additional capabilities based on the app type. Examples:
- Chat apps: new-chat, switch-thread
- Email apps: compose, reply, forward
- Project tools: create-ticket, add-comment
- Any clickable action that a user would commonly perform

## Rules
1. Use the most SPECIFIC selector possible: prefer [data-testid], #id, [aria-label], [role] over tag/class paths.
2. For contenteditable divs (common in chat apps), the selector should target the contenteditable element itself.
3. For "grab", target the scrollable conversation/content container, not the whole page.
4. Only map commands you're confident about. Skip rather than guess wrong.
5. For "custom" actions, provide a JavaScript snippet in the "script" field that executes in page context.

## Response Format
Return ONLY valid JSON (no markdown, no explanation):
{
  "commands": {
    "grab": { "selector": "...", "action": "extractText", "description": "..." },
    "push": { "selector": "...", "action": "setValue", "description": "..." },
    ...additional commands...
  },
  "meta": {
    "description": "Brief description of what this app is",
    "capabilities": ["list", "of", "things", "this", "app", "can", "do"]
  }
}`;

export class ConnectorAgent {
  private apiKey: string | null = null;

  constructor() {
    this.apiKey = process.env.ANTHROPIC_API_KEY || null;
  }

  /**
   * Analyze a page's DOM and return command mappings.
   * Extracts DOM structure, sends to LLM, validates results.
   */
  async analyze(webContents: WebContents, appName: string, appUrl: string): Promise<AgentResult> {
    if (!this.apiKey) {
      throw new Error("No API key configured. Set your Anthropic API key in settings.");
    }

    // 1. Extract DOM structure
    const domJson = await extractDomStructure(webContents);

    // 2. Send to LLM
    const userPrompt = `Analyze this web app and map commands to DOM selectors.

App: ${appName}
URL: ${appUrl}

DOM Structure:
${domJson}`;

    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: this.apiKey });

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: AGENT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });

    const block = response.content[0];
    if (block.type !== "text") {
      throw new Error("Unexpected response from LLM");
    }

    // 3. Parse response
    let result: AgentResult;
    try {
      result = JSON.parse(block.text);
    } catch {
      // Try to extract JSON from markdown code block
      const match = block.text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match) {
        result = JSON.parse(match[1]);
      } else {
        throw new Error("Failed to parse LLM response as JSON");
      }
    }

    // 4. Validate selectors against live DOM
    const validatedCommands: Record<string, CommandMapping> = {};
    for (const [key, mapping] of Object.entries(result.commands)) {
      try {
        const exists = await validateSelector(webContents, mapping.selector);
        if (exists) {
          validatedCommands[key] = mapping;
        }
        // silently skip selectors that don't match
      } catch {
        // skip on error
      }
    }

    return {
      commands: validatedCommands,
      meta: result.meta || { description: appName, capabilities: [] },
    };
  }
}
