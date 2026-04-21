/**
 * YoAgent — Orchestrator for .yo commands.
 *
 * Streams responses to the UI and delegates to specialist sub-agents:
 *   - NavigatorAgent: panel interaction (grab, click, navigate, type)
 *   - ResearcherAgent: notes and file search
 *   - ManagerAgent: skills, layouts, apps CRUD
 *
 * Direct tools: inject_text, run_command (output actions stay on orchestrator).
 */

import fs from "fs";
import path from "path";
import os from "os";
import { LLMConfig, createStream, createCompletion } from "./llm-config";
import { usageTracker } from "./usage-tracker";
import type { NoteStore } from "./note-store";
import type { AppConnector } from "./app-connector";
import type { MemoryStore } from "./memory-store";

import { NavigatorAgent } from "./agents/navigator-agent";
import { ResearcherAgent } from "./agents/researcher-agent";
import { ManagerAgent } from "./agents/manager-agent";
import { LayoutAgent } from "./agents/layout-agent";
import { SkillRunnerAgent } from "./agents/skill-runner-agent";
import { CodingAgent } from "./agents/coding-agent";
import { scanForInjection, scanWithLLM } from "./firewall";
import { webSearch, fetchPage } from "./web-search";
import { gate, gateMcp, getAgentMode } from "./action-gate";
import type { AgentMode } from "./action-gate";
import type { ApprovalCallback } from "./agents/base-agent";
import type { McpManager } from "./mcp-manager";

export interface YoAgentCallbacks {
  onText: (delta: string) => void;
  onToolUse: (id: string, name: string, input: unknown) => void;
  onToolResult?: (id: string, detail: string) => void;
  onDone: (fullText: string) => void;
  onError: (error: string) => void;
}

const SYSTEM_BASE = `You are yo, a workspace orchestrator. Act immediately, never ask for clarification.

ACTION PRIORITY (strict — follow this order):
1. MCP tools — for data access and actions (email, calendar, messages, files, etc.). Pennies per call, structured, reliable.
2. Skills — reusable prompts for complex workflows (/skillname)
3. Navigation — scan_panel → click_element → type_text for visual interaction only (UI that has no MCP equivalent)
4. grab_panel — LAST RESORT. Costs ~10K tokens per call. ONLY when user explicitly asks via .sup or you truly need full page text that no MCP tool can provide.

CRITICAL RULES:
- If an MCP tool exists for the task, ALWAYS use it. NEVER open a panel, navigate, or grab content for something MCP can do.
- After connect_app succeeds, MCP tools ARE available. Use them immediately. NEVER fall back to navigation after connecting.
- NEVER open_panel or delegate_navigator for apps that have MCP tools (email, calendar, slack, etc.).
- The ONLY reason to navigate a panel is for visual UI interaction that has no MCP equivalent (e.g. clicking a specific UI button).

APP AWARENESS:
- Before interacting with any app, call resolve_app to check if MCP tools exist.
- If resolve_app shows MCP tools → use them directly. Done.
- If resolve_app shows a connected account but no tools yet → try calling the MCP tool directly anyway.
- If not connected but available in Pipedream → offer to connect via connect_app, then use the MCP tools.
- If no Pipedream connector → ONLY THEN fall back to panel navigation.
- If multiple Pipedream matches → ask the user which app they mean.

TOOLS:
- resolve_app: check an app's MCP tools + connection status. Call before app interactions.
- connect_app: connect an app via OAuth to enable MCP tools. Needs user approval.
- delegate_navigator: scan, click, type in panels. For VISUAL interaction only — not for reading data that MCP tools can provide.
- delegate_layout: arrange panels on screen — splits, grids, tabs, zoom.
- delegate_researcher: notes and file search
- delegate_manager: skills, apps CRUD
- delegate_skill: run a named skill (/skillname)
- delegate_coder: write code, edit files, run shell commands
- ask_panel: send a prompt to AI chat panels. Modes: ask (independent), chain (sequential), debate (multi-round).
- pipe: cross-panel data flow (grab → transform → push)
- inject_text: paste into the input where user typed .yo
- search_store: search all past interactions (captures, MCP results, chats)
- search_chats: search past conversation history (fallback)
- web_search, fetch_page, save_memory, clipboard_read, clipboard_write, set_reminder, run_command

RULES:
- MCP tools FIRST. Call resolve_app if unsure whether MCP tools exist for an app.
- Use ask_panel to interact with AI apps. Use delegate_navigator for non-AI panel interactions.
- Check AVAILABLE PANELS and Current layout before acting. Arrange panels the user needs to see.
- Delegate in parallel when tasks are independent.
- Synthesize results — don't dump raw content.`;

