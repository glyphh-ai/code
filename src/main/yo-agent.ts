/**
 * YoAgent — orchestrator with specialist sub-agents.
 *
 * Direct tools: search_captures, get_context, format, save_memory,
 *   search_notes, read_file, list_files, run_command, start_council.
 * Delegation: delegate_navigate (panel interaction), delegate_layout (workspace arrangement).
 * Streams responses to the UI.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { LLMConfig, createStream, createCompletion } from "./llm-config";
import { usageTracker } from "./usage-tracker";
import { promptLog } from "./prompt-log";
import type { MemoryStore } from "./memory-store";
import type { CaptureStore } from "./capture-store";
import type { SessionCache } from "./session-cache";
import type { SkillEngine } from "./skill-engine";
import type { NoteStore } from "./note-store";
import { gate, getAgentMode } from "./action-gate";
import type { AgentMode } from "./action-gate";
import type { Council, CouncilConfig } from "./council";
import { NavigatorAgent } from "./agents/navigator-agent";
import { LayoutAgent } from "./agents/layout-agent";
import type { SubAgentContext } from "./agents/types";

export type ApprovalCallback = (toolName: string, input: Record<string, unknown>) => Promise<boolean>;

export interface YoAgentCallbacks {
  onText: (delta: string) => void;
  onToolUse: (id: string, name: string, input: unknown) => void;
  onToolResult?: (id: string, detail: string) => void;
  onDone: (fullText: string) => void;
  onError: (error: string) => void;
}

const SYSTEM_BASE = `You are yo, a capture search and format assistant with specialist sub-agents.

WORKFLOW:
1. Check get_context first — the answer may be in the current session
2. Use search_captures with descriptive natural language queries
3. Use search_notes / read_file / list_files for saved notes and local files
4. Evaluate confidence — scores above 0.7 are strong, 0.4-0.7 partial
5. If ambiguous or low-confidence, ask the user to clarify before proceeding
6. Use format with a named skill to present results cleanly

DELEGATION:
- delegate_navigate: panel interaction specialist — scan, click, type, navigate, open panels. Use for ANY visual interaction with app panels (Gmail, Slack, Claude, etc). The navigator has its own tool loop and will chain scan→click→type as needed.
- delegate_layout: workspace layout specialist — split views, grids, tabs, saved layouts. Use when the user wants to arrange panels on screen.
- Delegations run in parallel when possible. Each sub-agent runs on a cheap model to minimize cost.
- NEVER open_panel or delegate_navigate for apps that have MCP tools — use MCP tools for data access, delegate_navigate for visual-only interaction.

RULES:
- search_captures is vector search — use descriptive phrases, not keywords
- search_notes is keyword search — use specific terms
- read_file can read any file under ~/ but defaults to ~/yo/ for relative paths
- Be concise. Return the actual content, not descriptions of it.
- Use save_memory for user preferences and patterns you learn.
- Use start_council when the user needs multiple AI perspectives — debates, brainstorming, comparing approaches. Council is zero-cost orchestration: each model runs on the user's own API key, responses are SmartGrabbed and indexed. After council completes, synthesize the captured results.`;

const TOOLS = [
  {
    name: "search_captures",
    description: "Vector search across all captured content (.sup captures). Returns ranked results with confidence scores. Use descriptive natural language queries for best results.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string" as const, description: "Descriptive search query, e.g. 'email about the product launch' or 'conversation where we discussed pricing'" },
        limit: { type: "number" as const, description: "Max results to return (default: 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_context",
    description: "Read current session context — in-memory .sup captures from this session. Check this first before searching the full capture store.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "format",
    description: "Apply a named skill to format content. If no skill specified, lists available skills. Skills are reusable prompts that transform content (summarize, extract action items, etc.).",
    input_schema: {
      type: "object" as const,
      properties: {
        content: { type: "string" as const, description: "The content to format" },
        skill: { type: "string" as const, description: "Skill name to apply. Omit to list available skills." },
      },
    },
  },
  {
    name: "save_memory",
    description: "Save something you learned about the user to persistent memory. Use for preferences, workflow patterns, facts about their work. Don't save trivial or one-off things.",
    input_schema: {
      type: "object" as const,
      properties: {
        content: { type: "string" as const, description: "What to remember, e.g. 'User prefers Gmail over Outlook'" },
        category: {
          type: "string" as const,
          enum: ["preference", "fact", "workflow", "app_pattern", "context"],
          description: "Category of memory",
        },
      },
      required: ["content", "category"],
    },
  },
  {
    name: "search_notes",
    description: "Search saved notes in ~/yo/notes/. Notes are .md files created by captures, agent, or the user. Returns matching notes ranked by relevance.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string" as const, description: "Search query — keywords to match against note titles and content" },
        limit: { type: "number" as const, description: "Max results (default: 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "read_file",
    description: "Read a file from the local filesystem. Returns the file content. Use for reading notes, configs, or any accessible file.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string" as const, description: "Absolute file path, or relative to ~/yo/ (e.g. 'notes/my-note.md')" },
      },
      required: ["path"],
    },
  },
  {
    name: "list_files",
    description: "List files in a directory. Defaults to ~/yo/notes/ if no path given. Returns filenames with size and modified date.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string" as const, description: "Directory path. Defaults to ~/yo/notes/" },
        pattern: { type: "string" as const, description: "Glob filter, e.g. '*.md' (default: all files)" },
      },
    },
  },
  {
    name: "run_command",
    description: "Run a read-only shell command. Allowed commands: git (log, diff, status, show, branch), ls, cat, head, tail, wc, find, which, echo. Use this for checking git history, file contents, or system info. Max 30 second timeout.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: { type: "string" as const, description: "The shell command to run, e.g. 'git log --oneline -5' or 'ls -la ~/projects'" },
        cwd: { type: "string" as const, description: "Working directory (defaults to ~/)" },
      },
      required: ["command"],
    },
  },
  {
    name: "start_council",
    description: "Convene a multi-model council. Opens AI chat panels (claude, chatgpt, gemini, grok, etc.), fans out the same prompt to all participants, captures their responses each round, and cross-pollinates between rounds. All orchestration is deterministic — no LLM tokens spent on coordination. Use this when the user would benefit from multiple AI perspectives on a topic. After council completes, use search_captures to retrieve and synthesize the results.",
    input_schema: {
      type: "object" as const,
      properties: {
        participants: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Panel IDs of AI models to include, e.g. [\"claude\", \"chatgpt\", \"gemini\", \"grok\"]",
        },
        prompt: { type: "string" as const, description: "The topic or question to debate" },
        rounds: { type: "number" as const, description: "Number of debate rounds (default: 2). Round 1 is independent, subsequent rounds include other participants' responses." },
      },
      required: ["participants", "prompt"],
    },
  },
  {
    name: "delegate_navigate",
    description: "Delegate to the navigation specialist. Handles all panel interaction: scanning DOM elements, clicking buttons, typing text, navigating URLs, opening panels, running mapped app commands, taking screenshots. The navigator has its own tool loop — give it a high-level instruction and it will chain actions as needed.",
    input_schema: {
      type: "object" as const,
      properties: {
        instruction: { type: "string" as const, description: "What to do, e.g. 'Click the Compose button in Gmail and type a reply to the latest email from John'" },
      },
      required: ["instruction"],
    },
  },
  {
    name: "delegate_layout",
    description: "Delegate to the layout specialist. Handles workspace arrangement: split views, grid layouts, tab management, saved layouts, zoom. Give it a high-level instruction about how to arrange panels.",
    input_schema: {
      type: "object" as const,
      properties: {
        instruction: { type: "string" as const, description: "What to arrange, e.g. 'Put Claude and Gemini side by side' or 'Set up a 2x2 grid with all AI panels'" },
      },
      required: ["instruction"],
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
  private maxMessages = 40;
  private llmConfig: LLMConfig | null = null;
  private memoryStore: MemoryStore | null = null;
  private captureStore: CaptureStore | null = null;
  private sessionCache: SessionCache | null = null;
  private skillEngine: SkillEngine | null = null;
  private noteStore: NoteStore | null = null;
  private aborted = false;
  private activeMemories: string = "";
  private _mode: AgentMode = getAgentMode();
  private _approvalCallback: ApprovalCallback | null = null;
  private council: Council | null = null;
  private _sendInputTokens = 0;
  private _sendOutputTokens = 0;
  private _sendToolsUsed: string[] = [];

  // Sub-agents
  private navigator = new NavigatorAgent();
  private layout = new LayoutAgent();
  private _layoutStateGetter: (() => { cols: number; rows: number; cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }> } | null) | null = null;

  // ── Setters ────────────────────────────────────────────

  setLLMConfig(config: LLMConfig): void {
    this.llmConfig = config;
    this.navigator.setLLMConfig(config);
    this.layout.setLLMConfig(config);
  }
  setMemoryStore(store: MemoryStore): void { this.memoryStore = store; }
  setCaptureStore(store: CaptureStore): void { this.captureStore = store; }
  setSessionCache(cache: SessionCache): void { this.sessionCache = cache; }
  setSkillEngine(engine: SkillEngine): void { this.skillEngine = engine; }
  setNoteStore(store: NoteStore): void { this.noteStore = store; }
  setMaxMessages(n: number): void { this.maxMessages = n; }
  getMode(): AgentMode { return this._mode; }
  setMode(mode: AgentMode): void {
    this._mode = mode;
    this.navigator.setMode(mode);
    this.layout.setMode(mode);
  }
  setApprovalCallback(cb: ApprovalCallback | null): void {
    this._approvalCallback = cb;
    this.navigator.setApprovalCallback(cb);
    this.layout.setApprovalCallback(cb);
  }
  setCouncil(council: Council): void { this.council = council; }

  // Sub-agent passthrough setters
  setPanelLister(fn: () => string): void {
    this.navigator.setPanelLister(fn);
    this.layout.setPanelLister(fn);
  }
  setPanelGrabber(fn: (panelId: string) => Promise<string | null>): void {
    this.navigator.setPanelGrabber(fn);
  }
  setPanelScanner(fn: (panelId: string) => Promise<string | null>): void {
    this.navigator.setPanelScanner(fn);
  }
  setPanelClicker(fn: (panelId: string, text?: string, selector?: string) => Promise<string>): void {
    this.navigator.setPanelClicker(fn);
  }
  setPanelNavigator(fn: (panelId: string, url: string) => Promise<string>): void {
    this.navigator.setPanelNavigator(fn);
  }
  setPanelTyper(fn: (panelId: string, text: string, opts: { label?: string; placeholder?: string; selector?: string; clear?: boolean; submit?: boolean }) => Promise<string>): void {
    this.navigator.setPanelTyper(fn);
  }
  setPanelOpener(fn: (url: string, panelId?: string) => Promise<string>): void {
    this.navigator.setPanelOpener(fn);
  }
  setBackgroundOpener(fn: (url: string, panelId?: string) => Promise<string>): void {
    this.navigator.setBackgroundOpener(fn);
  }
  setPanelCommandRunner(fn: (panelId: string, command: string, value?: string) => Promise<string>): void {
    this.navigator.setCommandRunner(fn);
  }
  setPanelScreenshotter(fn: (panelId: string) => Promise<string | null>): void {
    this.navigator.setPanelScreenshotter(fn);
  }
  setPanelRefresher(fn: (panelId?: string) => Promise<string>): void {
    this.navigator.setPanelRefresher(fn);
  }
  setTabManager(tm: { list: () => Array<{ id: string; title: string; url?: string }>; switch: (id: string) => void; close: (id: string) => void; create: () => string }): void {
    this.navigator.setTabManager(tm);
    this.layout.setTabManager(tm);
  }
  setCommandRunner(fn: (cmd: string) => Promise<string>): void {
    this.layout.setCommandRunner(fn);
  }
  setLayoutCallbacks(cbs: {
    list: () => Array<{ name: string; cols: number; rows: number; cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }> }>;
    save: (name: string, panels: string) => boolean;
    delete: (name: string) => boolean;
  }): void {
    this.layout.setLayoutCallbacks(cbs);
  }
  setLayoutStateGetter(fn: typeof this._layoutStateGetter): void { this._layoutStateGetter = fn; }
  setSubAgentModel(model: string | null): void {
    this.navigator.setModelOverride(model);
    this.layout.setModelOverride(model);
  }

  abort(): void {
    this.aborted = true;
    this.navigator.abort();
    this.layout.abort();
  }

  // ── Chat management ────────────────────────────────────

  clear(): void {
    this.saveChat();
    this.history = [];
    this.chatId = null;
    this.chatTitle = "";
  }

  loadChat(id: string): Array<{ role: string; text: string; tools?: Array<{ name: string; input?: unknown }> }> | null {
    const filepath = path.join(CHATS_DIR, `${id}.md`);
    if (!fs.existsSync(filepath)) return null;
    try {
      const raw = fs.readFileSync(filepath, "utf-8");
      const parsed = this.parseChatFile(raw);
      this.chatId = id;
      this.chatTitle = parsed.title;
      this.history = parsed.history;

      const display: Array<{ role: string; text: string; tools?: Array<{ name: string; input?: unknown }> }> = [];
      for (const msg of parsed.history) {
        if (msg.role === "user" && typeof msg.content === "string") {
          display.push({ role: "user", text: msg.content });
        } else if (msg.role === "assistant" && Array.isArray(msg.content)) {
          const toolUses = msg.content
            .filter((b: any) => b.type === "tool_use")
            .map((b: any) => ({ name: b.name as string, input: b.input }));
          const text = msg.content
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("");
          if (text || toolUses.length > 0) {
            display.push({
              role: "assistant",
              text: text || "",
              ...(toolUses.length > 0 ? { tools: toolUses } : {}),
            });
          }
        }
      }
      return display;
    } catch {
      return null;
    }
  }

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

  deleteChat(id: string): boolean {
    try {
      fs.unlinkSync(path.join(CHATS_DIR, `${id}.md`));
      return true;
    } catch { return false; }
  }

  // ── Send (public API) ──────────────────────────────────

  async send(message: string, cb: YoAgentCallbacks): Promise<void> {
    if (!this.llmConfig?.apiKey) {
      cb.onError("No API key configured. Set your LLM provider in Settings.");
      return;
    }

    this.aborted = false;

    const lastMsg = this.history[this.history.length - 1];
    if (lastMsg?.role === "user" && Array.isArray(lastMsg.content)) {
      lastMsg.content.push({ type: "text", text: message });
    } else {
      this.history.push({ role: "user", content: message });
    }

    if (!this.chatTitle) {
      this.chatTitle = message.slice(0, 80).replace(/\n/g, " ").trim();
    }
    if (!this.chatId) {
      this.chatId = `${Date.now()}`;
    }

    if (this.history.length > this.maxMessages) {
      await this.compact();
    }

    await this.recallMemories(message);

    this._sendInputTokens = 0;
    this._sendOutputTokens = 0;
    this._sendToolsUsed = [];
    const startTs = Date.now();

    try {
      await this.agentLoop(cb);
      this.saveChat();
      this.extractMemories().catch(() => {});

      const endTs = Date.now();
      const lastAssistant = [...this.history].reverse().find(m => m.role === "assistant");
      let responseText = "";
      if (lastAssistant) {
        const blocks = Array.isArray(lastAssistant.content) ? lastAssistant.content : [];
        responseText = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
      }
      promptLog.record({
        id: `${startTs}-${Math.random().toString(36).slice(2, 8)}`,
        startTs,
        endTs,
        prompt: message.slice(0, 2000),
        response: responseText.slice(0, 2000),
        inputTokens: this._sendInputTokens,
        outputTokens: this._sendOutputTokens,
        model: this.llmConfig?.model || "unknown",
        provider: this.llmConfig?.provider || "unknown",
        mode: this._mode,
        toolsUsed: [...new Set(this._sendToolsUsed)],
      });
    } catch (err) {
      cb.onError(err instanceof Error ? err.message : String(err));
    }
  }

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

  getChatId(): string | null { return this.chatId; }
  getChatTitle(): string { return this.chatTitle; }

  // ── System prompt builder ──────────────────────────────

  private buildSystemPrompt(): string {
    let prompt = SYSTEM_BASE;

    // Capture stats
    const captureCount = this.captureStore?.count ?? 0;
    if (captureCount > 0) {
      prompt += `\n\nCAPTURE STORE: ${captureCount} entries indexed.`;
    } else {
      prompt += `\n\nCAPTURE STORE: empty — no captures yet. Use get_context to check session.`;
    }

    // Available skills
    if (this.skillEngine) {
      const skills = this.skillEngine.listSkills();
      if (skills.length > 0) {
        prompt += `\n\nAVAILABLE SKILLS:\n${skills.map((s) => `- ${s}`).join("\n")}`;
      }
    }

    if (this.activeMemories) {
      prompt += `\n\nYOUR MEMORIES:\n${this.activeMemories}`;
    }

    if (this._mode === "plan") {
      prompt += `\n\nMODE: PLAN\nYou are in plan mode. DO NOT call any tools. Instead, outline your plan as a concise numbered list.`;
    }

    return prompt;
  }

  // ── Agent loop ─────────────────────────────────────────

  private static readonly MAX_TOOL_ITERATIONS = 20;

  private async agentLoop(cb: YoAgentCallbacks, iteration = 0): Promise<void> {
    this.sanitizeHistory();

    let fullText = "";
    const systemPrompt = this.buildSystemPrompt();

    const response = await createStream(
      this.llmConfig!,
      {
        system: systemPrompt,
        messages: this.history,
        tools: TOOLS,
        maxTokens: 4096,
      },
      (delta) => {
        fullText += delta;
        cb.onText(delta);
      },
    );

    if (response.usage) {
      usageTracker.record("orchestrator", response.usage);
      this._sendInputTokens += response.usage.inputTokens;
      this._sendOutputTokens += response.usage.outputTokens;
    }

    this.history.push({ role: "assistant", content: response.content });
    if (this.aborted) { this.patchDanglingToolUse(); return; }

    const toolBlocks = response.content.filter((b: any) => b.type === "tool_use");
    if (toolBlocks.length > 0 && response.stopReason === "tool_use") {
      if (iteration >= YoAgent.MAX_TOOL_ITERATIONS) {
        const results = toolBlocks.map((b: any) => ({
          type: "tool_result",
          tool_use_id: b.id,
          content: "[tool limit reached — respond with what you have]",
        }));
        this.history.push({ role: "user", content: results });
        await this.agentLoop(cb, iteration + 1);
        return;
      }

      // Partition into delegation and direct tools
      const delegateBlocks = toolBlocks.filter((b: any) => b.name.startsWith("delegate_"));
      const directBlocks = toolBlocks.filter((b: any) => !b.name.startsWith("delegate_"));

      const results: any[] = [];

      // Emit all tool rows up front so the UI renders them in order
      for (const block of toolBlocks) {
        cb.onToolUse(block.id, block.name, block.input);
      }

      // Run all delegation calls in parallel
      if (delegateBlocks.length > 0 && !this.aborted) {
        const context = this.buildSubAgentContext();
        const delegatePromises = delegateBlocks.map(async (block: any) => {
          if (this.aborted) return { type: "tool_result", tool_use_id: block.id, content: "[interrupted by user]" };
          this._sendToolsUsed.push(block.name);

          const decision = gate(block.name, this._mode);
          if (decision === "skip") {
            cb.onToolResult?.(block.id, "[skipped — plan mode]");
            return { type: "tool_result", tool_use_id: block.id, content: "[skipped — plan mode]" };
          }
          if (decision === "needs_approval" && this._approvalCallback) {
            const approved = await this._approvalCallback(block.name, block.input as Record<string, unknown>);
            if (!approved) {
              cb.onToolResult?.(block.id, "[blocked by user]");
              return { type: "tool_result", tool_use_id: block.id, content: "[blocked by user]" };
            }
          }

          const result = await this.execDelegation(block.name, block.input as Record<string, unknown>, context);
          cb.onToolResult?.(block.id, result.slice(0, 500));
          return { type: "tool_result", tool_use_id: block.id, content: result };
        });
        const delegateResults = await Promise.all(delegatePromises);
        results.push(...delegateResults);
      }

      // Run direct tools sequentially
      for (const block of directBlocks) {
        if (this.aborted) break;
        this._sendToolsUsed.push(block.name);

        const decision = gate(block.name, this._mode);
        if (decision === "skip") {
          cb.onToolResult?.(block.id, "[skipped — plan mode]");
          results.push({ type: "tool_result", tool_use_id: block.id, content: "[skipped — plan mode]" });
          continue;
        }
        if (decision === "needs_approval" && this._approvalCallback) {
          const approved = await this._approvalCallback(block.name, block.input as Record<string, unknown>);
          if (!approved) {
            cb.onToolResult?.(block.id, "[blocked by user]");
            results.push({ type: "tool_result", tool_use_id: block.id, content: "[blocked by user]" });
            continue;
          }
        }

        const result = await this.execDirectTool(block.name, block.input as Record<string, unknown>);
        cb.onToolResult?.(block.id, result.slice(0, 500));
        results.push({ type: "tool_result", tool_use_id: block.id, content: result });
      }

      if (this.aborted) {
        if (results.length > 0) this.history.push({ role: "user", content: results });
        this.patchDanglingToolUse();
        return;
      }

      this.history.push({ role: "user", content: results });
      fullText = "";
      await this.agentLoop(cb, iteration + 1);
    } else {
      cb.onDone(fullText);
    }
  }

  // ── Sub-agent context + delegation ─────────────────────

  private buildSubAgentContext(): SubAgentContext {
    const exchanges: string[] = [];
    for (let i = Math.max(0, this.history.length - 8); i < this.history.length; i++) {
      const msg = this.history[i];
      if (msg.role === "user" && typeof msg.content === "string") {
        exchanges.push(`User: ${msg.content.slice(0, 150)}`);
      } else if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const text = msg.content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("");
        if (text) exchanges.push(`Assistant: ${text.slice(0, 150)}`);
      }
    }

    const userMessage = typeof this.history[this.history.length - 2]?.content === "string"
      ? this.history[this.history.length - 2].content
      : exchanges[exchanges.length - 1] || "";

    return {
      conversationSummary: exchanges.length > 1 ? exchanges.slice(0, -1).join("\n") : undefined,
      userMessage,
    };
  }

  private async execDelegation(
    name: string,
    input: Record<string, unknown>,
    context: SubAgentContext,
  ): Promise<string> {
    const instruction = input.instruction as string;
    if (!instruction) return "No instruction provided.";

    try {
      let result;
      switch (name) {
        case "delegate_navigate": {
          const panelList = this.navigator.listPanels();
          const enriched = panelList
            ? `${instruction}\n\nAVAILABLE APP PANELS (use scan_panel, click_element, type_text, run_command — grab_panel only as last resort):\n${panelList}`
            : instruction;
          result = await this.navigator.execute(enriched, context);
          break;
        }
        case "delegate_layout":
          result = await this.layout.execute(instruction, context);
          break;
        default:
          return `Unknown delegation: ${name}`;
      }
      return result.summary;
    } catch (err) {
      return `Delegation error: ${err instanceof Error ? err.message : err}`;
    }
  }

  // ── Tool execution ─────────────────────────────────────

  private async execDirectTool(name: string, input: Record<string, unknown>): Promise<string> {
    try {
      switch (name) {
        case "search_captures": return await this.toolSearchCaptures(input);
        case "get_context": return this.toolGetContext();
        case "format": return await this.toolFormat(input);
        case "save_memory": return await this.toolSaveMemory(input);
        case "search_notes": return await this.toolSearchNotes(input);
        case "read_file": return this.toolReadFile(input);
        case "list_files": return this.toolListFiles(input);
        case "run_command": return this.toolRunCommand(input);
        case "start_council": return await this.toolStartCouncil(input);
        default: return `Unknown tool: ${name}`;
      }
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  }

  private async toolSearchCaptures(input: Record<string, unknown>): Promise<string> {
    const query = input.query as string;
    const limit = (input.limit as number) || 10;
    if (!query) return "No query provided.";
    if (!this.captureStore) return "Capture store not available.";

    const results = await this.captureStore.search(query, limit);
    if (results.length === 0) return "No matching captures found.";

    return results
      .map((r, i) => {
        const age = this.formatAge(r.meta.created);
        return `[${i + 1}] score: ${r.score.toFixed(2)} | source: ${r.meta.source} | ${age}\n${r.content.slice(0, 800)}`;
      })
      .join("\n\n---\n\n");
  }

  private toolGetContext(): string {
    if (!this.sessionCache) return "Session cache not available.";
    const content = this.sessionCache.get();
    if (!content) return "No captures in this session yet.";
    return content;
  }

  private async toolFormat(input: Record<string, unknown>): Promise<string> {
    const content = input.content as string;
    const skill = input.skill as string;

    if (!this.skillEngine) return "Skill engine not available.";

    if (!skill) {
      const skills = this.skillEngine.listSkills();
      if (skills.length === 0) return "No skills available. Create skills in Settings.";
      return `Available skills:\n${skills.map((s) => `- ${s}`).join("\n")}\n\nCall format again with a skill name.`;
    }

    if (!content) return "No content provided to format.";
    return this.skillEngine.process(content, skill);
  }

  private async toolSaveMemory(input: Record<string, unknown>): Promise<string> {
    const content = input.content as string;
    const category = input.category as "preference" | "fact" | "workflow" | "app_pattern" | "context";
    if (!content) return "No content provided.";
    if (!this.memoryStore) return "Memory not available.";
    const id = await this.memoryStore.save(content, category || "context");
    return `Memory saved (${id}).`;
  }

  private async toolSearchNotes(input: Record<string, unknown>): Promise<string> {
    const query = input.query as string;
    const limit = (input.limit as number) || 10;
    if (!query) return "No query provided.";
    if (!this.noteStore) return "Note store not available.";

    const results = await this.noteStore.search(query, limit);
    if (results.length === 0) return "No matching notes found.";

    return results
      .map((r, i) => `[${i + 1}] ${r.title} (${r.file}) — rank: ${r.rank.toFixed(2)}\n${r.content.slice(0, 600)}`)
      .join("\n\n---\n\n");
  }

  private toolReadFile(input: Record<string, unknown>): string {
    let filePath = input.path as string;
    if (!filePath) return "No path provided.";

    if (!path.isAbsolute(filePath)) {
      filePath = path.join(os.homedir(), "yo", filePath);
    }

    const resolved = path.resolve(filePath);
    const yoDir = path.join(os.homedir(), "yo");
    const homeDir = os.homedir();
    if (!resolved.startsWith(yoDir) && !resolved.startsWith(homeDir)) {
      return "Access denied — can only read files under ~/";
    }

    if (!fs.existsSync(resolved)) return `File not found: ${resolved}`;

    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) return `${resolved} is a directory. Use list_files instead.`;
    if (stat.size > 500_000) return `File too large (${(stat.size / 1024).toFixed(0)} KB). Max 500 KB.`;

    return fs.readFileSync(resolved, "utf-8");
  }

  private toolListFiles(input: Record<string, unknown>): string {
    let dirPath = (input.path as string) || path.join(os.homedir(), "yo", "notes");
    const pattern = (input.pattern as string) || "";

    if (!path.isAbsolute(dirPath)) {
      dirPath = path.join(os.homedir(), "yo", dirPath);
    }

    const resolved = path.resolve(dirPath);
    if (!resolved.startsWith(os.homedir())) {
      return "Access denied — can only list files under ~/";
    }

    if (!fs.existsSync(resolved)) return `Directory not found: ${resolved}`;
    if (!fs.statSync(resolved).isDirectory()) return `Not a directory: ${resolved}`;

    let entries = fs.readdirSync(resolved);
    if (pattern) {
      const re = new RegExp("^" + pattern.replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
      entries = entries.filter((e) => re.test(e));
    }

    if (entries.length === 0) return "No files found.";

    const lines = entries.slice(0, 100).map((name) => {
      try {
        const stat = fs.statSync(path.join(resolved, name));
        const size = stat.isDirectory() ? "dir" : `${(stat.size / 1024).toFixed(1)}K`;
        const modified = new Date(stat.mtimeMs).toISOString().slice(0, 16).replace("T", " ");
        return `${name.padEnd(40)} ${size.padStart(8)}  ${modified}`;
      } catch {
        return name;
      }
    });

    if (entries.length > 100) lines.push(`... and ${entries.length - 100} more`);
    return lines.join("\n");
  }

  private toolRunCommand(input: Record<string, unknown>): string {
    const command = input.command as string;
    if (!command) return "No command provided.";

    // Allowlist of safe read-only commands
    const firstWord = command.trim().split(/\s+/)[0];
    const allowed = new Set(["git", "ls", "cat", "head", "tail", "wc", "find", "which", "echo", "pwd", "date"]);
    if (!firstWord || !allowed.has(firstWord)) {
      return `Command not allowed: ${firstWord}. Allowed: ${[...allowed].join(", ")}`;
    }

    // Block destructive git subcommands
    if (firstWord === "git") {
      const subCmd = command.trim().split(/\s+/)[1];
      const destructive = new Set(["push", "reset", "clean", "checkout", "rebase", "merge", "commit", "stash", "rm", "mv"]);
      if (subCmd && destructive.has(subCmd)) {
        return `Destructive git command not allowed: git ${subCmd}`;
      }
    }

    let cwd = (input.cwd as string) || os.homedir();
    if (!path.isAbsolute(cwd)) {
      cwd = path.join(os.homedir(), cwd);
    }

    try {
      const output = execSync(command, {
        cwd,
        timeout: 30_000,
        maxBuffer: 512 * 1024,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return output.slice(0, 10_000) || "(no output)";
    } catch (err: any) {
      return `Command failed: ${err.stderr || err.message || err}`.slice(0, 2000);
    }
  }

  private async toolStartCouncil(input: Record<string, unknown>): Promise<string> {
    const participants = input.participants as string[];
    const prompt = input.prompt as string;
    const rounds = (input.rounds as number) || 2;

    if (!participants || participants.length < 2) return "Council requires at least 2 participants.";
    if (!prompt) return "No prompt provided.";
    if (!this.council) return "Council not available.";

    const result = await this.council.start(
      { participants, prompt, rounds },
      (msg) => console.log("[council]", msg),
    );

    if (result.status === "error") return "Council failed to start.";
    if (result.status === "cancelled") return "Council was cancelled.";

    const lines = [
      `Council complete: ${result.rounds} round(s), ${result.participants.length} participants, ${result.totalCaptures} responses captured.`,
      "",
      "Participants: " + result.participants.join(", "),
    ];

    for (const [participant, resps] of result.responses) {
      if (resps.length > 0) {
        const lastResp = resps[resps.length - 1];
        lines.push(`\n--- ${participant} (final response) ---`);
        lines.push(lastResp.slice(0, 3000));
      }
    }

    lines.push("\nAll responses are indexed in captures. Use search_captures with 'council' to retrieve specific responses.");
    return lines.join("\n");
  }

  private formatAge(timestamp: number): string {
    const mins = Math.floor((Date.now() - timestamp) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  // ── Memory loop ────────────────────────────────────────

  private async recallMemories(message: string): Promise<void> {
    if (!this.memoryStore || this.memoryStore.count === 0) {
      this.activeMemories = "";
      return;
    }
    try {
      const memories = await this.memoryStore.search(message, 5);
      if (memories.length === 0) {
        this.activeMemories = "";
        return;
      }
      this.activeMemories = memories
        .map((m) => `- [${m.category}] ${m.content}`)
        .join("\n");
    } catch {
      this.activeMemories = "";
    }
  }

  private async extractMemories(): Promise<void> {
    if (!this.memoryStore || !this.llmConfig?.apiKey) return;

    const lastUser = this.getLastUserMessage();
    const lastAssistant = this.getLastResponse();
    if (!lastUser || !lastAssistant) return;
    if (lastAssistant.length < 50 && lastUser.length < 30) return;

    try {
      const response = await createCompletion(this.llmConfig, {
        system: `You extract useful memories from conversations. A memory is something worth remembering about the user for future conversations: their preferences, how they work, what apps they use, facts about their projects, patterns in their behaviour.

Rules:
- Only extract genuinely useful, reusable information
- Skip trivial or one-off things (greetings, simple commands)
- Skip things that are just about the current task with no future value
- Each memory should be a single clear sentence
- Return a JSON array of objects: [{"content": "...", "category": "preference|fact|workflow|app_pattern|context"}]
- Return [] if nothing worth remembering`,
        messages: [{
          role: "user",
          content: `User said: ${lastUser.slice(0, 500)}\n\nAssistant responded: ${lastAssistant.slice(0, 1000)}\n\nExtract memories (JSON array):`,
        }],
        maxTokens: 500,
        model: this.getCheapModel(),
      });

      const text = response.content[0]?.type === "text" ? response.content[0].text : "";
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return;

      const memories: Array<{ content: string; category: string }> = JSON.parse(jsonMatch[0]);
      for (const mem of memories) {
        if (mem.content && mem.content.length > 10) {
          await this.memoryStore.save(
            mem.content,
            (mem.category as any) || "context",
          );
        }
      }
    } catch {
      // Non-fatal
    }
  }

  private getLastUserMessage(): string {
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].role === "user" && typeof this.history[i].content === "string") {
        return this.history[i].content;
      }
    }
    return "";
  }

  private getCheapModel(): string {
    if (!this.llmConfig) return "";
    const cheap: Record<string, string> = {
      anthropic: "claude-haiku-4-5-20251001",
      openai: "gpt-4.1-mini",
      google: "gemini-2.0-flash",
      xai: "grok-3-mini-fast",
      deepseek: "deepseek-chat",
    };
    return cheap[this.llmConfig.provider] || this.llmConfig.model;
  }

  // ── History safety ─────────────────────────────────────

  private sanitizeHistory(): void {
    while (this.history.length > 0) {
      const first = this.history[0];
      if (first.role === "user") {
        if (Array.isArray(first.content) &&
            first.content.every((b: any) => b.type === "tool_result")) {
          this.history.shift();
          if (this.history[0]?.role === "assistant") this.history.shift();
          continue;
        }
        break;
      }
      if (first.role === "assistant") {
        this.history.shift();
        continue;
      }
      break;
    }

    for (let i = 1; i < this.history.length; i++) {
      if (this.history[i].role === this.history[i - 1].role) {
        const prev = this.history[i - 1];
        const curr = this.history[i];
        if (prev.role === "user") {
          const prevContent = Array.isArray(prev.content)
            ? prev.content
            : [{ type: "text", text: prev.content }];
          const currContent = Array.isArray(curr.content)
            ? curr.content
            : [{ type: "text", text: curr.content }];
          this.history[i - 1] = { role: "user", content: [...prevContent, ...currContent] };
        } else {
          const prevContent = Array.isArray(prev.content) ? prev.content : [{ type: "text", text: prev.content }];
          const currContent = Array.isArray(curr.content) ? curr.content : [{ type: "text", text: curr.content }];
          this.history[i - 1] = { role: "assistant", content: [...prevContent, ...currContent] };
        }
        this.history.splice(i, 1);
        i--;
      }
    }

    for (let i = 0; i < this.history.length; i++) {
      const msg = this.history[i];
      if (msg.role !== "user" || !Array.isArray(msg.content)) continue;

      const toolResults = msg.content.filter((b: any) => b.type === "tool_result");
      if (toolResults.length === 0) continue;

      const prevAssistant = i > 0 && this.history[i - 1].role === "assistant"
        ? this.history[i - 1]
        : null;

      if (!prevAssistant || !Array.isArray(prevAssistant.content)) {
        msg.content = msg.content.filter((b: any) => b.type !== "tool_result");
        if (msg.content.length === 0) {
          this.history.splice(i, 1);
          i--;
        }
        continue;
      }

      const validIds = new Set(
        prevAssistant.content
          .filter((b: any) => b.type === "tool_use")
          .map((b: any) => b.id)
      );

      msg.content = msg.content.filter((b: any) =>
        b.type !== "tool_result" || validIds.has(b.tool_use_id)
      );

      if (msg.content.length === 0) {
        this.history.splice(i, 1);
        i--;
      }
    }

    for (let i = 0; i < this.history.length; i++) {
      const msg = this.history[i];
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

      const toolUseIds = msg.content
        .filter((b: any) => b.type === "tool_use")
        .map((b: any) => b.id as string);
      if (toolUseIds.length === 0) continue;

      const nextMsg = this.history[i + 1];
      const existingResultIds = new Set<string>();
      if (nextMsg?.role === "user" && Array.isArray(nextMsg.content)) {
        for (const b of nextMsg.content) {
          if ((b as any).type === "tool_result") existingResultIds.add((b as any).tool_use_id);
        }
      }

      const missing = toolUseIds.filter((id: string) => !existingResultIds.has(id));
      if (missing.length === 0) continue;

      const patches = missing.map((id: string) => ({
        type: "tool_result" as const,
        tool_use_id: id,
        content: "[no response recorded]",
      }));

      if (nextMsg?.role === "user" && Array.isArray(nextMsg.content)) {
        nextMsg.content.unshift(...patches);
      } else {
        this.history.splice(i + 1, 0, { role: "user", content: patches });
      }
    }
  }

  private patchDanglingToolUse(): void {
    let lastAssistantIdx = -1;
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].role === "assistant") { lastAssistantIdx = i; break; }
    }
    if (lastAssistantIdx < 0) return;

    const assistantContent = this.history[lastAssistantIdx].content;
    if (!Array.isArray(assistantContent)) return;

    const toolUseIds = assistantContent
      .filter((b: any) => b.type === "tool_use")
      .map((b: any) => b.id);
    if (toolUseIds.length === 0) return;

    const nextMsg = this.history[lastAssistantIdx + 1];
    const existingIds = new Set<string>();
    if (nextMsg?.role === "user" && Array.isArray(nextMsg.content)) {
      for (const b of nextMsg.content) {
        if ((b as any).type === "tool_result") existingIds.add((b as any).tool_use_id);
      }
    }

    const missing = toolUseIds.filter((id: string) => !existingIds.has(id));
    if (missing.length === 0) return;

    const patchResults = missing.map((id: string) => ({
      type: "tool_result" as const,
      tool_use_id: id,
      content: "[interrupted by user]",
    }));

    if (nextMsg?.role === "user" && Array.isArray(nextMsg.content)) {
      nextMsg.content.push(...patchResults);
    } else {
      this.history.splice(lastAssistantIdx + 1, 0, { role: "user", content: patchResults });
    }
  }

  // ── Chat persistence ───────────────────────────────────

  private saveChat(): void {
    if (!this.chatId || this.history.length === 0) return;
    fs.mkdirSync(CHATS_DIR, { recursive: true });

    const userMsgs = this.history.filter((m) => m.role === "user" && typeof m.content === "string").length;

    const lines = [
      "---",
      `title: ${this.chatTitle}`,
      `created: ${new Date(parseInt(this.chatId, 10)).toISOString()}`,
      `messages: ${userMsgs}`,
      "---",
      "",
    ];

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

    const jsonMatch = raw.match(/```json\n([\s\S]*?)\n```/);
    let history: any[] = [];
    if (jsonMatch) {
      try { history = JSON.parse(jsonMatch[1]); } catch {}
    }

    return { title, history };
  }

  private async compact(): Promise<void> {
    if (!this.llmConfig?.apiKey) return;
    if (this.history.length <= 6) return;

    let keepCount = Math.min(6, Math.floor(this.history.length / 3));
    while (keepCount < this.history.length) {
      const firstRecent = this.history[this.history.length - keepCount];
      const hasToolResult =
        firstRecent?.role === "user" &&
        Array.isArray(firstRecent.content) &&
        firstRecent.content.some((b: any) => b.type === "tool_result");
      if (!hasToolResult) break;
      keepCount++;
    }
    const oldMessages = this.history.slice(0, -keepCount);
    const recentMessages = this.history.slice(-keepCount);

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

      this.history = [
        { role: "user", content: `[Earlier conversation summary: ${summaryText}]` },
        { role: "assistant", content: [{ type: "text", text: "Understood, I have the context from our earlier conversation." }] },
        ...recentMessages,
      ];
    } catch {
      this.history = recentMessages;
    }
  }
}
