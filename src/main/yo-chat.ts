/**
 * YoChat — LLM-powered chat for cross-app automation.
 *
 * An AI agent that lives inside yo with full access to:
 * - Connected apps (grab, push, submit, read, clear, custom commands)
 * - Panels and layouts (dip)
 * - Library files (yo/sup)
 *
 * Uses Claude Sonnet with streaming + tool use.
 */

import { AppConnector } from "./app-connector";
import { PanelManager } from "./panel-manager";
import { Library } from "./library";
import { executeCommand } from "./dom-bridge";

export interface ChatCallbacks {
  onText: (delta: string) => void;
  onToolUse: (name: string, input: unknown) => void;
  onDone: () => void;
}

const SYSTEM = `You are Yo, an AI assistant embedded in the YoSup desktop workspace.
You can see and control connected web apps through DOM-level commands.

Capabilities:
- grab: extract content from any connected app panel
- push: inject text into an app's input
- submit: trigger send/submit in an app
- dip: switch panels (claude, gemini, gpt, code, cowork, or custom)
- yo_save / sup_load: save/load markdown files in ~/yo/library/
- library_list / library_search: browse the library
- app_command: run any mapped command on any connected app
- apps_list: see all connected apps

When asked to do something, use tools — don't just describe what you'd do.
Be concise. Act, then confirm.`;

const TOOLS = [
  {
    name: "grab",
    description: "Extract the main content/conversation from a connected app panel.",
    input_schema: {
      type: "object" as const,
      properties: { app: { type: "string" as const, description: "App/panel ID" } },
      required: ["app"],
    },
  },
  {
    name: "push",
    description: "Inject text into a connected app's primary input field.",
    input_schema: {
      type: "object" as const,
      properties: {
        app: { type: "string" as const, description: "App/panel ID" },
        content: { type: "string" as const, description: "Text to inject" },
      },
      required: ["app", "content"],
    },
  },
  {
    name: "submit",
    description: "Click the send/submit button in a connected app.",
    input_schema: {
      type: "object" as const,
      properties: { app: { type: "string" as const, description: "App/panel ID" } },
      required: ["app"],
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
    name: "app_command",
    description: "Run any mapped command on a connected app.",
    input_schema: {
      type: "object" as const,
      properties: {
        app: { type: "string" as const, description: "App ID" },
        command: { type: "string" as const, description: "Command name" },
        value: { type: "string" as const, description: "Optional value for setValue" },
      },
      required: ["app", "command"],
    },
  },
  {
    name: "apps_list",
    description: "List all connected apps and their available commands.",
    input_schema: { type: "object" as const, properties: {} },
  },
];

export class YoChat {
  private history: any[] = [];
  private apiKey: string | null = null;
  private commandCallback: ((cmd: string) => Promise<string>) | null = null;

  constructor(
    private appConnector: AppConnector,
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
      userParts.push(`The user typed "yo ${instruction}" inside the ${appId} app.`);
      userParts.push(`This means they want to CREATE/SAVE something.`);
      if (appContent) {
        userParts.push(`\nHere is the content grabbed from the app:\n\n${appContent.slice(0, 8000)}`);
      }
      userParts.push(`\nExecute the user's instruction. Use tools to save to library, process with skills, etc. Be concise in your final response.`);
    } else {
      userParts.push(`The user typed "sup ${instruction}" inside the ${appId} app.`);
      userParts.push(`This means they want to READ/PULL content from the library.`);
      userParts.push(`\nSearch the library, find the right content, and push it into the ${appId} app. Be concise in your final response.`);
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
    lines.push(`Panels: ${this.panelManager.listPanels().map((p) => p.id).join(", ")}`);

    const apps = this.appConnector.list();
    if (apps.length > 0) {
      lines.push("\n## Connected Apps");
      for (const app of apps) {
        const cmds = Object.keys(app.commands).join(", ") || "none";
        lines.push(`- **${app.id}** (${app.name}): ${app.url} [${cmds}]`);
      }
    }

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
        case "grab":
          return await this.toolGrab(input.app as string);
        case "push":
          return await this.toolPush(input.app as string, input.content as string);
        case "submit":
          return await this.toolSubmit(input.app as string);
        case "dip":
          return await this.toolDip(input.panel as string);
        case "yo_save":
          return this.toolSave(input.name as string, input.content as string);
        case "sup_load":
          return this.toolLoad(input.name as string);
        case "library_list":
          return this.toolList();
        case "library_search":
          return this.toolSearch(input.query as string);
        case "app_command":
          return await this.toolAppCmd(
            input.app as string,
            input.command as string,
            input.value as string | undefined,
          );
        case "apps_list":
          return this.toolAppsList();
        default:
          return `Unknown tool: ${name}`;
      }
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  }

  private async toolGrab(appId: string): Promise<string> {
    const wc = this.panelManager.getWebContents(appId);
    if (!wc) return `Panel "${appId}" not loaded. Switch to it with dip first.`;
    const app = this.appConnector.get(appId);
    if (app?.commands.grab) return executeCommand(wc, app.commands.grab);
    if (app?.commands.read) return executeCommand(wc, app.commands.read);
    return wc.executeJavaScript("document.body.innerText.slice(0,10000)");
  }

  private async toolPush(appId: string, content: string): Promise<string> {
    const wc = this.panelManager.getWebContents(appId);
    if (!wc) return `Panel "${appId}" not loaded.`;
    const app = this.appConnector.get(appId);
    if (app?.commands.push) return executeCommand(wc, app.commands.push, content);
    return "No push command mapped for this app.";
  }

  private async toolSubmit(appId: string): Promise<string> {
    const wc = this.panelManager.getWebContents(appId);
    if (!wc) return `Panel "${appId}" not loaded.`;
    const app = this.appConnector.get(appId);
    if (app?.commands.submit) return executeCommand(wc, app.commands.submit);
    return "No submit command mapped.";
  }

  private async toolDip(panel: string): Promise<string> {
    if (this.commandCallback) return this.commandCallback(`dip ${panel}`);
    return "Panel switching not available.";
  }

  private toolSave(name: string, content: string): string {
    this.library.write(name, content);
    return `Saved: ${name}.md`;
  }

  private toolLoad(name: string): string {
    return this.library.read(name) || `File "${name}" not found.`;
  }

  private toolList(): string {
    const files = this.library.list();
    return files.length > 0 ? files.map((f) => `${f}.md`).join("\n") : "Library is empty.";
  }

  private toolSearch(query: string): string {
    const files = this.library.search(query);
    return files.length > 0 ? files.map((f) => `${f}.md`).join("\n") : `No files matching "${query}".`;
  }

  private async toolAppCmd(appId: string, command: string, value?: string): Promise<string> {
    const wc = this.panelManager.getWebContents(appId);
    if (!wc) return `Panel "${appId}" not loaded.`;
    const app = this.appConnector.get(appId);
    if (!app) return `App "${appId}" not found.`;
    const mapping = app.commands[command];
    if (!mapping) {
      return `Command "${command}" not mapped. Available: ${Object.keys(app.commands).join(", ")}`;
    }
    return executeCommand(wc, mapping, value);
  }

  private toolAppsList(): string {
    const apps = this.appConnector.list();
    if (apps.length === 0) return "No connected apps.";
    return apps
      .map((a) => {
        const cmds = Object.keys(a.commands).join(", ") || "none";
        return `${a.id} (${a.name}): ${a.url}\n  Commands: ${cmds}`;
      })
      .join("\n\n");
  }
}
