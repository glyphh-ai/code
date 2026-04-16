/**
 * YoChat — LLM engine for inline yo execution.
 *
 * Context-centric: the interceptor grabs content or the context store
 * provides retrieved chunks. The LLM processes the context — it never
 * reaches into app DOMs directly.
 *
 * Uses Claude Sonnet with tool use for workspace operations.
 */

import { PanelManager } from "./panel-manager";
import { LLMConfig, createCompletion, createStream } from "./llm-config";

export interface ChatCallbacks {
  onText: (delta: string) => void;
  onToolUse: (name: string, input: unknown) => void;
  onDone: () => void;
}

const SYSTEM_RETRIEVAL = `You are a retrieval tool. You receive context chunks from the user's workspace and a query.

Your ONLY job: find the chunks that match the query and return their content VERBATIM. Copy-paste the relevant text exactly as it appears. Do not summarize, do not paraphrase, do not shorten, do not reformat.

RULES:
- Return the raw matching content. Nothing else.
- NEVER add preamble, commentary, or explanation.
- NEVER say "Based on...", "I found...", "Here is...", "The context shows..."
- NEVER summarize or condense. Return the FULL text of matching chunks.
- Do not add formatting. No markdown. No headers. No bullet points unless they exist in the source.
- If multiple chunks match, return all of them separated by blank lines.
- If nothing matches: not found`;

const SYSTEM_CONVERSATION = `You are yo, a retrieval agent. The user talks to you by typing .yo <message>. Your response appears in their text input field.

You have context chunks from the user's workspace below.

RULES:
- Return the ACTUAL content from the chunks. Not a summary. Not a description. The real text.
- NEVER say "I found...", "Here's...", "It looks like...", "I see...". Just return the content.
- If one chunk clearly matches: return its content verbatim. Copy-paste it.
- If multiple chunks match and it's ambiguous: list them briefly so the user can pick. Keep each to one line. Example: "found two: (1) reddit post about launch timing (2) reddit post about pricing strategy — which one?"
- When the user picks one: return that chunk's full content verbatim.
- If the user asks to combine or summarize: do that, but still return actual text not commentary.
- Plain text only. No markdown.
- If nothing matches: "nothing found — try different words?"
- Short disambiguation questions are OK. Descriptions of content are NOT OK. Return the content itself.`;

const TOOLS = [
  {
    name: "dip",
    description: "Switch to a panel or layout.",
    input_schema: {
      type: "object" as const,
      properties: { panel: { type: "string" as const, description: "Panel ID" } },
      required: ["panel"],
    },
  },
];

export class YoChat {
  private history: any[] = [];
  private llmConfig: LLMConfig | null = null;
  private commandCallback: ((cmd: string) => Promise<string>) | null = null;
  constructor(
    private panelManager: PanelManager,
  ) {}

  setLLMConfig(config: LLMConfig): void { this.llmConfig = config; }

  setCommandCallback(cb: (cmd: string) => Promise<string>): void {
    this.commandCallback = cb;
  }


  async send(message: string, cb: ChatCallbacks): Promise<void> {
    if (!this.llmConfig?.apiKey) {
      cb.onText("No API key configured. Set your LLM provider in Settings.");
      cb.onDone();
      return;
    }

    this.history.push({ role: "user", content: message });

    try {
      await this.streamLoop(cb);
    } catch (err) {
      cb.onText(`\n\nError: ${err instanceof Error ? err.message : err}`);
      cb.onDone();
    }
  }

  clear(): void {
    this.history = [];
  }

