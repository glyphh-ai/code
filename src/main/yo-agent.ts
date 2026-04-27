/**
 * YoAgent — orchestrator with specialist sub-agents.
 *
 * Direct tools: search_captures, get_context, format, save_memory,
 *   search_notes, read_file, list_files, run_command, start_council.
 * Delegation: delegate_navigate (panel interaction), delegate_layout (workspace arrangement), delegate_build (skill/vibe coding).
 * Streams responses to the UI.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { LLMConfig, createStream, createCompletion } from "./llm-config";
import {
  getAgentToolSpec,
  executeTool,
  BudgetTracker,
  inhale as substrateInhale,
  exhale as substrateExhale,
  reflex as substrateReflex,
  thinkCritique,
} from "./substrate";
import { BudgetExceededError } from "./substrate/types";
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
import { BuilderAgent } from "./agents/builder-agent";
import type { SubAgentContext } from "./agents/types";

export type ApprovalCallback = (toolName: string, input: Record<string, unknown>) => Promise<boolean>;

export interface YoAgentCallbacks {
  onText: (delta: string) => void;
  onToolUse: (id: string, name: string, input: unknown) => void;
  onToolResult?: (id: string, detail: string) => void;
  onDone: (fullText: string) => void;
  onError: (error: string) => void;
}

const SYSTEM_BASE = `You are yo — a fast, concise assistant backed by a capture store and connected tools.

RULES:
- NEVER narrate. No "Let me...", "I'll start by...", "I found...", "Here's what I can do...". Just act and respond.
- Call tools immediately. Zero preamble.
- Responses: 1-3 sentences max unless the user asks for detail. Return actual content, not descriptions of it.
- No bullet-point alternatives. No follow-up questions unless truly stuck with zero options.
- If a tool fails or doesn't exist, say so in one sentence and stop.
- Plain text only. No markdown formatting — no headers, no bold, no bullets, no italic. Just plain sentences. Only exception: use code fences (\`\`\`) when returning actual code. Bare URLs are fine — they will be auto-linked.
- MCP tools (listed below) are for data access. delegate_navigate is ONLY for visual panel interaction when no MCP tool exists for the app.
- delegate_layout is for workspace arrangement only.
- delegate_build for building skills, vibes, and wiring data stores — always delegate coding work to the builder.
- search_captures uses vector search — descriptive phrases, not keywords.
- search_notes uses keyword search — specific terms.

BUILDING SKILLS, VIBES & DATA:
When the user asks to build, create, or modify a skill, vibe, or data pipeline — use delegate_build.
The builder sub-agent is a coding specialist that writes skills (SKILL.md + SKILL.js), vibes (APP.html), and wires data stores.
Give it a clear instruction describing what to build, what data it should handle, and how the user wants to interact with it.

Examples:
- "Build an email summary vibe that pulls from Gmail, stores summaries, and shows them in a dashboard with charts"
- "Create a skill that extracts customer data from captured pages and stores it for querying"
- "Update the sales-dashboard vibe to add a pie chart breakdown by region"

For simple skill reads/updates you can still use create_skill, update_skill, read_skill directly.
For quick data store queries use store_get, store_list, store_query, store_info directly.

AFTER BUILDING A VIBE:
When delegate_build returns and mentions a vibe name (look for "VIBE_NAME: <name>" in the response), tell the user to open it with .dip vibe-<name>. Do NOT use delegate_navigate to open vibes — just tell the user the command.

AVAILABLE RESOURCES FOR BUILDING:
- Chart.js is available in vibes via <script src="yo-asset://chart.umd.min.js"></script>
- Data store: namespaced KV with JSON query (store_set/get/delete/list/query/info)
- Vibes: interactive HTML apps with window.vibe API (runSkill, ask, searchCaptures, store.*)
- Vibes auto-inherit the full yo design system (CSS variables, components, light/dark theme) — no hardcoded colors
- Skills: prompt-based or SKILL.js runners with ctx.llm, ctx.skill, ctx.mcp, ctx.store

SKILL TYPES (for direct create_skill use):
- Prompt-only (default): just a prompt in SKILL.md. The LLM processes input using the prompt.
- Runner (SKILL.js): JavaScript lifecycle with ctx.input, ctx.llm(prompt), ctx.skill(name, input), ctx.mcp.call(app, tool, args), ctx.store.get/set/query, ctx.ask.user(question), ctx.file(relPath).

TOOL ENFORCEMENT:
Every skill must declare exactly the tools it needs in allowed_tools. Format: ["<app>.<tool>"].
Sub-skills must be listed in requires. Schedule with cron expressions if needed.

DRIP BUILDING:
When the user asks you to create a drip (visual effect overlay):
1. Call read_drip (no name) to see built-in effects and existing customs.
2. Call create_drip with a name and recipe. Recipes combine built-in effects.
3. Tell the user to run .drip <name> to test it.
4. Use update_drip to iterate on the recipe.

RECIPE SYNTAX:
- One-shot: "[count] [effects...]" e.g. "fireworks hearts 2" plays fireworks+hearts twice
- Persistent: "-1 [opacity] [effects...]" e.g. "-1 0.5 matrix" loops matrix at 50% opacity
- Built-in one-shot: fireworks, hearts, confetti, stars, rain, bubbles, sparkle, spiral, emoji, wave, thumbsup
- Built-in loops: matrix, aurora, nebula, plasma, fireflies, starfield
- Custom names can reference other customs (chaining)

LAYOUT BUILDING:
When the user asks you to create a layout (panel grid arrangement):
1. Call read_layout (no name) to see existing layouts.
2. Call create_layout with grid dimensions and panel placements.
3. Tell the user to apply it from the layouts page or with .dip layout <name>.
4. Use update_layout to adjust proportions or swap panels.

LAYOUT MODEL:
- Grid: 1-4 cols x 1-4 rows
- col_widths/row_heights: fractions summing to ~1 (e.g. [0.6, 0.4] for 60/40 split)
- Each cell: panel_id + col/row position + optional col_span/row_span for spanning
- Panel IDs are app names (gmail, claude, slack, etc.) matching the user's registered apps.`;

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
  // ── Substrate state for the current turn ──
  private _substrateBudget: import("./substrate").BudgetTracker | null = null;
  private _substrateIntent: import("./substrate").Intent = "ask";
  private _substrateRecall: { patterns: Array<{ outcome: string; skills: string[]; durationMs: number }>; evidence: Array<{ preview: string; score: number }> } | null = null;
  private _substrateComposed: string[] = [];
  private _currentUserMessage = "";
  private _critiqueAttempted = false;

  // Sub-agents — sync mode from preferences at init
  navigator = (() => { const n = new NavigatorAgent(); n.setMode(getAgentMode()); return n; })();
  layout = (() => { const l = new LayoutAgent(); l.setMode(getAgentMode()); return l; })();
  builder = (() => { const b = new BuilderAgent(); b.setMode(getAgentMode()); b.setModelOverride("orchestrator"); return b; })();
  private _layoutStateGetter: (() => { cols: number; rows: number; cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }> } | null) | null = null;

  // ── Setters ────────────────────────────────────────────

  setLLMConfig(config: LLMConfig): void {
    this.llmConfig = config;
    this.navigator.setLLMConfig(config);
    this.layout.setLLMConfig(config);
    this.builder.setLLMConfig(config);
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
    this.builder.setMode(mode);
  }
  setApprovalCallback(cb: ApprovalCallback | null): void {
    this._approvalCallback = cb;
    this.navigator.setApprovalCallback(cb);
    this.layout.setApprovalCallback(cb);
    this.builder.setApprovalCallback(cb);
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
    this.builder.setModelOverride(model || "orchestrator");
  }

  abort(): void {
    this.aborted = true;
    this.navigator.abort();
    this.layout.abort();
    this.builder.abort();
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

    // ── Substrate inhale: classify intent, snapshot context, recall similar runs.
    // Failures here are non-fatal — degrade to defaults so the agent still runs.
    this._substrateBudget = new BudgetTracker();
    this._currentUserMessage = message;
    this._critiqueAttempted = false;
    this._substrateRecall = null;
    this._substrateComposed = [];
    try {
      const inhaleResult = await substrateInhale({
        userMessage: message,
        skillName: "yo-agent",
        budget: this._substrateBudget,
      });
      this._substrateIntent = inhaleResult.intent;
      this._substrateRecall = inhaleResult.recall;
      this._substrateComposed = inhaleResult.composed;
    } catch (err) {
      console.warn("[yo-agent] substrate inhale failed:", err);
      this._substrateIntent = "ask";
    }

    let outcome: "success" | "error" = "success";
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

      // Ingest the conversation turn into the capture store for search
      if (this.captureStore && responseText) {
        const turnContent = `[user]\n${message}\n\n[assistant]\n${responseText}`;
        this.captureStore.ingest("yo-agent", turnContent).catch(() => {});
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

      // ── Substrate exhale: best-effort critique on final response.
      // We don't re-stream/re-format — the bytes already went to the user — but
      // recording the critique lets reflex.remember surface bad patterns.
      try {
        await substrateExhale({
          output: responseText,
          intent: this._substrateIntent,
          userMessage: message,
          formatTarget: "chat",
        });
      } catch (err) {
        console.warn("[yo-agent] substrate exhale failed:", err);
      }
    } catch (err) {
      outcome = "error";
      if (err instanceof BudgetExceededError) {
        const msg = `Stopped — substrate budget exceeded (${err.kind}). Used ${err.state.usedTokens} tokens / ${err.state.usedToolCalls} tool calls. Try a narrower request.`;
        cb.onText(`\n\n_${msg}_\n`);
        cb.onDone(msg);
        this.patchDanglingToolUse();
      } else {
        cb.onError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      // ── Substrate reflex: persist the run so future prompts can recall it.
      try {
        substrateReflex({
          intent: this._substrateIntent,
          skillName: "yo-agent",
          chain: [...new Set(this._sendToolsUsed)],
          outcome,
          durationMs: Date.now() - startTs,
          input: message,
        });
      } catch (err) {
        console.warn("[yo-agent] substrate reflex failed:", err);
      }
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

    // MCP tools — inject into system prompt so agent always knows what it has.
    // The tool spec includes these as callable functions, but listing them here
    // makes the agent explicitly aware even if tool names are opaque.
    const toolSpec = getAgentToolSpec();
    const mcpTools = toolSpec.filter(t =>
      !t.name.startsWith("skill_") &&
      !["search_captures","get_context","format","save_memory","search_notes",
        "read_file","list_files","run_command","start_council",
        "delegate_navigate","delegate_layout","delegate_build",
        "create_skill","update_skill","read_skill",
        "create_drip","update_drip","read_drip",
        "create_layout","update_layout","read_layout",
        "create_vibe","update_vibe","read_vibe",
        "store_set","store_get","store_delete","store_list","store_query","store_info"].includes(t.name)
    );
    if (mcpTools.length > 0) {
      prompt += `\n\nCONNECTED MCP TOOLS (use these directly — do NOT use delegate_navigate for these apps):\n${mcpTools.map(t => `- ${t.name}: ${t.description}`).join("\n")}`;
    }

    // Substrate-suggested skills (think.compose) — already ranked by relevance.
    if (this._substrateComposed.length > 0) {
      prompt += `\n\nSUBSTRATE SUGGESTED SKILLS for this message (in priority order):\n${this._substrateComposed.map((s) => `- ${s}`).join("\n")}\nPrefer these via the format tool when applicable.`;
    }

    // Substrate recall — show prior run patterns so the agent learns from itself.
    if (this._substrateRecall && this._substrateRecall.patterns.length > 0) {
      const summarized = this._substrateRecall.patterns.slice(0, 5).map((p) => {
        const chain = p.skills.length > 0 ? p.skills.join("→") : "(no tools)";
        return `- ${p.outcome.toUpperCase()} | ${chain} | ${Math.round(p.durationMs / 100) / 10}s`;
      }).join("\n");
      prompt += `\n\nRECENT SIMILAR RUNS (intent=${this._substrateIntent}):\n${summarized}\nLearn from these patterns. If a chain previously failed, consider a different approach.`;
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
        tools: getAgentToolSpec(),
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
      // Substrate budget: throws BudgetExceededError if over the limit.
      // Caught by send() and rendered as a clean stop message to the user.
      this._substrateBudget?.countTokens(response.usage.inputTokens + response.usage.outputTokens);
    }

    this.history.push({ role: "assistant", content: response.content });
    if (this.aborted) { this.patchDanglingToolUse(); return; }

    const toolBlocks = response.content.filter((b: any) => b.type === "tool_use");
    // Budget: count this turn's tool calls before executing them.
    if (toolBlocks.length > 0) {
      for (let i = 0; i < toolBlocks.length; i++) {
        this._substrateBudget?.countToolCall();
      }
    }
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
            const reason = this._mode === "plan" ? "[skipped — plan mode]" : "[tool disabled by user]";
            cb.onToolResult?.(block.id, reason);
            return { type: "tool_result", tool_use_id: block.id, content: reason };
          }
          if (decision === "needs_approval" && this._approvalCallback) {
            const approved = await this._approvalCallback(block.name, block.input as Record<string, unknown>);
            if (!approved) {
              cb.onToolResult?.(block.id, "[blocked by user]");
              return { type: "tool_result", tool_use_id: block.id, content: "[blocked by user]" };
            }
          }

          const result = await this.execDelegation(block.name, block.input as Record<string, unknown>, context) || "[no output]";
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
          const reason = this._mode === "plan" ? "[skipped — plan mode]" : "[tool disabled by user]";
          cb.onToolResult?.(block.id, reason);
          results.push({ type: "tool_result", tool_use_id: block.id, content: reason });
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

        const result = await this.execDirectTool(block.name, block.input as Record<string, unknown>) || "[no output]";
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
      // Final text response — substrate critique gate. One retry max per turn,
      // and only for action-y intents where correctness > tone (do/create/iterate).
      // The streamed bytes already went out, so we honestly tell the user the
      // first attempt missed something rather than silently re-streaming.
      const shouldCritique =
        !this._critiqueAttempted &&
        fullText.trim().length >= 20 &&
        (this._substrateIntent === "do" ||
         this._substrateIntent === "create" ||
         this._substrateIntent === "iterate");

      if (shouldCritique) {
        this._critiqueAttempted = true;
        try {
          const verdict = await thinkCritique(this._currentUserMessage, fullText, this._substrateIntent);
          if (!verdict.ok && verdict.issues && verdict.issues.length > 0) {
            const issuesText = verdict.issues.map((i) => `- ${i}`).join("\n");
            const correctionNote = `\n\n_Substrate critique flagged issues — revising:_\n${issuesText}\n\n`;
            cb.onText(correctionNote);
            this.history.push({
              role: "user",
              content: `Your previous response had these issues per a self-critique:\n${issuesText}\n\nPlease revise to address them. Be concise — no need to re-explain everything, just fix the gaps.`,
            });
            await this.agentLoop(cb, iteration + 1);
            return;
          }
        } catch (err) {
          console.warn("[yo-agent] critique failed:", err);
        }
      }
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
          this.navigator.setBudget(this._substrateBudget);
          const panelList = this.navigator.listPanels();
          const enriched = panelList
            ? `${instruction}\n\nAVAILABLE APP PANELS (use scan_panel, click_element, type_text, run_command — grab_panel only as last resort):\n${panelList}`
            : instruction;
          result = await this.navigator.execute(enriched, context);
          break;
        }
        case "delegate_layout":
          this.layout.setBudget(this._substrateBudget);
          result = await this.layout.execute(instruction, context);
          break;
        case "delegate_build":
          this.builder.setBudget(this._substrateBudget);
          result = await this.builder.execute(instruction, context);
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
  // All direct tools dispatch through the substrate's unified registry.
  // Substrate handles built-in `yo.*` tools, `skill_*` user skills, and
  // `mcp__*` qualified MCP calls in one place.

  private async execDirectTool(name: string, input: Record<string, unknown>): Promise<string> {
    try {
      return await executeTool(name, input);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
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