const TOOLS = [
  {
    name: "delegate_navigator",
    description: "Delegate a visual interaction task to the panel specialist. Use for clicking, navigating, or typing in live app panels — NOT for reading data that MCP tools can provide. If an MCP tool exists (email, calendar, messages), use that instead.",
    input_schema: {
      type: "object" as const,
      properties: {
        instruction: { type: "string" as const, description: "Clear instruction for the navigator, e.g. 'List panels and grab the content from gmail' or 'Click the first email in gmail and grab its content'" },
      },
      required: ["instruction"],
    },
  },
  {
    name: "delegate_researcher",
    description: "Delegate a research task to the notes/files specialist. Use for searching notes, reading files, saving notes. Provide a clear instruction of what to find or save.",
    input_schema: {
      type: "object" as const,
      properties: {
        instruction: { type: "string" as const, description: "Clear instruction for the researcher, e.g. 'Search notes for pricing information' or 'Save a note titled X with content Y'" },
      },
      required: ["instruction"],
    },
  },
  {
    name: "delegate_manager",
    description: "Delegate a management task to the skills/layouts/apps specialist. Use for creating, listing, reading, or deleting skills, layouts, or apps.",
    input_schema: {
      type: "object" as const,
      properties: {
        instruction: { type: "string" as const, description: "Clear instruction for the manager, e.g. 'List all skills' or 'Create a skill named summarize with prompt: Summarize the following text concisely'" },
      },
      required: ["instruction"],
    },
  },
  {
    name: "delegate_layout",
    description: "Arrange panels on screen. Opens panels that aren't visible, creates splits/grids, manages tabs and zoom. Use this before ask_panel when the panels need to be shown to the user.",
    input_schema: {
      type: "object" as const,
      properties: {
        instruction: { type: "string" as const, description: "Clear instruction for the layout agent, e.g. 'Split claude and gemini side by side' or 'Create a 2x2 grid with claude, gemini, gpt, grok' or 'Save the current layout as research'" },
      },
      required: ["instruction"],
    },
  },
  {
    name: "delegate_skill",
    description: "Run a skill workflow. Skills are reusable agent behaviours with full tool access — they can navigate apps, search content, type into inputs, and produce output. Use when the user invokes /skillname or when a skill fits the request.",
    input_schema: {
      type: "object" as const,
      properties: {
        skill_name: { type: "string" as const, description: "Name of the skill to run (must exist in the skill engine)" },
        instruction: { type: "string" as const, description: "Additional instruction or context for the skill, e.g. 'summarize the email from John' or 'draft a reply to the last message'" },
      },
      required: ["skill_name", "instruction"],
    },
  },
  {
    name: "inject_text",
    description: "Paste text into the input field where the user typed .yo. Use when the user says 'paste it here', 'put it here', 'type it in', or similar.",
    input_schema: {
      type: "object" as const,
      properties: {
        text: { type: "string" as const, description: "The text to inject into the source input" },
      },
      required: ["text"],
    },
  },
  {
    name: "run_command",
    description: "Run a .dip or .drip command. Examples: 'dip claude', 'dip split claude gpt', 'drip fireworks'.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: { type: "string" as const, description: "The command to run" },
      },
      required: ["command"],
    },
  },
  {
    name: "save_memory",
    description: "Save something you learned about the user to persistent memory. Use for preferences, workflow patterns, app usage, facts about their work. Don't save trivial or one-off things.",
    input_schema: {
      type: "object" as const,
      properties: {
        content: { type: "string" as const, description: "What to remember, e.g. 'User prefers Gmail over Outlook' or 'User's project Acme uses React + TypeScript'" },
        category: {
          type: "string" as const,
          enum: ["preference", "fact", "workflow", "app_pattern", "context"],
          description: "Category: preference (likes/dislikes), fact (about their work/projects), workflow (how they do things), app_pattern (app-specific behaviour), context (situational)",
        },
      },
      required: ["content", "category"],
    },
  },
  {
    name: "search_store",
    description: "Search all past interactions — captures (.sup), MCP tool results, council exchanges, and chat history. This is your PRIMARY recall tool. Use when the user says 'what did I email', 'find that thing from yesterday', 'what did Claude say', etc.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string" as const, description: "Search query — topic, keyword, or phrase" },
        type: { type: "string" as const, enum: ["capture", "mcp", "council", "chat"], description: "Optional: filter by entry type" },
        limit: { type: "number" as const, description: "Max results (default 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "search_chats",
    description: "Search past conversation history by chat titles and message text. Fallback if search_store doesn't find what you need.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string" as const, description: "Search query — topic, keyword, or phrase to find in past chats" },
      },
      required: ["query"],
    },
  },
  {
    name: "web_search",
    description: "Search the web and return results (titles, URLs, snippets). Use for any question that needs current information, fact-checking, looking up docs, finding resources. No panel needed.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string" as const, description: "Search query" },
      },
      required: ["query"],
    },
  },
  {
    name: "fetch_page",
    description: "Fetch and read a web page as plain text. Use after web_search to read a specific result, or when the user gives you a URL to read. No panel needed.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string" as const, description: "URL to fetch" },
      },
      required: ["url"],
    },
  },
  {
    name: "delegate_coder",
    description: "Delegate a coding task to the file/shell specialist. Use for writing code, building apps, editing files, running shell commands (git, npm, tests). The coder writes files and opens them in workspace panels automatically — no need to open them yourself after.",
    input_schema: {
      type: "object" as const,
      properties: {
        instruction: { type: "string" as const, description: "Clear instruction for the coder, e.g. 'Build a pomodoro timer app' or 'Edit ~/project/index.ts and fix the import'" },
      },
      required: ["instruction"],
    },
  },
  {
    name: "clipboard_read",
    description: "Read text from the system clipboard.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "clipboard_write",
    description: "Write text to the system clipboard.",
    input_schema: {
      type: "object" as const,
      properties: {
        text: { type: "string" as const, description: "Text to copy to clipboard" },
      },
      required: ["text"],
    },
  },
  {
    name: "set_reminder",
    description: "Set a timed reminder for the user. The message appears in the yo panel after the delay.",
    input_schema: {
      type: "object" as const,
      properties: {
        message: { type: "string" as const, description: "Reminder message" },
        delay_seconds: { type: "number" as const, description: "Delay in seconds (min 1, max 86400)" },
      },
      required: ["message", "delay_seconds"],
    },
  },
  {
    name: "pipe",
    description: "Cross-panel data flow. Grab content from one panel, optionally transform it, and push it into another panel. Chains grab → transform → type in one call.",
    input_schema: {
      type: "object" as const,
      properties: {
        source_panel: { type: "string" as const, description: "Panel ID to grab content from" },
        target_panel: { type: "string" as const, description: "Panel ID to push content to" },
        transform: { type: "string" as const, description: "Optional instruction for transforming content (e.g. 'summarize', 'translate to French', 'extract emails')" },
        target_selector: { type: "string" as const, description: "Optional CSS selector for target input field" },
        submit: { type: "boolean" as const, description: "Press Enter after typing (default: false)" },
      },
      required: ["source_panel", "target_panel"],
    },
  },
  {
    name: "ask_panel",
    description: "Send a prompt to one or more AI chat panels and get real responses. Types the prompt, submits, waits for each AI to finish, returns actual content. Modes: 'ask' sends the same prompt to each panel independently. 'chain' feeds each panel's response to the next. 'debate' runs multiple rounds of back-and-forth between panels.",
    input_schema: {
      type: "object" as const,
      properties: {
        panels: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Panel IDs to interact with (e.g. ['claude'], ['claude', 'gemini'], ['claude', 'gemini', 'grok'])",
        },
        prompt: { type: "string" as const, description: "The prompt to send. For chain/debate mode with multiple panels, this goes to the first panel." },
        mode: {
          type: "string" as const,
          enum: ["ask", "chain", "debate"],
          description: "ask: same prompt to each panel (default). chain: feed each response to the next panel. debate: multi-round back-and-forth between panels.",
        },
        rounds: { type: "number" as const, description: "Number of rounds for debate mode (default: 1, max: 5). Each round = every panel responds once." },
      },
      required: ["panels", "prompt"],
    },
  },
  {
    name: "resolve_app",
    description: "Check if an app has MCP tools available before interacting with it. Returns connection status, available tools, and Pipedream catalog matches. Call this FIRST when you need to interact with an app and aren't sure if MCP tools exist.",
    input_schema: {
      type: "object" as const,
      properties: {
        intent: { type: "string" as const, description: "What the user wants to do, e.g. 'send email', 'check calendar', 'post to slack'" },
        app_hint: { type: "string" as const, description: "Specific app name if the user mentioned one, e.g. 'gmail', 'slack', 'anthropic'" },
      },
      required: ["intent"],
    },
  },
  {
    name: "connect_app",
    description: "Connect an app via OAuth so its MCP tools become available. Opens an OAuth popup for the user. Only call after resolve_app shows the app is not connected.",
    input_schema: {
      type: "object" as const,
      properties: {
        app_slug: { type: "string" as const, description: "Pipedream app slug to connect (from resolve_app results)" },
        panel_app_id: { type: "string" as const, description: "Panel app ID to associate with this connection (from resolve_app results)" },
      },
      required: ["app_slug"],
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
  private injector: ((text: string) => Promise<boolean>) | null = null;
  private commandRunner: ((cmd: string) => Promise<string>) | null = null;
  private aborted = false;
  private activeMemories: string = "";  // recalled memories for current turn
  private _activePanel: string | null = null; // panel the user typed .yo from
  private _mode: AgentMode = getAgentMode();
  private _approvalCallback: ApprovalCallback | null = null;
  private _councilParticipants: string[] = [];

  // Sub-agents
  private navigator = new NavigatorAgent();
  private researcher = new ResearcherAgent();
  private manager = new ManagerAgent();
  private layout = new LayoutAgent();
  private skillRunner = new SkillRunnerAgent();
  private coder = new CodingAgent();

  // Skill engine access (for listing + reading skill prompts)
  private skillList: (() => string[]) | null = null;
  private skillRead: ((name: string) => string | null) | null = null;

  // MCP server manager
  private mcpManager: McpManager | null = null;

  // Unified store for persistent interaction history
  private unifiedStore: import("./unified-store").UnifiedStore | null = null;

  // App awareness — resolve + connect apps from agent conversation
  private _appConnector: AppConnector | null = null;
  private connectorManager: import("./connectors").ConnectorManager | null = null;

  // Direct tool callbacks — new tools
  private _panelGrabber: ((panelId: string) => Promise<string | null>) | null = null;
  private _panelTyper: ((panelId: string, text: string, opts: { label?: string; placeholder?: string; selector?: string; clear?: boolean; submit?: boolean }) => Promise<string>) | null = null;
  private clipboardRead: (() => string) | null = null;
  private clipboardWrite: ((text: string) => void) | null = null;
  private reminderCallback: ((message: string, delayMs: number) => void) | null = null;
  private _layoutStateGetter: (() => { cols: number; rows: number; cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }> } | null) | null = null;
  private _panelCommandRunner: ((panelId: string, command: string, value?: string) => Promise<string>) | null = null;

  // ── Setters (forward to sub-agents) ──────────────────

  setActivePanel(panelId: string): void { this._activePanel = panelId; }

  /** Enter council mode — agent will route every user message to all participants via ask_panel. */
  setCouncil(participants: string[]): void {
    this._councilParticipants = [...participants];
    this._mode = "council";
  }
  clearCouncil(): void {
    this._councilParticipants = [];
    this._mode = getAgentMode();
  }
  getCouncilParticipants(): string[] { return [...this._councilParticipants]; }

  setLayoutStateGetter(fn: typeof this._layoutStateGetter): void { this._layoutStateGetter = fn; }

  setLLMConfig(config: LLMConfig): void {
    this.llmConfig = config;
    this.navigator.setLLMConfig(config);
    this.researcher.setLLMConfig(config);
    this.manager.setLLMConfig(config);
    this.layout.setLLMConfig(config);
    this.skillRunner.setLLMConfig(config);
    this.coder.setLLMConfig(config);
  }

  setSubAgentModel(model: string | null): void {
    this.navigator.setModelOverride(model);
    this.researcher.setModelOverride(model);
    this.manager.setModelOverride(model);
    this.layout.setModelOverride(model);
    this.skillRunner.setModelOverride(model);
    this.coder.setModelOverride(model);
  }

  setMemoryStore(store: MemoryStore): void { this.memoryStore = store; }

  setNoteStore(store: NoteStore): void {
    this.researcher.setNoteStore(store);
    this.skillRunner.setNoteStore(store);
  }

  setAppConnector(ac: AppConnector): void {
    this._appConnector = ac;
    this.manager.setAppConnector(ac);
    this.skillRunner.setAppConnector(ac);
    // Navigator, Layout, SkillRunner need panel listing from the app connector
    const lister = () => {
      const apps = ac.list();
      if (apps.length === 0) return "No panels configured.";
      return apps.map((a) => `${a.id} — ${a.name} (${a.url})`).join("\n");
    };
    this.navigator.setPanelLister(lister);
    this.layout.setPanelLister(lister);
    this.skillRunner.setPanelLister(lister);
  }

  setPanelGrabber(fn: (panelId: string) => Promise<string | null>): void {
    this._panelGrabber = fn;
    this.navigator.setPanelGrabber(fn);
    this.skillRunner.setPanelGrabber(fn);
    this.coder.setPanelGrabber(fn);
  }

  setPanelScanner(fn: (panelId: string) => Promise<string | null>): void {
    this.navigator.setPanelScanner(fn);
    this.skillRunner.setPanelScanner(fn);
    this.coder.setPanelScanner(fn);
  }

  setPanelClicker(fn: (panelId: string, text?: string, selector?: string) => Promise<string>): void {
    this.navigator.setPanelClicker(fn);
    this.skillRunner.setPanelClicker(fn);
  }

  setPanelNavigator(fn: (panelId: string, url: string) => Promise<string>): void {
    this.navigator.setPanelNavigator(fn);
    this.skillRunner.setPanelNavigator(fn);
  }

  setPanelTyper(fn: (panelId: string, text: string, opts: { label?: string; placeholder?: string; selector?: string; clear?: boolean; submit?: boolean }) => Promise<string>): void {
    this._panelTyper = fn;
    this.navigator.setPanelTyper(fn);
    this.skillRunner.setPanelTyper(fn);
  }

  setPanelOpener(fn: (url: string, panelId?: string) => Promise<string>): void {
    this.navigator.setPanelOpener(fn);
    this.skillRunner.setPanelOpener(fn);
    this.coder.setPanelOpener(fn);
  }

  setBackgroundOpener(fn: (url: string, panelId?: string) => Promise<string>): void {
    this.navigator.setBackgroundOpener(fn);
    this.skillRunner.setBackgroundOpener(fn);
  }

  setPanelCommandRunner(fn: (panelId: string, command: string, value?: string) => Promise<string>): void {
    this._panelCommandRunner = fn;
    this.navigator.setCommandRunner(fn);
  }

  setPanelScreenshotter(fn: (panelId: string) => Promise<string | null>): void {
    this.navigator.setPanelScreenshotter(fn);
    this.skillRunner.setPanelScreenshotter(fn);
  }

  setPanelRefresher(fn: (panelId?: string) => Promise<string>): void {
    this.navigator.setPanelRefresher(fn);
    this.skillRunner.setPanelRefresher(fn);
    this.coder.setPanelRefresher(fn);
  }

  setTabManager(tm: { list: () => Array<{ id: string; title: string; url?: string }>; switch: (id: string) => void; close: (id: string) => void; create: () => string }): void {
    this.navigator.setTabManager(tm);
    this.layout.setTabManager(tm);
    this.skillRunner.setTabManager(tm);
  }

  setClipboard(read: () => string, write: (text: string) => void): void {
    this.clipboardRead = read;
    this.clipboardWrite = write;
    this.skillRunner.setClipboard(read, write);
  }

  setReminderCallback(fn: (message: string, delayMs: number) => void): void {
    this.reminderCallback = fn;
    this.skillRunner.setReminderCallback(fn);
  }

  setMaxMessages(n: number): void { this.maxMessages = n; }
  getMode(): AgentMode { return this._mode; }
  setMode(mode: AgentMode): void {
    this._mode = mode;
    // Propagate to sub-agents
    this.navigator.setMode(mode);
    this.researcher.setMode(mode);
    this.manager.setMode(mode);
    this.layout.setMode(mode);
    this.skillRunner.setMode(mode);
    this.coder.setMode(mode);
  }
  setApprovalCallback(cb: ApprovalCallback | null): void {
    this._approvalCallback = cb;
    // Propagate to sub-agents
    this.navigator.setApprovalCallback(cb);
    this.researcher.setApprovalCallback(cb);
    this.manager.setApprovalCallback(cb);
    this.layout.setApprovalCallback(cb);
    this.skillRunner.setApprovalCallback(cb);
    this.coder.setApprovalCallback(cb);
  }
  setCommandRunner(fn: (cmd: string) => Promise<string>): void {
    this.commandRunner = fn;
    this.layout.setCommandRunner(fn);
    this.skillRunner.setCommandRunner(fn);
  }
  setInjector(fn: (text: string) => Promise<boolean>): void {
    this.injector = fn;
    this.skillRunner.setInjector(fn);
  }

  setSkillCallbacks(cbs: {
    list: () => string[];
    read: (name: string) => string | null;
    create: (name: string, prompt: string) => void;
    remove: (name: string) => boolean;
  }): void {
    this.manager.setSkillCallbacks(cbs);
    this.skillRunner.setSkillCallbacks(cbs);
    // Keep references for orchestrator skill awareness
    this.skillList = cbs.list;
    this.skillRead = cbs.read;
  }

  setMcpManager(mgr: McpManager): void { this.mcpManager = mgr; }
  setUnifiedStore(store: import("./unified-store").UnifiedStore): void { this.unifiedStore = store; }
  setConnectorManager(cm: import("./connectors").ConnectorManager): void { this.connectorManager = cm; }

  setLayoutCallbacks(cbs: {
    list: () => Array<{ name: string; cols: number; rows: number; cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }> }>;
    save: (name: string, panels: string) => boolean;
    delete: (name: string) => boolean;
  }): void {
    this.manager.setLayoutCallbacks(cbs);
    this.layout.setLayoutCallbacks(cbs);
    this.skillRunner.setLayoutCallbacks(cbs);
  }

  abort(): void {
    this.aborted = true;
    this.navigator.abort();
    this.researcher.abort();
    this.manager.abort();
    this.layout.abort();
    this.skillRunner.abort();
    this.coder.abort();
  }

  // ── Chat management (unchanged) ──────────────────────

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
          // Collect tool_use blocks for this assistant turn
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

  /** Search chat history for a keyword/phrase. Returns matching chats with excerpts. */
  searchChats(query: string, limit = 10): Array<{ id: string; title: string; excerpt: string }> {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    const results: Array<{ id: string; title: string; excerpt: string; ts: number }> = [];

    fs.mkdirSync(CHATS_DIR, { recursive: true });
    try {
      const files = fs.readdirSync(CHATS_DIR).filter((f) => f.endsWith(".md")).sort().reverse();
      for (const f of files) {
        try {
          const raw = fs.readFileSync(path.join(CHATS_DIR, f), "utf-8");
          const lower = raw.toLowerCase();
          if (!lower.includes(q)) continue;

          // Extract title
          let title = f.replace(/\.md$/, "");
          const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
          if (fmMatch) {
            const t = fmMatch[1].match(/^title:\s*(.+)$/m);
            if (t) title = t[1].trim();
          }

          // Extract excerpt around the match
          const idx = lower.indexOf(q);
          const start = Math.max(0, idx - 80);
          const end = Math.min(raw.length, idx + query.length + 80);
          const excerpt = (start > 0 ? "..." : "") + raw.slice(start, end).replace(/\n/g, " ").trim() + (end < raw.length ? "..." : "");

          const id = f.replace(/\.md$/, "");
          results.push({ id, title, excerpt, ts: parseInt(id, 10) || 0 });
          if (results.length >= limit) break;
        } catch { /* skip */ }
      }
    } catch { /* dir missing */ }
    return results.map(({ id, title, excerpt }) => ({ id, title, excerpt }));
  }

  // ── Send (public API — unchanged) ────────────────────

  async send(message: string, cb: YoAgentCallbacks): Promise<void> {
    if (!this.llmConfig?.apiKey) {
      cb.onError("No API key configured. Set your LLM provider in Settings.");
      return;
    }

    this.aborted = false;

    // If the last message is a user message with tool_results (from a prior abort),
    // merge the new text into it rather than creating consecutive user messages
    // (the API requires alternating user/assistant).
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

    // ── Firewall: scan user message for injection attempts ──
    // Only hard-block the user's own message for clear injection syntax
    // (override, jailbreak, extraction). Content heuristics like resource_abuse
    // trigger too many false positives on legitimate captured AI content.
    const userScan = scanForInjection(message);
    if (userScan.blocked && userScan.intent && ["override", "extract", "jailbreak"].includes(userScan.intent)) {
      cb.onError(`Blocked: ${userScan.reason}`);
      // Remove the message we just pushed so history stays clean
      this.history.pop();
      return;
    }

    // ── Memory recall: search for relevant memories ──
    await this.recallMemories(message);

    try {
      await this.agentLoop(cb);
      this.saveChat();
      // ── Memory extract: background pass to learn from this turn ──
      this.extractMemories().catch(() => {});  // fire-and-forget
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

  // ── System prompt builder ────────────────────────────

  private buildSystemPrompt(): string {
    let prompt = SYSTEM_BASE;

    // Active panel context: tell the agent where the user is
    if (this._activePanel) {
      prompt += `\n\nACTIVE PANEL: The user is currently viewing the "${this._activePanel}" panel. When they say "the same question", "this conversation", "what's here", etc., they mean this panel. Use MCP tools for this app if available — only grab_panel as last resort.`;
    }

    // Self-awareness: don't use your own app panel to answer questions
    if (this.llmConfig) {
      const model = this.llmConfig.model.toLowerCase();
      const provider = this.llmConfig.provider;
      // Map provider/model to app panel IDs the agent should avoid
      const selfPanels: string[] = [];
      if (provider === "anthropic" || model.includes("claude")) selfPanels.push("claude");
      if (provider === "openai" || model.includes("gpt") || model.includes("o3") || model.includes("o4")) selfPanels.push("gpt", "chatgpt");
      if (provider === "google" || model.includes("gemini")) selfPanels.push("gemini");
      if (provider === "xai" || model.includes("grok")) selfPanels.push("grok");
      if (provider === "deepseek" || model.includes("deepseek")) selfPanels.push("deepseek");

      if (selfPanels.length > 0) {
        prompt += `\n\nSELF-AWARENESS:\nYou are running on ${provider} (${this.llmConfig.model}). The panels [${selfPanels.join(", ")}] are your own web interface. If the user asks a general knowledge question without naming a panel, answer it yourself — don't delegate to your own panel. But when the user explicitly says "ask claude", "have gemini and claude debate", etc., ALWAYS use ask_panel — even for your own panel. ask_panel works on all panels including yours.`;
      }
    }

    // Inject MCP tools FIRST — these are the primary action path
    if (this.mcpManager) {
      const mcpTools = this.mcpManager.getAllTools();
      if (mcpTools.length > 0) {
        // Group by server
        const byServer = new Map<string, typeof mcpTools>();
        for (const t of mcpTools) {
          const group = byServer.get(t.serverName) || [];
          group.push(t);
          byServer.set(t.serverName, group);
        }
        let mcpSection = "\n\nMCP TOOLS (PRIMARY — use these first for actions):";
        for (const [serverName, tools] of byServer) {
          mcpSection += `\n${serverName}:`;
          for (const t of tools) {
            mcpSection += `\n  - ${t.qualifiedName}: ${t.description}`;
          }
        }
        mcpSection += "\nCall MCP tools directly by their qualified name (mcp__<server>__<tool>). These are structured, cheap, and reliable — always prefer over grab_panel.";
        prompt += mcpSection;
      }
    }

    // Inject available skills
    if (this.skillList) {
      const skills = this.skillList();
      if (skills.length > 0) {
        prompt += `\n\nAVAILABLE SKILLS:\n${skills.map((s) => `- /${s}`).join("\n")}\nWhen the user says /<skillname> or asks to apply a skill, use delegate_skill with that skill name.`;
      }
    }

    // Inject available panels + current layout (secondary — for visual interaction only)
    const panelList = this.navigator.listPanels();
    if (panelList) {
      let panelSection = `\n\nAVAILABLE PANELS (for visual interaction — use scan_panel/click/type, NOT grab_panel):\n${panelList}`;

      // Add current layout arrangement
      const layoutState = this._layoutStateGetter ? this._layoutStateGetter() : null;
      if (layoutState) {
        const { cols, rows, cells } = layoutState;
        if (rows === 1 && cols === 1) {
          panelSection += `\nCurrent layout: single panel (${cells[0]?.panelId || "unknown"})`;
        } else {
          const grid = Array.from({ length: rows }, (_, r) =>
            cells.filter((c) => c.row === r).sort((a, b) => a.col - b.col).map((c) => c.panelId).join(" | ")
          ).join(" / ");
          panelSection += `\nCurrent layout: ${cols}×${rows} grid — ${grid}`;
        }
      } else {
        panelSection += `\nCurrent layout: single panel view`;
      }

      panelSection += `\nUse delegate_layout to arrange any of these panels on screen.`;
      prompt += panelSection;
    }

    if (this.activeMemories) {
      // Firewall: scan recalled memories for injection before adding to system prompt
      const memoryScan = scanForInjection(this.activeMemories);
      if (!memoryScan.blocked) {
        prompt += `\n\nYOUR MEMORIES:\n${this.activeMemories}`;
      }
      // If blocked, silently omit poisoned memories from the system prompt
    }

    // Council mode: agent sends every user message to all participants
    if (this._councilParticipants.length > 0) {
      prompt += `\n\nMODE: COUNCIL [${this._councilParticipants.join(", ")}]
Pass the user's EXACT message to ask_panel. Do NOT rewrite, embellish, or add instructions — send their words verbatim as the prompt.
Use ask_panel with panels=[${this._councilParticipants.map(p => `"${p}"`).join(", ")}] mode="ask".
After responses come back, present them as **name:** response (keep each short — trim to the core point if verbose).
Your own commentary: 1-2 sentences max. No intros, no summaries, no "the council has spoken" fluff.
If the user addresses one model specifically, use ask_panel with just that one.`;
    }

    // Plan mode: tell the agent to describe its plan without executing
    if (this._mode === "plan") {
      prompt += `\n\nMODE: PLAN
You are in plan mode. DO NOT call any tools. Instead, outline your plan as a concise numbered list. Each step should be ONE line: what you'd do and which tool/panel you'd use. No explanations, no sub-bullets, no elaboration — just the action. Keep it tight, max 8 steps. Example:
1. Search notes for prior .yo research (delegate_researcher)
2. Open claude + gemini side by side (run_command: dip split claude gemini)
3. Brief Claude on findings (delegate_navigator)`;
    }

    return prompt;
  }

  // ── Agent loop (orchestrator) ───���─────────���──────────

  private static readonly MAX_TOOL_ITERATIONS = 20;

  private async agentLoop(cb: YoAgentCallbacks, iteration = 0): Promise<void> {
    // Fix any structural issues before hitting the API. Idempotent, so safe
    // to run every iteration as a guard against unpaired tool_use/tool_result
    // blocks (e.g. from aborts, compaction, or loaded-chat corruption).
    this.sanitizeHistory();

    let fullText = "";

    const systemPrompt = this.buildSystemPrompt();

    // Merge built-in tools with MCP tools
    const allTools = [...TOOLS, ...(this.mcpManager?.getAgentTools() || [])];

    const response = await createStream(
      this.llmConfig!,
      {
        system: systemPrompt,
        messages: this.history,
        tools: allTools,
        maxTokens: 4096,
      },
      (delta) => {
        fullText += delta;
        cb.onText(delta);
      },
    );

    if (response.usage) {
      usageTracker.record("orchestrator", response.usage);
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

      // Partition into delegate, MCP, and direct tools
      const delegateBlocks = toolBlocks.filter((b: any) =>
        b.name.startsWith("delegate_"));
      const mcpBlocks = toolBlocks.filter((b: any) =>
        b.name.startsWith("mcp__"));
      const directBlocks = toolBlocks.filter((b: any) =>
        !b.name.startsWith("delegate_") && !b.name.startsWith("mcp__"));

      const results: any[] = [];

      // Run all delegate calls in parallel (sub-agent tools are silent — no onToolUse forwarding)
      if (delegateBlocks.length > 0 && !this.aborted) {
        const context = this.buildSubAgentContext();
        const delegatePromises = delegateBlocks.map(async (block: any) => {
          if (this.aborted) return { type: "tool_result", tool_use_id: block.id, content: "[interrupted by user]" };

          // Gate check on the delegation itself
          const decision = gate(block.name, this._mode);
          if (decision === "skip") {
            return { type: "tool_result", tool_use_id: block.id, content: "[skipped — plan mode]" };
          }
          if (decision === "needs_approval" && this._approvalCallback) {
            const approved = await this._approvalCallback(block.name, block.input as Record<string, unknown>);
            if (!approved) {
              cb.onToolResult?.(block.id, "[blocked by user]");
              return { type: "tool_result", tool_use_id: block.id, content: "[blocked by user]" };
            }
          }

          cb.onToolUse(block.id, block.name, block.input);
          const result = await this.execDelegation(
            block.name,
            block.input as Record<string, unknown>,
            context,
          );
          // Emit compact result for the renderer
          cb.onToolResult?.(block.id, result.slice(0, 500));
          return { type: "tool_result", tool_use_id: block.id, content: result };
        });
        const delegateResults = await Promise.all(delegatePromises);
        results.push(...delegateResults);
      }

      // Run MCP tools in parallel (with MCP-specific gate checks)
      if (mcpBlocks.length > 0 && !this.aborted && this.mcpManager) {
        const mcpPromises = mcpBlocks.map(async (block: any) => {
          if (this.aborted) return { type: "tool_result", tool_use_id: block.id, content: "[interrupted by user]" };

          const decision = gateMcp(block.name, this._mode);
          if (decision === "skip") {
            return { type: "tool_result", tool_use_id: block.id, content: "[skipped — plan mode]" };
          }
          if (decision === "needs_approval" && this._approvalCallback) {
            const approved = await this._approvalCallback(block.name, block.input as Record<string, unknown>);
            if (!approved) {
              cb.onToolResult?.(block.id, "[blocked by user]");
              return { type: "tool_result", tool_use_id: block.id, content: "[blocked by user]" };
            }
          }

          cb.onToolUse(block.id, block.name, block.input);
          const result = await this.mcpManager!.callTool(block.name, block.input as Record<string, unknown>);
          // Firewall: scan MCP output for injection
          const contentScan = scanForInjection(result);
          const safeResult = contentScan.blocked ? `[content blocked by firewall: ${contentScan.reason}]` : result;
          cb.onToolResult?.(block.id, safeResult.slice(0, 500));
          // Ingest MCP result into unified store (non-blocking)
          if (this.unifiedStore && !contentScan.blocked) {
            this.unifiedStore.ingest({
              type: "mcp",
              source: block.name,
              content: safeResult,
              toolName: block.name,
              toolArgs: block.input as Record<string, unknown>,
            }).catch(() => {});
          }
          return { type: "tool_result", tool_use_id: block.id, content: safeResult };
        });
        const mcpResults = await Promise.all(mcpPromises);
        results.push(...mcpResults);
      }

      // Run direct tools sequentially (with gate checks)
      for (const block of directBlocks) {
        if (this.aborted) break;

        const decision = gate(block.name, this._mode);
        if (decision === "skip") {
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

        cb.onToolUse(block.id, block.name, block.input);
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

  // ── Sub-agent context ────────────────────────────────

  private buildSubAgentContext() {
    // Extract last 3-4 user/assistant text exchanges
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

  // ── Delegation execution ─────────────────────────────

  private async execDelegation(
    name: string,
    input: Record<string, unknown>,
    context: { conversationSummary?: string; userMessage: string },
  ): Promise<string> {
    const instruction = input.instruction as string;
    if (!instruction) return "No instruction provided.";

    try {
      let result;
      switch (name) {
        case "delegate_navigator": {
          // Inject current panel list so navigator doesn't waste a list_panels call or open duplicates
          const panelList = this.navigator.listPanels();
          const enriched = panelList
            ? `${instruction}\n\nAVAILABLE APP PANELS (use scan_panel, click_element, type_text, run_command — grab_panel only as last resort):\n${panelList}`
            : instruction;
          result = await this.navigator.execute(enriched, context);
          break;
        }
        case "delegate_researcher":
          result = await this.researcher.execute(instruction, context);
          break;
        case "delegate_manager":
          result = await this.manager.execute(instruction, context);
          break;
        case "delegate_layout":
          result = await this.layout.execute(instruction, context);
          break;
        case "delegate_skill": {
          const skillName = input.skill_name as string;
          if (!skillName) return "No skill name provided.";
          if (!this.skillRead) return "Skill engine not available.";
          const prompt = this.skillRead(skillName);
          if (!prompt) return `Skill "${skillName}" not found. Use delegate_manager to list available skills.`;
          this.skillRunner.setSkillPrompt(prompt);
          result = await this.skillRunner.execute(instruction, context);
          break;
        }
        case "delegate_coder":
          result = await this.coder.execute(instruction, context);
          break;
        default:
          return `Unknown delegation: ${name}`;
      }
      // ── Firewall: scan delegation output for indirect injection ──
      const contentScan = scanForInjection(result.summary);
      if (contentScan.blocked) {
        return `[content blocked by firewall: ${contentScan.reason}]`;
      }
      // Layer 2: borderline content → LLM judge
      if (contentScan.borderline && contentScan.analysis && this.llmConfig) {
        const llmScan = await scanWithLLM(result.summary, contentScan.analysis, this.llmConfig);
        if (llmScan.blocked) {
          return `[content blocked by firewall: ${llmScan.reason}]`;
        }
      }
      return result.summary;
    } catch (err) {
      return `Delegation error: ${err instanceof Error ? err.message : err}`;
    }
  }

  // ── Direct tool execution ────────────────────────────

  private async execDirectTool(name: string, input: Record<string, unknown>): Promise<string> {
    try {
      switch (name) {
        case "inject_text": return await this.toolInjectText(input);
        case "run_command": return await this.toolRunCommand(input);
        case "save_memory": return await this.toolSaveMemory(input);
        case "search_store": return await this.toolSearchStore(input);
        case "search_chats": return this.toolSearchChats(input);
        case "web_search": return await this.toolWebSearch(input);
        case "fetch_page": return await this.toolFetchPage(input);
        case "clipboard_read": return this.toolClipboardRead();
        case "clipboard_write": return this.toolClipboardWrite(input);
        case "set_reminder": return this.toolSetReminder(input);
        case "pipe": return await this.toolPipe(input);
        case "ask_panel": return await this.toolAskPanel(input);
        case "resolve_app": return await this.toolResolveApp(input);
        case "connect_app": return await this.toolConnectApp(input);
        default: return `Unknown tool: ${name}`;
      }
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  }

  private async toolInjectText(input: Record<string, unknown>): Promise<string> {
    const text = input.text as string;
    if (!text) return "No text provided.";
    if (!this.injector) return "No source input available — the user may not have typed .yo from an app panel.";
    const ok = await this.injector(text);
    return ok ? "Text injected into the input field." : "Could not inject — the source input is no longer available.";
  }

  private async toolRunCommand(input: Record<string, unknown>): Promise<string> {
    const cmd = (input.command as string || "").trim();
    if (!cmd) return "No command provided.";
    const first = cmd.split(/\s+/)[0].toLowerCase().replace(/^\./, "");
    if (first !== "dip" && first !== "drip") return `Only dip and drip commands are allowed. Got: ${first}`;
    if (!this.commandRunner) return "Command runner not available.";
    return this.commandRunner(cmd);
  }

  private async toolSaveMemory(input: Record<string, unknown>): Promise<string> {
    const content = input.content as string;
    const category = input.category as "preference" | "fact" | "workflow" | "app_pattern" | "context";
    if (!content) return "No content provided.";
    if (!this.memoryStore) return "Memory not available.";
    const id = await this.memoryStore.save(content, category || "context");
    return `Memory saved (${id}).`;
  }

  private async toolSearchStore(input: Record<string, unknown>): Promise<string> {
    const query = input.query as string;
    if (!query) return "No query provided.";
    if (!this.unifiedStore) return "Store not available.";
    const type = input.type as import("./unified-store").EntryType | undefined;
    const limit = (input.limit as number) || 10;
    const results = await this.unifiedStore.search(query, type, limit);
    if (results.length === 0) return `No stored interactions found matching "${query}".`;
    return results.map((r) => {
      const date = new Date(r.meta.created).toLocaleString();
      const label = r.meta.toolName || r.meta.source;
      const snippet = r.content.length > 500 ? r.content.slice(0, 500) + "…" : r.content;
      return `[${r.meta.type}] ${label} (${date})\n${snippet}`;
    }).join("\n\n---\n\n");
  }

  private async toolResolveApp(input: Record<string, unknown>): Promise<string> {
    const intent = input.intent as string || "";
    const appHint = input.app_hint as string || "";
    const searchTerm = appHint || intent;
    if (!searchTerm) return "No intent or app_hint provided.";

    const lines: string[] = [`APP RESOLUTION for "${searchTerm}":`];
    const term = searchTerm.toLowerCase();
    const accounts = this.connectorManager ? await this.connectorManager.getAccounts() : [];
    const allTools = this.mcpManager?.getAllTools() || [];

    // 1. Check MCP tools first — if tools exist for this app, that's the answer
    const matchingTools = allTools.filter((t) => {
      const n = t.name.toLowerCase();
      const d = t.description.toLowerCase();
      return n.includes(term) || d.includes(term) || term.split(/[\s_-]+/).some((w) => n.includes(w));
    });

    if (matchingTools.length > 0) {
      lines.push(`\nMCP TOOLS AVAILABLE (${matchingTools.length}) — use these directly:`);
      for (const t of matchingTools.slice(0, 15)) {
        lines.push(`  - ${t.qualifiedName}: ${t.description}`);
      }
      if (matchingTools.length > 15) lines.push(`  ... and ${matchingTools.length - 15} more`);
      lines.push(`\nAction: USE THESE MCP TOOLS. Do NOT open panels or navigate.`);
      return lines.join("\n");
    }

    // 2. Check connected accounts — an account may exist even without panel app linkage
    const matchingAccounts = accounts.filter((a) => {
      const slug = a.appSlug.toLowerCase();
      return slug.includes(term) || term.includes(slug.replace(/_/g, "").replace(/v\d+$/, ""));
    });

    if (matchingAccounts.length > 0) {
      lines.push(`\nConnected Pipedream accounts:`);
      for (const a of matchingAccounts) {
        lines.push(`  - ${a.appSlug} (healthy: ${a.healthy})`);
      }
      const serverState = this.mcpManager?.getServerState("pipedream-connect");
      if (serverState) {
        lines.push(`\nMCP server status: ${serverState.status}${serverState.error ? ` — error: ${serverState.error}` : ""}`);
        if (serverState.status !== "connected") {
          lines.push(`The MCP server is NOT connected. Tell the user: "Your ${searchTerm} account is connected but the MCP server isn't working. Try restarting yo or checking MCP settings."`);
        } else if (serverState.tools.length === 0) {
          lines.push(`MCP server connected but reports 0 tools. The Pipedream endpoint may be loading.`);
        }
      } else {
        lines.push(`\nMCP server "pipedream-connect" does not exist. The MCP bridge may not have initialized.`);
        lines.push(`Tell the user: "Your ${searchTerm} account is connected but MCP isn't set up. Try restarting yo."`);
      }
      return lines.join("\n");
    }

    // 3. Fuzzy match against panel apps (for context, not as primary resolution)
    const panelApps = this._appConnector?.list() || [];
    const matchedPanels = panelApps.filter((a) => {
      const id = a.id.toLowerCase();
      const name = a.name.toLowerCase();
      const url = a.url.toLowerCase();
      return id.includes(term) || name.includes(term) || term.includes(id) || term.includes(name) || url.includes(term);
    });

    if (matchedPanels.length > 0) {
      lines.push(`\nPanel apps found (no MCP tools available):`);
      for (const app of matchedPanels) {
        lines.push(`  - ${app.id} (${app.name})`);
      }
    }

    // 4. Search Pipedream catalog for connectable apps
    if (this.connectorManager) {
      try {
        const catalog = await this.connectorManager.getApps(searchTerm);
        if (catalog.apps.length > 0) {
          lines.push(`\nPipedream connectors available:`);
          for (const app of catalog.apps.slice(0, 5)) {
            lines.push(`  - ${app.id}: ${app.name} — ${app.description}`);
          }
          if (catalog.apps.length > 1) {
            lines.push(`\nMULTIPLE OPTIONS — ask the user which one they want before calling connect_app.`);
          } else {
            const slug = catalog.apps[0].id;
            const panelId = matchedPanels[0]?.id;
            lines.push(`\nTo connect: call connect_app with app_slug="${slug}"${panelId ? ` and panel_app_id="${panelId}"` : ""}.`);
          }
        } else if (matchedPanels.length === 0) {
          lines.push(`\nNo Pipedream connector found. Use panel navigation instead.`);
        }
      } catch {
        // Catalog search failed — continue with what we have
      }
    }

    if (matchedPanels.length === 0 && lines.length === 1) {
      lines.push(`No panel app or Pipedream connector found for "${searchTerm}".`);
      lines.push(`Use panel navigation if the app is open, or web_search to find it.`);
    }

    return lines.join("\n");
  }

  private async toolConnectApp(input: Record<string, unknown>): Promise<string> {
    const appSlug = input.app_slug as string;
    const panelAppId = input.panel_app_id as string | undefined;
    if (!appSlug) return "No app_slug provided.";
    if (!this.connectorManager) return "Connector system not available.";
    if (!this.connectorManager.isPro()) return "App connections require an Advanced subscription. The user needs to upgrade to connect apps and use MCP tools.";

    const result = await this.connectorManager.connectApp(appSlug);
    if (!result.ok) {
      return `Failed to connect ${appSlug}: ${result.error || "unknown error"}`;
    }

    // Auto-link matching panel apps (fuzzy match slug against panel app ids/names)
    if (this._appConnector) {
      const slugBase = appSlug.replace(/_v\d+$/, "").replace(/_/g, "");
      for (const app of this._appConnector.list()) {
        if (app.connectedSlug) continue;
        const id = app.id.toLowerCase().replace(/-/g, "");
        const name = app.name.toLowerCase().replace(/\s/g, "");
        if (id.includes(slugBase) || slugBase.includes(id) || name.includes(slugBase) || slugBase.includes(name)) {
          this._appConnector.updateConnectedSlug(app.id, appSlug);
        }
      }
      if (panelAppId) {
        this._appConnector.updateConnectedSlug(panelAppId, appSlug);
      }
    }

    // connectApp already calls refreshMcp internally. Check server state.
    const serverState = this.mcpManager?.getServerState("pipedream-connect");
    const lines = [`Successfully connected ${appSlug} (OAuth complete).`];

    if (serverState?.status === "connected" && serverState.tools.length > 0) {
      const slugPrefix = appSlug.replace(/-/g, "_");
      const newTools = serverState.tools.filter((t) => t.name.startsWith(slugPrefix));
      if (newTools.length > 0) {
        lines.push(`\nMCP tools now available (${newTools.length}):`);
        for (const t of newTools.slice(0, 15)) {
          lines.push(`  - mcp__pipedream-connect__${t.name}: ${t.description || ""}`);
        }
        if (newTools.length > 15) lines.push(`  ... and ${newTools.length - 15} more`);
      } else {
        lines.push(`\nMCP server connected with ${serverState.tools.length} total tools, but none match "${appSlug}" prefix.`);
        lines.push(`Available tool prefixes: ${[...new Set(serverState.tools.map((t) => t.name.split("-")[0]))].join(", ")}`);
      }
      lines.push(`\nIMPORTANT: Use these MCP tools for all ${appSlug} actions. Do NOT open panels or navigate.`);
    } else if (serverState) {
      lines.push(`\nMCP server status: ${serverState.status}${serverState.error ? ` (${serverState.error})` : ""}`);
      lines.push(`The MCP connection to Pipedream failed or is still loading.`);
      lines.push(`Tell the user: "The app is connected but MCP tools aren't loading. Try restarting yo or checking the MCP settings."`);
    } else {
      lines.push(`\nMCP server not found — refreshMcp may have failed.`);
      lines.push(`Tell the user: "The app connected but the MCP server didn't start. Try restarting yo."`);
    }
    return lines.join("\n");
  }

  private toolSearchChats(input: Record<string, unknown>): string {
    const query = input.query as string;
    if (!query) return "No query provided.";
    const results = this.searchChats(query);
    if (results.length === 0) return `No past conversations found matching "${query}".`;
    return results.map((r) => `**${r.title}** (id: ${r.id})\n${r.excerpt}`).join("\n\n");
  }

  private async toolWebSearch(input: Record<string, unknown>): Promise<string> {
    const query = input.query as string;
    if (!query) return "No query provided.";
    const results = await webSearch(query);
    if (results.length === 0) return "No results found.";
    return results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
      .join("\n\n");
  }

  private async toolFetchPage(input: Record<string, unknown>): Promise<string> {
    const url = input.url as string;
    if (!url) return "No URL provided.";
    const content = await fetchPage(url);
    // Firewall: Layer 1 regex scan
    const scan = scanForInjection(content);
    if (scan.blocked) return `[content blocked by firewall: ${scan.reason}]`;
    // Firewall: Layer 2 LLM judge for borderline content
    if (scan.borderline && scan.analysis && this.llmConfig) {
      const llmScan = await scanWithLLM(content, scan.analysis, this.llmConfig);
      if (llmScan.blocked) return `[content blocked by firewall: ${llmScan.reason}]`;
    }
    return content;
  }

  private toolClipboardRead(): string {
    if (!this.clipboardRead) return "Clipboard access not available.";
    const text = this.clipboardRead();
    return text || "(clipboard is empty)";
  }

  private toolClipboardWrite(input: Record<string, unknown>): string {
    const text = input.text as string;
    if (!text) return "No text provided.";
    if (!this.clipboardWrite) return "Clipboard access not available.";
    this.clipboardWrite(text);
    return "Text copied to clipboard.";
  }

  private toolSetReminder(input: Record<string, unknown>): string {
    const message = input.message as string;
    const delaySec = input.delay_seconds as number;
    if (!message) return "No message provided.";
    if (!delaySec || delaySec < 1) return "Delay must be at least 1 second.";
    if (delaySec > 86400) return "Delay cannot exceed 24 hours (86400 seconds).";
    if (!this.reminderCallback) return "Reminders not available.";
    this.reminderCallback(message, delaySec * 1000);
    const unit = delaySec >= 3600 ? `${Math.round(delaySec / 3600)}h` : delaySec >= 60 ? `${Math.round(delaySec / 60)}m` : `${delaySec}s`;
    return `Reminder set: "${message}" in ${unit}.`;
  }

  private async toolPipe(input: Record<string, unknown>): Promise<string> {
    const sourcePanel = input.source_panel as string;
    const targetPanel = input.target_panel as string;
    const transform = input.transform as string | undefined;
    const targetSelector = input.target_selector as string | undefined;
    const submit = input.submit as boolean | undefined;

    if (!this._panelGrabber) return "Panel grabber not available.";
    if (!this._panelTyper) return "Panel typer not available.";

    // Step 1: Grab content from source (retry up to 3 times with backoff)
    let content: string | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      content = await this._panelGrabber(sourcePanel);
      if (content) break;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
    if (!content) return `Could not grab content from panel "${sourcePanel}" after 3 attempts. The panel may not be loaded or may have no visible text content. Try refreshing the panel or grabbing it directly with delegate_navigator first.`;

    // ── Firewall: scan grabbed content before feeding to LLM ──
    const pipeScan = scanForInjection(content);
    if (pipeScan.blocked) {
      return `[pipe blocked — source panel content triggered firewall: ${pipeScan.reason}]`;
    }

    // Step 2: Transform (optional)
    let output = content;
    if (transform && this.llmConfig) {
      try {
        const response = await createCompletion(this.llmConfig, {
          system: "You transform text exactly as instructed. Return only the transformed text, nothing else.",
          messages: [{ role: "user", content: `Transform this content. Instruction: ${transform}\n\nContent:\n${content.slice(0, 5000)}` }],
          maxTokens: 4000,
          model: this.getCheapModel(),
        });
        if (response.usage) usageTracker.record("orchestrator", response.usage);
        const text = response.content[0]?.type === "text" ? response.content[0].text : "";
        if (text) output = text;
      } catch {
        // If transform fails, use raw content
      }
    }

    // Step 3: Push to target
    const result = await this._panelTyper(targetPanel, output, {
      selector: targetSelector,
      clear: true,
      submit: submit,
    });

    return `Piped ${content.length} chars from ${sourcePanel} → ${targetPanel}${transform ? ` (transformed: ${transform})` : ""}. ${result}`;
  }

  // ── Panel interaction helpers ─────────────────────────

  /**
   * Type a prompt into a panel, submit, wait for AI response, return the content.
   * Self-contained: no LLM judgment involved.
   */
  private async sendAndWait(panelId: string, prompt: string, timeoutSec = 60): Promise<string> {
    if (!this._panelTyper) return `[${panelId}] Panel typing not available.`;
    if (!this._panelGrabber) return `[${panelId}] Panel grabbing not available.`;

    // Fast-fail: check if panel is loaded
    const baseline = await this._panelGrabber(panelId);
    if (baseline === null) {
      return `[${panelId}] Panel not loaded — use delegate_layout to open it first.`;
    }

    // Focus the correct chat input using app-specific "input" command
    if (this._panelCommandRunner) {
      try { await this._panelCommandRunner(panelId, "input"); } catch { /* fallback to generic focus */ }
      await new Promise((r) => setTimeout(r, 200));
    }

    // Type text WITHOUT submitting — we handle submit separately for reliability
    const typeResult = await this._panelTyper(panelId, prompt, { clear: true, submit: false });
    if (typeResult.includes("not found") || typeResult.includes("not loaded")) {
      return `[${panelId}] Could not type into panel: ${typeResult}`;
    }
    await new Promise((r) => setTimeout(r, 300));

    // Submit: try app-specific submit command first, fall back to generic
    let submitted = false;
    if (this._panelCommandRunner) {
      try {
        const result = await this._panelCommandRunner(panelId, "submit");
        if (result && !result.includes("not found") && !result.includes("No command") && !result.includes("failed")) {
          submitted = true;
        }
      } catch { /* fall through to fallback */ }
    }
    if (!submitted) {
      await this._panelTyper(panelId, "", { clear: false, submit: true });
    }

    // Poll for response in two phases
    const deadline = Date.now() + Math.min(Math.max(timeoutSec, 5), 120) * 1000;
    const changeDeadline = Date.now() + 20_000; // 20s to detect any change (submit may have failed)
    let prevContent = "";
    let stableCount = 0;
    let contentChanged = false;
    let nullCount = 0;
    const POLL_MS = 2500;
    const STABLE_THRESHOLD = 2;

    while (Date.now() < deadline) {
      if (this.aborted) return `[${panelId}] Aborted while waiting.`;
      await new Promise((r) => setTimeout(r, POLL_MS));
      const content = await this._panelGrabber(panelId);

      if (!content) {
        nullCount++;
        if (nullCount > 4) return `[${panelId}] Panel went unavailable.`;
        stableCount = 0; prevContent = ""; continue;
      }
      nullCount = 0;

      // Phase 1: wait for content to differ from baseline (AI started generating)
      if (!contentChanged) {
        if (content !== baseline) {
          contentChanged = true;
          prevContent = content;
          stableCount = 0;
        } else if (Date.now() > changeDeadline) {
          return `[${panelId}] No response after 20s — submit may have failed. Panel content unchanged.`;
        }
        continue;
      }

      // Phase 2: wait for content to stabilise (AI finished generating)
      if (content === prevContent) {
        stableCount++;
        if (stableCount >= STABLE_THRESHOLD) {
          return content.length > 3000
            ? content.slice(-3000) + "\n[earlier content truncated]"
            : content;
        }
      } else {
        stableCount = 0;
        prevContent = content;
      }
    }
    const final = await this._panelGrabber(panelId);
    return final || `[${panelId}] Timed out after ${timeoutSec}s — no content.`;
  }

  private async toolAskPanel(input: Record<string, unknown>): Promise<string> {
    const panels = input.panels as string[];
    const prompt = input.prompt as string;
    const mode = (input.mode as string) || "ask";
    const rounds = Math.min(Math.max((input.rounds as number) || 1, 1), 5);

    if (!panels?.length) return "No panels specified.";
    if (!prompt) return "No prompt provided.";

    // Ensure all target panels are loaded — open them if not
    if (this._panelGrabber && this.commandRunner) {
      const notLoaded: string[] = [];
      for (const panel of panels) {
        const check = await this._panelGrabber(panel);
        if (check === null) notLoaded.push(panel);
      }
      if (notLoaded.length > 0) {
        // Open via dip — creates webviews and shows the panels to the user
        if (panels.length >= 2) {
          await this.commandRunner(`dip split ${panels.join(" ")}`);
        } else {
          await this.commandRunner(`dip ${panels[0]}`);
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    const responses: Array<{ panel: string; content: string }> = [];

    if (mode === "ask") {
      // Send same prompt to each panel independently
      for (const panel of panels) {
        if (this.aborted) break;
        const content = await this.sendAndWait(panel, prompt);
        responses.push({ panel, content });
      }
    } else if (mode === "chain") {
      // Feed each panel's response to the next
      let currentPrompt = prompt;
      for (const panel of panels) {
        if (this.aborted) break;
        const content = await this.sendAndWait(panel, currentPrompt);
        responses.push({ panel, content });
        // Next panel gets this panel's response as context
        currentPrompt = content;
      }
    } else if (mode === "debate") {
      // Multi-round: each round, every panel responds to the previous panel's output
      let lastResponse = prompt;
      for (let round = 0; round < rounds; round++) {
        for (const panel of panels) {
          if (this.aborted) break;
          const roundPrompt = round === 0 && panel === panels[0]
            ? prompt
            : lastResponse;
          const content = await this.sendAndWait(panel, roundPrompt);
          responses.push({ panel, content });
          lastResponse = content;
        }
      }
    }

    // ── Firewall: scan panel responses before returning to orchestrator ──
    for (const r of responses) {
      const panelScan = scanForInjection(r.content);
      if (panelScan.blocked) {
        r.content = `[response from ${r.panel} blocked by firewall: ${panelScan.reason}]`;
      }
    }

    // Format results
    if (responses.length === 1) return responses[0].content;
    return responses
      .map((r) => `── ${r.panel} ──\n${r.content}`)
      .join("\n\n");
  }

  // ── Memory loop ──────────────────────────────────────

  /**
   * Recall: search memories relevant to the user's message.
   * Injects them into activeMemories for the system prompt.
   */
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

  /**
   * Extract: after each turn, run a cheap background LLM call to
   * pull out any new memories from the conversation. Fire-and-forget.
   */
  private async extractMemories(): Promise<void> {
    if (!this.memoryStore || !this.llmConfig?.apiKey) return;

    // Get last user message + assistant response
    const lastUser = this.getLastUserMessage();
    const lastAssistant = this.getLastResponse();
    if (!lastUser || !lastAssistant) return;

    // Skip trivial exchanges (very short responses)
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
      // Parse JSON from response (may be wrapped in markdown code block)
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
      // Non-fatal — extraction is best-effort
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

  // ── History safety ────────────────────────────────────

  /**
   * Sanitize history before API calls. Fixes structural issues that
   * can accumulate from aborts, compaction edge cases, or loaded chats.
   */
  private sanitizeHistory(): void {
    // 1. Ensure history starts with a user message (not tool_results)
    while (this.history.length > 0) {
      const first = this.history[0];
      if (first.role === "user") {
        // If it's a user message with only tool_results (no text), remove it
        if (Array.isArray(first.content) &&
            first.content.every((b: any) => b.type === "tool_result")) {
          this.history.shift();
          // Also remove the next message if it's the orphaned assistant response
          if (this.history[0]?.role === "assistant") this.history.shift();
          continue;
        }
        break;
      }
      // History shouldn't start with assistant — remove it
      if (first.role === "assistant") {
        this.history.shift();
        continue;
      }
      break;
    }

    // 2. Ensure alternating user/assistant (merge consecutive same-role messages)
    for (let i = 1; i < this.history.length; i++) {
      if (this.history[i].role === this.history[i - 1].role) {
        const prev = this.history[i - 1];
        const curr = this.history[i];
        if (prev.role === "user") {
          // Merge user messages: combine content into array form
          const prevContent = Array.isArray(prev.content)
            ? prev.content
            : [{ type: "text", text: prev.content }];
          const currContent = Array.isArray(curr.content)
            ? curr.content
            : [{ type: "text", text: curr.content }];
          this.history[i - 1] = { role: "user", content: [...prevContent, ...currContent] };
        } else {
          // Merge assistant messages: combine content arrays
          const prevContent = Array.isArray(prev.content) ? prev.content : [{ type: "text", text: prev.content }];
          const currContent = Array.isArray(curr.content) ? curr.content : [{ type: "text", text: curr.content }];
          this.history[i - 1] = { role: "assistant", content: [...prevContent, ...currContent] };
        }
        this.history.splice(i, 1);
        i--; // re-check same index
      }
    }

    // 3. Ensure every tool_result references a tool_use in the preceding assistant message
    for (let i = 0; i < this.history.length; i++) {
      const msg = this.history[i];
      if (msg.role !== "user" || !Array.isArray(msg.content)) continue;

      const toolResults = msg.content.filter((b: any) => b.type === "tool_result");
      if (toolResults.length === 0) continue;

      // Find preceding assistant message
      const prevAssistant = i > 0 && this.history[i - 1].role === "assistant"
        ? this.history[i - 1]
        : null;

      if (!prevAssistant || !Array.isArray(prevAssistant.content)) {
        // No preceding assistant — strip tool_results, keep text
        msg.content = msg.content.filter((b: any) => b.type !== "tool_result");
        if (msg.content.length === 0) {
          this.history.splice(i, 1);
          i--;
        }
        continue;
      }

      // Get valid tool_use IDs from preceding assistant
      const validIds = new Set(
        prevAssistant.content
          .filter((b: any) => b.type === "tool_use")
          .map((b: any) => b.id)
      );

      // Remove tool_results that reference non-existent tool_use IDs
      msg.content = msg.content.filter((b: any) =>
        b.type !== "tool_result" || validIds.has(b.tool_use_id)
      );

      if (msg.content.length === 0) {
        this.history.splice(i, 1);
        i--;
      }
    }

    // 4. Ensure every tool_use in an assistant message has a matching tool_result
    //    in the following user message (patch missing ones to prevent API errors)
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
        // Insert a new user message with the missing tool_results
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

  // ── Chat persistence (unchanged) ─────────────────────

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

    // Ingest chat text into unified store (non-blocking)
    if (this.unifiedStore) {
      const chatText = this.history
        .filter((m) => typeof m.content === "string")
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n");
      if (chatText.length > 0) {
        this.unifiedStore.ingest({
          type: "chat",
          source: this.chatId!,
          content: `# ${this.chatTitle}\n\n${chatText}`,
        }).catch(() => {});
      }
    }
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
    // Don't split a tool_use/tool_result pair: if the first kept message is a
    // user message containing tool_results, pull in the preceding assistant
    // message (which holds the matching tool_use). Otherwise the Anthropic
    // API rejects the request with "unexpected tool_use_id".
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
