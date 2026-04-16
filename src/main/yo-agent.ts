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
import type { ContextStore, ChunkResult } from "./context-store";
import type { AppConnector } from "./app-connector";

export interface YoAgentCallbacks {
  onText: (delta: string) => void;
  onToolUse: (name: string) => void;
  onDone: (fullText: string) => void;
  onError: (error: string) => void;
}

const SYSTEM = `You are yo, a retrieval agent. Your response streams into the user's text input field. Plain text only, no markdown.

CRITICAL: NEVER ask the user for clarification. NEVER ask "what do you mean" or "can you be more specific." ALWAYS call search_memory immediately with your best guess at keywords. Even vague queries — just search. Extract any keywords you can and search.

WORKFLOW:
1. User sends a message → you IMMEDIATELY call search_memory with relevant keywords
2. Read the results → respond with the matching content
3. If nothing found, try different keywords with search_memory, or try search_files
4. Only after searching and finding nothing: "nothing found — try different words?"

RESPONSE RULES:
- Return the ACTUAL content from search results. Not a summary. The real text.
- NEVER say "I found...", "Here's...", "Based on...", "Let me search..."
- If one thing clearly matches: return its content verbatim.
- If multiple things match: list them briefly so the user can pick. "found two: (1) reddit post about pricing (2) reddit post about launch — which one?"
- When the user picks: return that content verbatim.
- If the user asks to combine or summarize: do it.
- Plain text only. No ** no ## no - bullets. This goes into a text input.
- Use conversation history for context. If the user says "the earlier one" or "that one", look at what you previously found and returned.`;

const TOOLS = [
  {
    name: "search_memory",
    description: "Search the ambient context store (captured from all workspace panels over time). Uses semantic vector search. Returns matching chunks with source panel and timestamp.",
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
];

export class YoAgent {
  private history: any[] = [];
  private llmConfig: LLMConfig | null = null;
  private contextStore: ContextStore | null = null;
  private appConnector: AppConnector | null = null;
  private panelGrabber: ((panelId: string) => Promise<string | null>) | null = null;

  setLLMConfig(config: LLMConfig): void { this.llmConfig = config; }
  setContextStore(store: ContextStore): void { this.contextStore = store; }
  setAppConnector(ac: AppConnector): void { this.appConnector = ac; }
  setPanelGrabber(fn: (panelId: string) => Promise<string | null>): void { this.panelGrabber = fn; }

  /** Start a new conversation (clears history). */
  clear(): void {
    this.history = [];
  }

  /** Send a message and stream the response. Runs the full tool loop. */
  async send(message: string, cb: YoAgentCallbacks): Promise<void> {
    if (!this.llmConfig?.apiKey) {
      cb.onError("No API key configured. Set your LLM provider in Settings.");
      return;
    }

    this.history.push({ role: "user", content: message });

    // Cap history at 20 messages (sliding window)
    if (this.history.length > 20) {
      this.history = this.history.slice(-20);
    }

    try {
      await this.agentLoop(cb);
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
        case "search_memory": return await this.toolSearchMemory(input);
        case "search_files": return this.toolSearchFiles(input);
        case "read_file": return this.toolReadFile(input);
        case "list_files": return this.toolListFiles(input);
        case "grab_panel": return await this.toolGrabPanel(input);
        case "list_panels": return this.toolListPanels();
        default: return `Unknown tool: ${name}`;
      }
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  }

  private async toolSearchMemory(input: Record<string, unknown>): Promise<string> {
    if (!this.contextStore) return "Context store not available.";
    const query = input.query as string;
    const limit = (input.limit as number) || 10;

    const hits = await this.contextStore.search(query, limit);
    if (hits.length === 0) return "No matching context found in memory.";

    // Group by panel and return with metadata
    const panelHits = new Map<string, ChunkResult[]>();
    for (const h of hits) {
      if (!panelHits.has(h.panel_id)) panelHits.set(h.panel_id, []);
      panelHits.get(h.panel_id)!.push(h);
    }

    const sections: string[] = [];
    for (const [panelId, chunks] of panelHits) {
      // Get full panel content for the most recent capture
      const allChunks = this.contextStore.getPanelContent(panelId);
      if (allChunks.length === 0) continue;
      const age = this.formatAge(allChunks[0].timestamp);
      const title = allChunks[0].title || panelId;
      const fullContent = allChunks.map((c) => c.content).join("\n");
      sections.push(`[${panelId} | ${title} | ${age}]\n${fullContent}`);
    }

    return sections.join("\n\n---\n\n") || "No matching context found.";
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

  private formatAge(timestamp: number): string {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }
}
