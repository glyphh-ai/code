/**
 * YoChat — LLM engine for inline yo/sup/wassup execution.
 *
 * Context-centric: the interceptor grabs content (yo) or loads it
 * from library (sup) before calling the LLM. The LLM processes
 * the context — it never reaches into app DOMs directly.
 *
 * Uses Claude Sonnet with tool use for library operations.
 */

import { PanelManager } from "./panel-manager";
import { Library } from "./library";

export interface ChatCallbacks {
  onText: (delta: string) => void;
  onToolUse: (name: string, input: unknown) => void;
  onDone: () => void;
}

const SYSTEM = `You are Yo, an AI assistant embedded in the YoSup desktop workspace.
You process content that the user has loaded as context. You do not control apps directly — the user works in their apps and passes you context to operate on.

Capabilities:
- yo_save: save processed content to the library
- sup_load: read a library file for reference
- library_list / library_search: find files in the library
- dip: switch the active panel

When given context, process it according to the user's instruction.
Save results to the library when appropriate. Be concise.`;

const TOOLS = [
  {
    name: "yo_save",
    description: "Save content to the library as a markdown file.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string" as const, description: "File name (no .md)" },
        content: { type: "string" as const, description: "Markdown content" },
      },
      required: ["name", "content"],
    },
  },
  {
    name: "sup_load",
    description: "Load and return the contents of a library file.",
    input_schema: {
      type: "object" as const,
      properties: { name: { type: "string" as const, description: "File name (no .md)" } },
      required: ["name"],
    },
  },
  {
    name: "library_list",
    description: "List all files in ~/yo/library/.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "library_search",
    description: "Search library files by name or content.",
    input_schema: {
      type: "object" as const,
      properties: { query: { type: "string" as const, description: "Search term" } },
      required: ["query"],
    },
  },
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
  private apiKey: string | null = null;
  private commandCallback: ((cmd: string) => Promise<string>) | null = null;

  constructor(
    private panelManager: PanelManager,
    private library: Library,
  ) {
    this.apiKey = process.env.ANTHROPIC_API_KEY || null;
  }

  setCommandCallback(cb: (cmd: string) => Promise<string>): void {
    this.commandCallback = cb;
  }

  async send(message: string, cb: ChatCallbacks): Promise<void> {
    this.apiKey = process.env.ANTHROPIC_API_KEY || this.apiKey;
    if (!this.apiKey) {
      cb.onText("No API key configured. Add your Anthropic API key in settings.");
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
   * One-shot LLM execution for inline yo/sup from the interceptor.
   * Uses a separate history so it doesn't pollute the chat conversation.
   * Runs non-streaming and returns the final text result.
   */
  async executeInline(
    command: "yo" | "sup",
    instruction: string,
    appId: string,
    appContent?: string,
  ): Promise<string> {
    this.apiKey = process.env.ANTHROPIC_API_KEY || this.apiKey;
    if (!this.apiKey) return "No API key configured.";

    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: this.apiKey! });

    const context = this.buildContext();
    const userParts: string[] = [];
    if (command === "yo") {
      userParts.push(`The user typed "yo ${instruction}".`);
      userParts.push(`They want to process and save content from their current app.`);
      if (appContent) {
        userParts.push(`\nHere is the content:\n\n${appContent.slice(0, 8000)}`);
      }
      userParts.push(`\nProcess according to the instruction and save the result to the library. Be concise.`);
    } else {
      userParts.push(`The user typed "sup ${instruction}".`);
      userParts.push(`They want to find a file in the library. Search for it and return the file name. Be concise.`);
    }

    const messages: any[] = [{ role: "user", content: userParts.join("\n") }];
    let finalText = "";

    // Tool loop (max 5 iterations to prevent runaway)
    for (let i = 0; i < 5; i++) {
      const response = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2048,
        system: SYSTEM + "\n\n" + context,
        messages,
        tools: TOOLS as any,
      });

      messages.push({ role: "assistant", content: response.content });

      // Collect text
      for (const block of response.content) {
        if (block.type === "text") finalText += block.text;
      }

      // Handle tool calls
      const toolBlocks = response.content.filter((b: any) => b.type === "tool_use");
      if (toolBlocks.length > 0 && response.stop_reason === "tool_use") {
        const results: any[] = [];
        for (const block of toolBlocks) {
          if (block.type !== "tool_use") continue;
          const result = await this.exec(block.name, block.input as Record<string, unknown>);
          results.push({ type: "tool_result", tool_use_id: block.id, content: result });
        }
        messages.push({ role: "user", content: results });
        finalText = ""; // reset — we want the final text after all tools
      } else {
        break;
      }
    }

    return finalText || "Done.";
  }

  // ── Stream + tool loop ────────────────────────────────

  private async streamLoop(cb: ChatCallbacks): Promise<void> {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: this.apiKey! });

    const context = this.buildContext();

    const stream = client.messages.stream({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: SYSTEM + "\n\n" + context,
      messages: this.history,
      tools: TOOLS as any,
    });

    stream.on("text", (text: string) => cb.onText(text));

    const response = await stream.finalMessage();
    this.history.push({ role: "assistant", content: response.content });

    // Handle tool calls
    const toolBlocks = response.content.filter((b: any) => b.type === "tool_use");
    if (toolBlocks.length > 0 && response.stop_reason === "tool_use") {
      const results: any[] = [];
      for (const block of toolBlocks) {
        if (block.type !== "tool_use") continue;
        cb.onToolUse(block.name, block.input);
        const result = await this.exec(block.name, block.input as Record<string, unknown>);
        results.push({ type: "tool_result", tool_use_id: block.id, content: result });
      }
      this.history.push({ role: "user", content: results });
      await this.streamLoop(cb); // continue conversation
    } else {
      cb.onDone();
    }
  }

  private buildContext(): string {
    const lines: string[] = ["## Current State"];
    lines.push(`Active panel: ${this.panelManager.activePanelId || "none"}`);

    const files = this.library.list();
    if (files.length > 0) {
      lines.push(`\n## Library (${files.length} files)`);
      lines.push(files.slice(0, 30).join(", "));
    }

    return lines.join("\n");
  }

  // ── Tool execution ────────────────────────────────────

  private async exec(name: string, input: Record<string, unknown>): Promise<string> {
    try {
      switch (name) {
        case "yo_save":
          this.library.write(input.name as string, input.content as string);
          return `Saved: ${input.name}.md`;
        case "sup_load":
          return this.library.read(input.name as string) || `File "${input.name}" not found.`;
        case "library_list": {
          const files = this.library.list();
          return files.length > 0 ? files.map((f) => `${f}.md`).join("\n") : "Library is empty.";
        }
        case "library_search": {
          const files = this.library.search(input.query as string);
          return files.length > 0 ? files.map((f) => `${f}.md`).join("\n") : `No files matching "${input.query}".`;
        }
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