  /**
   * Workbench refinement — skill-aware. Returns a chat message, the
   * full document content, and whether the result is a skill or content.
   *
   * The LLM knows about existing skills and can create/update them.
   * It signals via <type>skill</type> or <type>content</type>.
   */
  async refine(
    instruction: string,
    content: string,
    skillNames: string[],
  ): Promise<{ message: string; content: string; type: "skill" | "content" }> {
    if (!this.llmConfig?.apiKey) return { message: "", content: "No API key configured.", type: "content" };

    const context = this.buildContext();

    const skillList = skillNames.length > 0
      ? `Existing skills: ${skillNames.join(", ")}`
      : "No skills exist yet.";

    const userPrompt = `You are working in the user's content workspace. The workspace has two types of items:

1. **Content** — documents, notes, artifacts
2. **Skills** — reusable prompt templates that transform content (stored as skill files)

${skillList}

A skill is a system prompt / instruction template. When the user says "create a skill" or "update the X skill", you are creating or editing a prompt template, NOT processing content. The skill prompt should be written as instructions for an AI to follow when processing content (e.g. "You are a professional email formatter. Take the user's casual input and rewrite it as a polished professional email...").

IMPORTANT: Every skill prompt you generate MUST include an explicit instruction to output plain text without markdown formatting. Skill output gets pasted into real apps (email, chat, docs) where markdown syntax looks broken. Always include a line like: "Output plain text only. Do not use markdown formatting (no **, no ## headers, no bullet symbols). Use natural line breaks and spacing."

When the user asks to modify, update, refine, or create content/artifacts, use type "content".
When the user asks to create, update, or modify a skill, use type "skill".

User instruction: ${instruction}

${content ? `Current content:\n${content.slice(0, 8000)}` : "(No content loaded)"}

Return your response in this exact format — all three parts are required:
<type>skill or content</type>
<message>Brief 1-2 sentence summary of what you created or changed</message>
<document>
The complete output — either the refined content OR the skill prompt template
</document>

Return the FULL document between <document> tags. Do NOT abbreviate or summarize it.`;

    const response = await createCompletion(this.llmConfig!, {
      system: SYSTEM_RETRIEVAL + "\n\n" + context,
      messages: [{ role: "user", content: userPrompt }],
      maxTokens: 4096,
    });

    let text = "";
    for (const block of response.content) {
      if (block.type === "text") text += block.text;
    }

    const typeMatch = text.match(/<type>(skill|content)<\/type>/i);
    const msgMatch = text.match(/<message>([\s\S]*?)<\/message>/);
    const docMatch = text.match(/<document>([\s\S]*?)<\/document>/);

    const resultType = typeMatch && typeMatch[1].toLowerCase() === "skill" ? "skill" : "content";

    if (docMatch) {
      return {
        message: msgMatch ? msgMatch[1].trim() : "",
        content: docMatch[1].trim(),
        type: resultType,
      };
    }

    // Fallback: treat entire response as content
    return { message: "", content: text, type: resultType };
  }

  /**
   * One-shot LLM execution for inline yo/sup from the interceptor.
   * Uses a separate history so it doesn't pollute the chat conversation.
   * Runs non-streaming and returns the final text result.
   */
  async executeInline(
    command: "yo",
    instruction: string,
    appId: string,
    appContent?: string,
  ): Promise<string> {
    if (!this.llmConfig?.apiKey) return "No API key configured.";

    const isConversation = appId === "yo-conversation" || appId === "yo-refine";
    const system = isConversation ? SYSTEM_CONVERSATION : SYSTEM_RETRIEVAL;

    const userParts: string[] = [];
    userParts.push(isConversation ? instruction : `Query: ${instruction}`);
    if (appContent) {
      userParts.push(`\nContext chunks:\n\n${appContent.slice(0, 24000)}`);
    }

    const response = await createCompletion(this.llmConfig, {
      system,
      messages: [{ role: "user", content: userParts.join("\n") }],
      maxTokens: isConversation ? 1024 : 4096,
    });

    let text = "";
    for (const block of response.content) {
      if (block.type === "text") text += block.text;
    }
    return text || "not found";
  }

  // ── Stream + tool loop ────────────────────────────────

  private async streamLoop(cb: ChatCallbacks): Promise<void> {
    const context = this.buildContext();

    const response = await createStream(
      this.llmConfig!,
      { system: SYSTEM_RETRIEVAL + "\n\n" + context, messages: this.history, tools: TOOLS, maxTokens: 4096 },
      (text) => cb.onText(text),
    );

    this.history.push({ role: "assistant", content: response.content });

    // Handle tool calls
    const toolBlocks = response.content.filter((b: any) => b.type === "tool_use");
    if (toolBlocks.length > 0 && response.stopReason === "tool_use") {
      const results: any[] = [];
      for (const block of toolBlocks) {
        if (block.type !== "tool_use") continue;
        cb.onToolUse(block.name, block.input);
        const result = await this.exec(block.name, block.input as Record<string, unknown>);
        results.push({ type: "tool_result", tool_use_id: block.id, content: result });
      }
      this.history.push({ role: "user", content: results });
      await this.streamLoop(cb);
    } else {
      cb.onDone();
    }
  }

  private buildContext(): string {
    const lines: string[] = ["## Current State"];
    lines.push(`Active panel: ${this.panelManager.activePanelId || "none"}`);
    return lines.join("\n");
  }

  // ── Tool execution ────────────────────────────────────

  private async exec(name: string, input: Record<string, unknown>): Promise<string> {
    try {
      switch (name) {
        case "dip":
          if (this.commandCallback) return this.commandCallback(`dip ${input.panel}`);
          return "Panel switching not available.";
        default:
          return `Unknown tool: ${name}`;
      }
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  }

}
