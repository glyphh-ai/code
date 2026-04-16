/**
 * YoAgent — retrieval agent for .yo commands.
 *
 * A full conversational agent with tools for finding context across
 * the user's workspace: memory (context store), file system, and
 * live panel content. Streams responses token-by-token.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { LLMConfig, createStream, createCompletion } from "./llm-config";
import type { NoteStore } from "./note-store";
import type { AppConnector } from "./app-connector";

export interface YoAgentCallbacks {
  onText: (delta: string) => void;
  onToolUse: (name: string) => void;
  onDone: (fullText: string) => void;
  onError: (error: string) => void;
}

const SYSTEM = `You are yo, a workspace agent. You can navigate apps, click through content, read live panels, search notes, and write notes. Plain text only, no markdown.

CRITICAL: NEVER ask the user for clarification. Act immediately. If the user asks to find something, start by listing panels, grabbing content, navigating, and clicking through apps to find it. If they want something from their notes, search_notes. If they want to save something, write_note.

WORKFLOW:
1. User sends a message → immediately take action (list_panels, grab_panel, search_notes, navigate, click)
2. If you need to find content in an app: list_panels → grab_panel to see what's there → click_element to drill in → grab_panel again
3. Chain multiple navigations and clicks to find what the user wants — don't stop after one step
4. When you find what they want, return the actual content

RESPONSE RULES:
- Return the ACTUAL content. Not a summary. The real text.
- NEVER say "I found...", "Here's...", "Based on...", "Let me search..."
- If one thing clearly matches: return its content verbatim.
- If multiple things match: list them briefly so the user can pick.
- Plain text only. No ** no ## no - bullets.
- Use conversation history for context. If the user says "the earlier one" or "that one", look at what you previously found.`;

const TOOLS = [
  {
    name: "search_notes",
    description: "Search saved notes in ~/yo/notes/. Uses vector similarity when available, falls back to keyword search. Returns matching notes with title and content.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string" as const, description: "Natural language search query" },
        limit: { type: "number" as const, description: "Max results (default 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "write_note",
    description: "Save a note to ~/yo/notes/ for future reference. Use this to remember information the user wants to keep — summaries, extracted content, research findings.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string" as const, description: "Short title for the note" },
        content: { type: "string" as const, description: "Full text content of the note" },
      },
      required: ["title", "content"],
    },
  },
  {
    name: "search_files",
    description: "Search file contents by text/regex pattern. Searches the user's home directory and common project locations. Returns matching file paths and line previews.",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: { type: "string" as const, description: "Text or regex pattern to search for" },
        directory: { type: "string" as const, description: "Directory to search in (default: ~/). Use ~ for home." },
        file_pattern: { type: "string" as const, description: "Glob to filter files, e.g. '*.md', '*.ts' (default: all text files)" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "read_file",
    description: "Read the contents of a specific file. Returns the full text content.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string" as const, description: "Absolute path or ~/relative path to the file" },
        max_lines: { type: "number" as const, description: "Max lines to read (default: 200)" },
      },
      required: ["path"],
    },
  },
  {
    name: "list_files",
    description: "List files and directories at a path. Use to explore the file system structure before reading specific files.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string" as const, description: "Directory path (default: ~/). Use ~ for home." },
        pattern: { type: "string" as const, description: "Filter by name pattern, e.g. '*.md'" },
        recursive: { type: "boolean" as const, description: "Search subdirectories (default: false, max depth 3)" },
      },
      required: [],
    },
  },
  {
    name: "grab_panel",
    description: "Grab the current live content from a workspace panel (e.g. claude, gmail, gpt). Returns the visible text content.",
    input_schema: {
      type: "object" as const,
      properties: {
        panel_id: { type: "string" as const, description: "Panel ID to grab content from" },
      },
      required: ["panel_id"],
    },
  },
  {
    name: "list_panels",
    description: "List all available workspace panels with their IDs and URLs.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "click_element",
    description: "Click an element on a workspace panel by its visible text or CSS selector. Use this to open emails, expand items, click links, navigate within apps. After clicking, use grab_panel to see the updated content.",
    input_schema: {
      type: "object" as const,
      properties: {
        panel_id: { type: "string" as const, description: "Panel ID to click within" },
        text: { type: "string" as const, description: "Visible text of the element to click (searches for closest match)" },
        selector: { type: "string" as const, description: "CSS selector to click (used if text not provided)" },
      },
      required: ["panel_id"],
    },
  },
  {
    name: "navigate_panel",
    description: "Navigate a workspace panel to a specific URL. Use this to open specific pages within an app.",
    input_schema: {
      type: "object" as const,
      properties: {
        panel_id: { type: "string" as const, description: "Panel ID to navigate" },
        url: { type: "string" as const, description: "URL to navigate to" },
      },
      required: ["panel_id", "url"],
    },
  },
  {
    name: "type_text",
    description: "Type text into an input field on a workspace panel. Finds the input by nearby label text, placeholder text, or CSS selector, focuses it, and types. Use clear=true to clear existing content first.",
    input_schema: {
      type: "object" as const,
      properties: {
        panel_id: { type: "string" as const, description: "Panel ID to type in" },
        text: { type: "string" as const, description: "Text to type into the input" },
        label: { type: "string" as const, description: "Label text near the input (e.g. 'To', 'Subject', 'Search')" },
        placeholder: { type: "string" as const, description: "Placeholder text of the input (e.g. 'Recipients', 'Type here')" },
        selector: { type: "string" as const, description: "CSS selector for the input (used if label/placeholder not provided)" },
        clear: { type: "boolean" as const, description: "Clear existing content before typing (default: true)" },
      },
      required: ["panel_id", "text"],
    },
  },
];

const CHATS_DIR = path.join(os.homedir(), "yo", "chats");

export interface ChatSummary {
  id: string;
  title: string;
  created: string;
  messageCount: number;
}

export class YoAgent {
  private history: any[] = [];
  private chatId: string | null = null;
  private chatTitle: string = "";
  private maxMessages = 40;  // context window — configurable
  private llmConfig: LLMConfig | null = null;
  private noteStore: NoteStore | null = null;
  private appConnector: AppConnector | null = null;
  private panelGrabber: ((panelId: string) => Promise<string | null>) | null = null;
  private panelClicker: ((panelId: string, text?: string, selector?: string) => Promise<string>) | null = null;
  private panelNavigator: ((panelId: string, url: string) => Promise<string>) | null = null;
  private panelTyper: ((panelId: string, text: string, opts: { label?: string; placeholder?: string; selector?: string; clear?: boolean }) => Promise<string>) | null = null;

  setLLMConfig(config: LLMConfig): void { this.llmConfig = config; }
  setNoteStore(store: NoteStore): void { this.noteStore = store; }
  setAppConnector(ac: AppConnector): void { this.appConnector = ac; }
  setPanelGrabber(fn: (panelId: string) => Promise<string | null>): void { this.panelGrabber = fn; }
  setPanelClicker(fn: (panelId: string, text?: string, selector?: string) => Promise<string>): void { this.panelClicker = fn; }
  setPanelNavigator(fn: (panelId: string, url: string) => Promise<string>): void { this.panelNavigator = fn; }
  setPanelTyper(fn: (panelId: string, text: string, opts: { label?: string; placeholder?: string; selector?: string; clear?: boolean }) => Promise<string>): void { this.panelTyper = fn; }

  /** Set the context window size (max messages before compaction). */
  setMaxMessages(n: number): void { this.maxMessages = n; }

  /** Start a new conversation (saves current, clears history). */
  clear(): void {
    this.saveChat();
    this.history = [];
    this.chatId = null;
    this.chatTitle = "";
  }

  /** Load an existing conversation by ID. */
  loadChat(id: string): boolean {
    const filepath = path.join(CHATS_DIR, `${id}.md`);
    if (!fs.existsSync(filepath)) return false;
    try {
      const raw = fs.readFileSync(filepath, "utf-8");
      const parsed = this.parseChatFile(raw);
      this.chatId = id;
      this.chatTitle = parsed.title;
      this.history = parsed.history;
      return true;
    } catch {
      return false;
    }
  }

  /** List all saved conversations, newest first. */
  listChats(): ChatSummary[] {
    fs.mkdirSync(CHATS_DIR, { recursive: true });
    try {
      const files = fs.readdirSync(CHATS_DIR)
        .filter((f) => f.endsWith(".md"))
        .sort().reverse();

      return files.map((f) => {
        try {
          const raw = fs.readFileSync(path.join(CHATS_DIR, f), "utf-8");
          const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
          let title = f.replace(/\.md$/, "");
          let created = "";
          let messageCount = 0;
          if (fmMatch) {
            const fm = fmMatch[1];
            const t = fm.match(/^title:\s*(.+)$/m);
            if (t) title = t[1].trim();
            const c = fm.match(/^created:\s*(.+)$/m);
            if (c) created = c[1].trim();
            const m = fm.match(/^messages:\s*(\d+)$/m);
            if (m) messageCount = parseInt(m[1], 10);
          }
          return { id: f.replace(/\.md$/, ""), title, created, messageCount };
        } catch {
          return { id: f.replace(/\.md$/, ""), title: f, created: "", messageCount: 0 };
        }
      });
    } catch {
      return [];
    }
  }

  /** Delete a saved conversation. */
  deleteChat(id: string): boolean {
    try {
      fs.unlinkSync(path.join(CHATS_DIR, `${id}.md`));
      return true;
    } catch { return false; }
  }

  /** Send a message and stream the response. Runs the full tool loop. */
  async send(message: string, cb: YoAgentCallbacks): Promise<void> {
    if (!this.llmConfig?.apiKey) {
      cb.onError("No API key configured. Set your LLM provider in Settings.");
      return;
    }

    this.history.push({ role: "user", content: message });

    // Auto-title from first user message
    if (!this.chatTitle) {
      this.chatTitle = message.slice(0, 80).replace(/\n/g, " ").trim();
    }

    // Auto-create chat ID on first message
    if (!this.chatId) {
      this.chatId = `${Date.now()}`;
    }

    // Compact if history exceeds context window
    if (this.history.length > this.maxMessages) {
      await this.compact();
    }

    try {
      await this.agentLoop(cb);
      this.saveChat(); // persist after each turn
    } catch (err) {
      cb.onError(err instanceof Error ? err.message : String(err));
    }
  }

  /** Get the last assistant text response from history. */
  getLastResponse(): string {
    for (let i = this.history.length - 1; i >= 0; i--) {
      const msg = this.history[i];
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const text = msg.content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("");
        if (text) return text;
      }
    }
    return "";
  }

  // ── Agent loop ────────────────────────────────────────

  private async agentLoop(cb: YoAgentCallbacks): Promise<void> {
    let fullText = "";

    const response = await createStream(
      this.llmConfig!,
      {
        system: SYSTEM,
        messages: this.history,
        tools: TOOLS,
        maxTokens: 4096,
      },
      (delta) => {
        fullText += delta;
        cb.onText(delta);
      },
    );

    this.history.push({ role: "assistant", content: response.content });

    // Handle tool calls
    const toolBlocks = response.content.filter((b: any) => b.type === "tool_use");
    if (toolBlocks.length > 0 && response.stopReason === "tool_use") {
      const results: any[] = [];
      for (const block of toolBlocks) {
        if (block.type !== "tool_use") continue;
        cb.onToolUse(block.name);
        const result = await this.execTool(block.name, block.input as Record<string, unknown>);
        results.push({ type: "tool_result", tool_use_id: block.id, content: result });
      }
      this.history.push({ role: "user", content: results });
      // Continue the loop — agent may want to use more tools or respond
      fullText = "";
      await this.agentLoop(cb);
    } else {
      cb.onDone(fullText);
    }
  }

  // ── Tool execution ────────────────────────────────────

  private async execTool(name: string, input: Record<string, unknown>): Promise<string> {
    try {
      switch (name) {
        case "search_notes": return await this.toolSearchNotes(input);
        case "write_note": return await this.toolWriteNote(input);
        case "search_files": return this.toolSearchFiles(input);
        case "read_file": return this.toolReadFile(input);
        case "list_files": return this.toolListFiles(input);
        case "grab_panel": return await this.toolGrabPanel(input);
        case "list_panels": return this.toolListPanels();
        case "click_element": return await this.toolClickElement(input);
        case "navigate_panel": return await this.toolNavigatePanel(input);
        case "type_text": return await this.toolTypeText(input);
        default: return `Unknown tool: ${name}`;
      }
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  }

  private async toolSearchNotes(input: Record<string, unknown>): Promise<string> {
    if (!this.noteStore) return "Note store not available.";
    const query = input.query as string;
    const limit = (input.limit as number) || 10;

    const hits = await this.noteStore.search(query, limit);
    if (hits.length === 0) return "No matching notes found.";

    const sections = hits.map((h) =>
      `[${h.title} | ${h.file} | ${this.formatAge(h.timestamp)}]\n${h.content}`
    );

    return sections.join("\n\n---\n\n");
  }

  private async toolWriteNote(input: Record<string, unknown>): Promise<string> {
    if (!this.noteStore) return "Note store not available.";
    const title = input.title as string;
    const content = input.content as string;
    const filepath = await this.noteStore.write(title, content, "agent");
    return `Note saved: ${filepath}`;
  }

  private toolSearchFiles(input: Record<string, unknown>): string {
    const pattern = input.pattern as string;
    let dir = (input.directory as string) || "~";
    const filePattern = (input.file_pattern as string) || "";

    dir = dir.replace(/^~/, os.homedir());
    if (!fs.existsSync(dir)) return `Directory not found: ${dir}`;

    // Use a simple recursive search (capped for safety)
    const results: string[] = [];
    const maxResults = 20;
    const maxDepth = 4;
    const skipDirs = new Set(["node_modules", ".git", ".next", "dist", "build", "__pycache__", ".venv", "venv"]);

    const textExts = new Set([
      ".txt", ".md", ".ts", ".tsx", ".js", ".jsx", ".py", ".json",
      ".yaml", ".yml", ".toml", ".cfg", ".ini", ".sh", ".zsh",
      ".html", ".css", ".scss", ".sql", ".rs", ".go", ".java",
      ".rb", ".php", ".swift", ".kt", ".c", ".cpp", ".h",
    ]);

    const search = (dir: string, depth: number) => {
      if (depth > maxDepth || results.length >= maxResults) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

      for (const entry of entries) {
        if (results.length >= maxResults) break;
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          if (!entry.name.startsWith(".") && !skipDirs.has(entry.name)) {
            search(full, depth + 1);
          }
          continue;
        }

        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!textExts.has(ext)) continue;
        if (filePattern && !entry.name.match(new RegExp(filePattern.replace(/\*/g, ".*")))) continue;

        try {
          const content = fs.readFileSync(full, "utf-8").slice(0, 50000);
          const lines = content.split("\n");
          const regex = new RegExp(pattern, "gi");
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              const preview = lines.slice(Math.max(0, i - 1), i + 3).join("\n");
              results.push(`[${full}:${i + 1}]\n${preview}`);
              if (results.length >= maxResults) break;
            }
            regex.lastIndex = 0;
          }
        } catch { /* skip unreadable files */ }
      }
    };

    search(dir, 0);
    if (results.length === 0) return `No files matching "${pattern}" found in ${dir}`;
    return results.join("\n\n");
  }

  private toolReadFile(input: Record<string, unknown>): string {
    let filePath = input.path as string;
    const maxLines = (input.max_lines as number) || 200;

    filePath = filePath.replace(/^~/, os.homedir());
    if (!fs.existsSync(filePath)) return `File not found: ${filePath}`;

    try {
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) return `${filePath} is a directory, not a file. Use list_files instead.`;
      if (stat.size > 1_000_000) return `File too large (${Math.round(stat.size / 1024)}KB). Try search_files with a pattern instead.`;

      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      if (lines.length > maxLines) {
        return lines.slice(0, maxLines).join("\n") + `\n\n[... truncated at ${maxLines} lines, ${lines.length} total]`;
      }
      return content;
    } catch (err) {
      return `Error reading file: ${err instanceof Error ? err.message : err}`;
    }
  }

  private toolListFiles(input: Record<string, unknown>): string {
    let dir = (input.path as string) || "~";
    const pattern = input.pattern as string;
    const recursive = input.recursive as boolean;

    dir = dir.replace(/^~/, os.homedir());
    if (!fs.existsSync(dir)) return `Directory not found: ${dir}`;

    const results: string[] = [];
    const maxResults = 50;
    const maxDepth = recursive ? 3 : 0;
    const skipDirs = new Set(["node_modules", ".git", ".next", "dist", "build", "__pycache__"]);

    const list = (d: string, depth: number) => {
      if (depth > maxDepth || results.length >= maxResults) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }

      for (const entry of entries) {
        if (results.length >= maxResults) break;
        if (entry.name.startsWith(".")) continue;

        const full = path.join(d, entry.name);
        const relative = path.relative(dir, full);
        const isDir = entry.isDirectory();

        if (pattern && !entry.name.match(new RegExp(pattern.replace(/\*/g, ".*")))) {
          if (isDir && recursive && !skipDirs.has(entry.name)) list(full, depth + 1);
          continue;
        }

        results.push(`${isDir ? "[dir] " : ""}${relative}`);
        if (isDir && recursive && !skipDirs.has(entry.name)) list(full, depth + 1);
      }
    };

    list(dir, 0);
    if (results.length === 0) return `No files found in ${dir}`;
    return results.join("\n");
  }

  private async toolGrabPanel(input: Record<string, unknown>): Promise<string> {
    const panelId = input.panel_id as string;
    if (!this.panelGrabber) return "Panel grabbing not available.";
    const content = await this.panelGrabber(panelId);
    return content || `Could not grab content from panel: ${panelId}`;
  }

  private toolListPanels(): string {
    if (!this.appConnector) return "App connector not available.";
    const apps = this.appConnector.list();
    if (apps.length === 0) return "No panels configured.";
    return apps.map((a) => `${a.id} — ${a.name} (${a.url})`).join("\n");
  }

  private async toolClickElement(input: Record<string, unknown>): Promise<string> {
    const panelId = input.panel_id as string;
    const text = input.text as string | undefined;
    const selector = input.selector as string | undefined;
    if (!this.panelClicker) return "Click not available.";
    if (!text && !selector) return "Provide either text or selector to click.";
    return this.panelClicker(panelId, text, selector);
  }

  private async toolNavigatePanel(input: Record<string, unknown>): Promise<string> {
    const panelId = input.panel_id as string;
    const url = input.url as string;
    if (!this.panelNavigator) return "Navigation not available.";
    return this.panelNavigator(panelId, url);
  }

  private async toolTypeText(input: Record<string, unknown>): Promise<string> {
    const panelId = input.panel_id as string;
    const text = input.text as string;
    if (!this.panelTyper) return "Typing not available.";
    return this.panelTyper(panelId, text, {
      label: input.label as string | undefined,
      placeholder: input.placeholder as string | undefined,
      selector: input.selector as string | undefined,
      clear: input.clear as boolean | undefined,
    });
  }

  private formatAge(timestamp: number): string {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }

  // ── Chat persistence ─────────────────────────────────

  private saveChat(): void {
    if (!this.chatId || this.history.length === 0) return;
    fs.mkdirSync(CHATS_DIR, { recursive: true });

    // Count user messages for the summary
    const userMsgs = this.history.filter((m) => m.role === "user" && typeof m.content === "string").length;

    const lines = [
      "---",
      `title: ${this.chatTitle}`,
      `created: ${new Date(parseInt(this.chatId, 10)).toISOString()}`,
      `messages: ${userMsgs}`,
      "---",
      "",
    ];

    // Serialize history as JSON block
    lines.push("```json");
    lines.push(JSON.stringify(this.history, null, 2));
    lines.push("```");

    fs.writeFileSync(path.join(CHATS_DIR, `${this.chatId}.md`), lines.join("\n"), "utf-8");
  }

  private parseChatFile(raw: string): { title: string; history: any[] } {
    let title = "";
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const t = fmMatch[1].match(/^title:\s*(.+)$/m);
      if (t) title = t[1].trim();
    }

    // Extract JSON from code block
    const jsonMatch = raw.match(/```json\n([\s\S]*?)\n```/);
    let history: any[] = [];
    if (jsonMatch) {
      try { history = JSON.parse(jsonMatch[1]); } catch {}
    }

    return { title, history };
  }

  /** Compact history — summarize older turns, keep recent ones. */
  private async compact(): Promise<void> {
    if (!this.llmConfig?.apiKey) return;
    if (this.history.length <= 6) return;

    // Split: older messages to summarize, recent to keep
    const keepCount = Math.min(6, Math.floor(this.history.length / 3));
    const oldMessages = this.history.slice(0, -keepCount);
    const recentMessages = this.history.slice(-keepCount);

    // Build a summary of the older conversation
    const summaryParts: string[] = [];
    for (const msg of oldMessages) {
      if (msg.role === "user" && typeof msg.content === "string") {
        summaryParts.push(`User: ${msg.content.slice(0, 200)}`);
      } else if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const text = msg.content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("");
        if (text) summaryParts.push(`Assistant: ${text.slice(0, 200)}`);
        const tools = msg.content
          .filter((b: any) => b.type === "tool_use")
          .map((b: any) => b.name);
        if (tools.length) summaryParts.push(`  [used tools: ${tools.join(", ")}]`);
      }
    }

    try {
      const response = await createCompletion(this.llmConfig, {
        system: "Summarize this conversation history in 2-3 sentences. Focus on what was discussed, what was found, and any actions taken. Be concise.",
        messages: [{ role: "user", content: summaryParts.join("\n") }],
        maxTokens: 300,
      });

      const block = response.content[0];
      const summaryText = block.type === "text" ? block.text : "";

      // Replace history: summary as first user message, then recent messages
      this.history = [
        { role: "user", content: `[Earlier conversation summary: ${summaryText}]` },
        { role: "assistant", content: [{ type: "text", text: "Understood, I have the context from our earlier conversation." }] },
        ...recentMessages,
      ];
    } catch {
      // If compaction fails, just do a hard trim
      this.history = recentMessages;
    }
  }

  /** Get current chat ID (for renderer to track). */
  getChatId(): string | null { return this.chatId; }
  getChatTitle(): string { return this.chatTitle; }
}
