/**
 * YoAgent — Claude Agent SDK powered orchestrator.
 *
 * Uses sdk.query() with in-process MCP tools via createSdkMcpServer.
 * All substrate tools (search, skills, navigation, layout, etc.) are
 * registered as MCP tools. The SDK handles the agent loop, tool calling,
 * and streaming.
 */

import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { z } from "zod/v4";
import { getShellPath } from "./shell-path";
import { asarSafeQueryOptions } from "./sdk-llm";
import { getWorkingDirectory, setWorkingDirectory } from "./working-directory";

/** Working directory the right-rail .Yo agent runs in. Follows the user's
 *  workdir pick (set via the workdir bar above the input), shared with
 *  Workbench / file watchers / etc. Falls back to ~/yo only when no
 *  folder has ever been picked. */
function rightRailCwd(): string {
  const picked = getWorkingDirectory();
  if (picked) {
    try { fs.mkdirSync(picked, { recursive: true }); } catch { /* ignore */ }
    return picked;
  }
  const dir = path.join(os.homedir(), "yo");
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return dir;
}
import { promptLog } from "./prompt-log";
import { guardPrompt } from "./firewall";
import { execSync } from "child_process";
import { LLMConfig } from "./llm-config";

import { getAgentToolSpec, executeTool } from "./substrate/tools";
import { usageTracker } from "./usage-tracker";
import { usageQueue } from "./usage-queue";
import type { MemoryStore } from "./memory-store";
import type { CaptureStore } from "./capture-store";
import type { SessionCache } from "./session-cache";
import type { SkillEngine } from "./skill-engine";
import type { NoteStore } from "./note-store";
import { getAgentMode, gate } from "./action-gate";
import type { AgentMode } from "./action-gate";
import { getPreference } from "./preferences";

const dynamicImport = new Function("specifier", "return import(specifier)") as
  (specifier: string) => Promise<any>;

export type ApprovalCallback = (toolName: string, input: Record<string, unknown>) => Promise<boolean>;

export type AskQuestionOption = { label: string; description?: string };
export type AskQuestion = { question: string; header?: string; options: AskQuestionOption[]; multiSelect?: boolean };
export type AskCallback = (questions: AskQuestion[]) => Promise<Array<string | null>>;
export type PreviewCallback = (url: string) => Promise<boolean>;

export interface YoAgentCallbacks {
  onText: (delta: string) => void;
  onToolUse: (id: string, name: string, input: unknown) => void;
  onToolResult?: (id: string, detail: string) => void;
  onToolProgress?: (id: string, status: string) => void;
  /** Fires for every sub-agent lifecycle event the loop emits — Task tool
   *  spawns + their results, and (later) our saved-agent wrappers. The
   *  Workbench Sub-Agents view subscribes via the subagent:event IPC. */
  onSubAgent?: (evt: {
    id: string;
    kind: "spawn" | "token" | "result" | "error";
    source: "task" | "yo-agent";
    name?: string;
    description?: string;
    text?: string;
  }) => void;
  onDone: (fullText: string) => void;
  onError: (error: string) => void;
}

const SYSTEM_PROMPT = `You are yo — a fast, concise assistant backed by a capture store and connected tools.

RULES:
- NEVER narrate. No "Let me...", "I'll start by...", "I found...", "Here's what I can do...". Just act and respond.
- Call tools immediately. Zero preamble.
- RECALL = SEARCH THE STORE FIRST. The capture store (vector DB) holds everything the user has captured — their history, notes, prior work, conversations, decisions. For ANY question about the user's past or what you know — "history", "what did I", "find / remember / look up", "what do you know about X", "my <anything>" — your FIRST action is ALWAYS search_captures (then search_notes for exact terms). Lead with what the store returns. Only reach for shell, files, panels, or .yo/inbox if the store genuinely has nothing relevant, and say so. Never substitute a shell/file lookup for the store on a recall question.
- Responses: 1-3 sentences max unless the user asks for detail. Return actual content, not descriptions of it.
- No bullet-point alternatives. No follow-up questions unless truly stuck with zero options.
- If a tool fails or doesn't exist, say so in one sentence and stop.
- Plain text only. No markdown formatting — no headers, no bold, no bullets, no italic. Just plain sentences. Only exception: use code fences (\`\`\`) when returning actual code. Bare URLs are fine — they will be auto-linked.
- search_captures uses vector search — descriptive phrases, not keywords.
- search_notes uses keyword search — specific terms.
- web_search + web_read for live web content. Search first, then read specific URLs.
- scan_panel FIRST for element discovery. Use click_element/type_text with those selectors.
- grab_panel is EXPENSIVE (~10K tokens). Only when you need full page text.
- For workspace arrangement use split_view, grid_layout, switch_panel.
- For skills use create_skill, update_skill, read_skill.
- For data stores use store_get, store_set, store_list, store_query.
- For multi-choice questions to the user, ALWAYS use mcp__yo__ask_user_question — never the built-in AskUserQuestion. ours renders a proper "Input required" card with side-by-side code/markdown previews; the built-in is silently denied here. Provide 2–4 distinct options with short labels and one-line descriptions; mark one Recommended if you have a default. Add a "preview" markdown field when the choice is between layouts, code snippets, or mockups.`;

const CHATS_DIR = path.join(os.homedir(), "yo", "chats");

export interface ChatSummary {
  id: string;
  title: string;
  created: string;
  messageCount: number;
  /** "run" for persisted scheduled/manual task runs; undefined for normal chats. */
  type?: string;
  /** Owning skill name (run chats only). */
  skillName?: string;
}

/** A persisted task run, surfaced in the Activity view + schedule detail. */
export interface RunSummary {
  id: string;
  skillName: string;
  title: string;
  created: string;
  trigger: string;
  ok: boolean;
}

/** A persisted chat message. Assistant turns may carry the ordered
 *  tool calls that ran during them so reloaded history is complete. */
export interface ChatMessage {
  role: string;
  content: string;
  tools?: Array<{ name: string; input?: unknown }>;
}

/** Pick a short, human-readable descriptor from a tool's input so the
 *  Sub-Agents transcript can show "Read src/foo.ts" rather than raw JSON.
 *  Falls back to the first stringy field, then empty. */
function briefToolArg(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  for (const key of ["file_path", "path", "command", "pattern", "query", "url", "description", "prompt"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) {
      const s = v.trim().replace(/\s+/g, " ");
      return s.length > 80 ? `${s.slice(0, 80)}…` : s;
    }
  }
  return "";
}

export class YoAgent {
  private chatId: string | null = null;
  private chatTitle: string = "";
  // Swarm activity is appended to the active chat record so the thread
  // restores in full. Batched + debounced — a swarm emits many events.
  private _pendingSwarm: Array<{ role: string; content: string }> = [];
  private _swarmFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private llmConfig: LLMConfig | null = null;
  private memoryStore: MemoryStore | null = null;
  private captureStore: CaptureStore | null = null;
  private sessionCache: SessionCache | null = null;
  private skillEngine: SkillEngine | null = null;
  private noteStore: NoteStore | null = null;
  private abortController: AbortController | null = null;
  private _mode: AgentMode = getAgentMode();
  private _planDelivered = false;
  private _approvalCallback: ApprovalCallback | null = null;
  private _onModeChange: ((mode: AgentMode) => void) | null = null;
  private sessionId: string | null = null;
  private sdk: any = null;
  private mcpServer: any = null;

  // ── Setters ──────────────────────────────────────────────

  setLLMConfig(config: LLMConfig): void { this.llmConfig = config; }
  setMemoryStore(store: MemoryStore): void { this.memoryStore = store; }
  setCaptureStore(store: CaptureStore): void { this.captureStore = store; }
  private workspaceGetter: (() => string) | null = null;
  setWorkspaceGetter(fn: () => string): void { this.workspaceGetter = fn; }
  setSessionCache(cache: SessionCache): void { this.sessionCache = cache; }
  setSkillEngine(engine: SkillEngine): void { this.skillEngine = engine; }
  setNoteStore(store: NoteStore): void { this.noteStore = store; }
  private appsProvider: (() => Array<{ id: string; name: string }>) | null = null;
  /** Lets the agent know which apps the user has configured (for open_app). */
  setAppsProvider(fn: () => Array<{ id: string; name: string }>): void { this.appsProvider = fn; }
  getMode(): AgentMode { return this._mode; }
  setMode(mode: AgentMode): void {
    const changed = this._mode !== mode;
    this._mode = mode;
    if (changed) this.sessionId = null;
  }
  setApprovalCallback(cb: ApprovalCallback | null): void { this._approvalCallback = cb; }
  private _askCallback: AskCallback | null = null;
  setAskCallback(cb: AskCallback | null): void { this._askCallback = cb; }
  private _previewCallback: PreviewCallback | null = null;
  setPreviewCallback(cb: PreviewCallback | null): void { this._previewCallback = cb; }
  onModeChange(cb: (mode: AgentMode) => void): void { this._onModeChange = cb; }

  abort(): void {
    this.abortController?.abort();
  }

  // ── SDK initialization ─────────────────────────────────

  private async ensureSDK(): Promise<any> {
    if (!this.sdk) {
      this.sdk = await dynamicImport("@anthropic-ai/claude-agent-sdk");
    }
    return this.sdk;
  }

  private async ensureMcpServer(): Promise<any> {
    const sdk = await this.ensureSDK();
    const tools = this.buildSdkMcpTools(sdk);
    this.mcpServer = sdk.createSdkMcpServer({
      name: "yo",
      version: "1.0.0",
      tools,
      alwaysLoad: true,
    });
    return this.mcpServer;
  }

  private buildSdkMcpTools(_sdk: any): any[] {
    const toolSpecs = getAgentToolSpec();
    const substrateTools = toolSpecs.map((spec) => ({
      name: spec.name,
      description: spec.description,
      inputSchema: this.jsonSchemaToZod(spec.input_schema),
      handler: async (args: Record<string, unknown>) => {
        try {
          const result = await executeTool(spec.name, args);
          return { content: [{ type: "text" as const, text: result }] };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      },
    }));

    // Custom ask tool — mirrors Claude Code's built-in AskUserQuestion shape
    // but routes through our own renderer card (purple "Input required"). The
    // handler blocks until the user picks; the returned content goes straight
    // back into the model's next turn as the tool result.
    const askTool = {
      name: "ask_user_question",
      description: "Ask the user a multiple-choice question and wait for their answer. Use this when you need a decision from the user that's better picked from a short list than typed out. Prefer it over plain text questions when there are clear, distinct options. The user sees a purple 'Input required' card with the question and choices; their answer comes back as the tool result.",
      inputSchema: {
        questions: z.array(z.object({
          question: z.string().describe("The full question text shown to the user."),
          header: z.string().optional().describe("Optional short tag/chip shown above the question."),
          options: z.array(z.object({
            label: z.string().describe("Short label shown on the option row."),
            description: z.string().optional().describe("Subtitle explaining the option."),
            recommended: z.boolean().optional().describe("Mark one option as the recommended default. Pre-selected on render so the user can just Submit."),
            preview: z.string().optional().describe("Optional markdown preview shown side-by-side with the option list — use for code snippets, mockups, or layout comparisons that help the user choose."),
          })).min(2).max(6),
          multiSelect: z.boolean().optional().describe("Allow multiple selections (default false)."),
        })).min(1),
      },
      handler: async (args: Record<string, unknown>) => {
        const questions = (args.questions as AskQuestion[]) || [];
        if (!this._askCallback) {
          return { content: [{ type: "text" as const, text: "ask_user_question is not wired in this surface." }] };
        }
        const answers = await this._askCallback(questions);
        // Mirror the AskUserQuestion built-in's result shape — a JSON object
        // keyed by question text, value = the chosen option label (or null).
        const result: Record<string, string | null> = {};
        questions.forEach((q, i) => { result[q.question] = answers[i] ?? null; });
        return { content: [{ type: "text" as const, text: JSON.stringify({ answers: result }, null, 2) }] };
      },
    };

    // preview_url — show a URL in the Workbench Preview slot. Same routing
    // pattern as plan: agent calls the tool; host attaches a BrowserView at
    // the active Preview slot's bounds.
    const previewTool = {
      name: "preview_url",
      description: "Show a URL in the user's Workbench Preview panel (e.g. a local dev server, a docs page, the app you just built). Use this instead of opening a new browser panel — the URL appears inline alongside the user's code, not floating over the workspace. If no Preview panel is open, the user sees a hint to add one.",
      inputSchema: {
        url: z.string().describe("HTTP/HTTPS/file URL to load in the preview."),
      },
      handler: async (args: Record<string, unknown>) => {
        const url = String(args.url ?? "").trim();
        if (!url) return { content: [{ type: "text" as const, text: "Error: url is required" }], isError: true };
        if (!this._previewCallback) {
          return { content: [{ type: "text" as const, text: "Preview is not wired in this surface." }] };
        }
        const ok = await this._previewCallback(url);
        return { content: [{ type: "text" as const, text: ok ? `Preview set to ${url}` : `No Workbench Preview panel is open. Tell the user to add one (Workbench app → split → Preview view).` }] };
      },
    };

    return [...substrateTools, askTool, previewTool];
  }

  private jsonSchemaToZod(schema: Record<string, unknown>): Record<string, any> {
    const props = (schema.properties || {}) as Record<string, any>;
    const required = new Set((schema.required || []) as string[]);
    const shape: Record<string, any> = {};

    for (const [key, prop] of Object.entries(props)) {
      let field: any;
      switch (prop.type) {
        case "string":
          field = z.string();
          if (prop.enum) field = z.enum(prop.enum);
          break;
        case "number":
          field = z.number();
          break;
        case "boolean":
          field = z.boolean();
          break;
        case "array":
          field = z.array(z.any());
          break;
        case "object":
          field = z.record(z.string(), z.any());
          break;
        default:
          field = z.any();
      }
      if (!required.has(key)) {
        field = field.optional();
      }
      shape[key] = field;
    }

    return shape;
  }

  // ── Send (public API) ──────────────────────────────────

  /**
   * Run a prompt headlessly through the full agent (tools + MCP, multi-turn)
   * and return the final text. Used by scheduled / manual task runs so a task
   * like "read my email and summarize" actually has tools — unlike the skill
   * engine's plain single-turn completion. Does NOT touch the active chat
   * (chatId/sessionId/title) so the user's live conversation is untouched.
   */
  async runForResult(prompt: string): Promise<{ text: string; error?: string }> {
    let sdk: any;
    try { sdk = await this.ensureSDK(); }
    catch (err: any) { return { text: "", error: `Failed to load agent SDK: ${err?.message || err}` }; }

    let mcpServer: any;
    try { mcpServer = await this.ensureMcpServer(); }
    catch (err: any) { return { text: "", error: `Failed to initialize MCP tools: ${err?.message || err}` }; }

    const shellPath = getShellPath();
    const model = this.llmConfig?.model || "claude-sonnet-4-6";
    const options: Record<string, any> = {
      model,
      maxTurns: getPreference<number>("maxTurns", 200),
      ...asarSafeQueryOptions(rightRailCwd()),
      // Headless: no UI to approve tool calls, so bypass permissions.
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      // Built-in Claude Code tools (Read/Edit/Bash/Grep/…) plus our MCP tools.
      tools: { type: "preset", preset: "claude_code" },
      mcpServers: { "yo": mcpServer },
      systemPrompt: this.buildSystemPrompt(),
      includePartialMessages: true,
      env: {
        ...process.env,
        PATH: shellPath,
        CLAUDE_AGENT_SDK_CLIENT_APP: "yosup/3.0.0",
      },
    };

    let text = "";
    try {
      const gen = sdk.query({ prompt, options });
      for await (const msg of gen) {
        if (msg.type === "stream_event") {
          const event = msg.event;
          if (event?.type === "content_block_delta") {
            const delta = (event as any).delta;
            if (delta?.type === "text_delta" && delta.text) text += delta.text;
          }
        } else if (msg.type === "result") {
          if (msg.usage) this.reportUsage(msg.usage.input_tokens || 0, msg.usage.output_tokens || 0, model);
          if (msg.is_error && msg.result) return { text, error: msg.result };
        }
      }
    } catch (err: any) {
      return { text, error: err?.message || String(err) };
    }
    return { text: text.trim() };
  }

  async send(message: string, cb: YoAgentCallbacks): Promise<void> {
    const balance = usageQueue.lastBalance;
    if (balance !== null && balance <= 0) {
      cb.onError("You're out of yos. Top up your balance to continue using the agent.");
      return;
    }

    // Prompt-injection firewall.
    const guard = guardPrompt(message, "yo-agent");
    if (!guard.allowed) {
      cb.onError(`Message blocked by prompt-injection firewall: ${guard.reason}`);
      return;
    }

    // Plan mode auto-exit: if agent already delivered a plan (previous turn
    // set planDelivered), the user's next message is implicit approval.
    if (this._mode === "plan" && this._planDelivered) {
      this._mode = "default";
      this._planDelivered = false;
      this._onModeChange?.("default");
    }

    if (!this.chatTitle) {
      this.chatTitle = message.slice(0, 80).replace(/\n/g, " ").trim();
    }
    if (!this.chatId) {
      this.chatId = `${Date.now()}`;
    }

    // Pre-flight: if Claude Code creds are missing, pop the in-app
    // OAuth window so the user can sign in without leaving yo-client.
    // Abort this turn — once they finish the sign-in, the next message
    // succeeds against the freshly-written creds.
    {
      const { ensureCcAuth } = await import("./cc-bootstrap");
      // ensureCcAuth() pops the gating modal in the renderer if creds
      // are missing; we just need to abort this call. The user will be
      // unblocked once they finish the sign-in shown on screen.
      if (!ensureCcAuth()) return;
    }

    let sdk: any;
    try {
      sdk = await this.ensureSDK();
    } catch (err: any) {
      cb.onError(`Failed to load .Yo agent SDK: ${err.message}`);
      return;
    }

    let mcpServer: any;
    try {
      mcpServer = await this.ensureMcpServer();
    } catch (err: any) {
      cb.onError(`Failed to initialize MCP tools: ${err.message}`);
      return;
    }

    this.abortController = new AbortController();
    const shellPath = getShellPath();

    const model = this.llmConfig?.model || "claude-sonnet-4-6";
    const isBypass = this._mode === "bypassPermissions";
    const options: Record<string, any> = {
      model,
      maxTurns: getPreference<number>("maxTurns", 200),
      // The right-rail .Yo agent always runs at ~/yo/ — it spans every
      // folder the user touches and does not follow per-app folder picks.
      ...asarSafeQueryOptions(rightRailCwd()),
      permissionMode: isBypass ? "bypassPermissions" : this._mode,
      allowDangerouslySkipPermissions: isBypass,
      ...(isBypass ? {} : {
        canUseTool: async (toolName: string, input: Record<string, unknown>) => {
          const decision = gate(toolName, this._mode);
          if (decision === "execute") return { behavior: "allow", updatedInput: input };
          if (decision === "skip") return { behavior: "deny", message: `Tool "${toolName}" denied by mode "${this._mode}".` };
          const approved = this._approvalCallback
            ? await this._approvalCallback(toolName, input)
            : false;
          return approved
            ? { behavior: "allow", updatedInput: input }
            : { behavior: "deny", message: "User denied tool call." };
        },
      }),
      // Built-in Claude Code tools (Read/Edit/Bash/Grep/…) plus our MCP tools.
      // Permission gating is handled by canUseTool / permissionMode above.
      tools: { type: "preset", preset: "claude_code" },
      // Remove the SDK's native AskUserQuestion from the model's context so it
      // CANNOT be called — the model kept reaching for it despite the system
      // prompt, and the native tool renders as a dead JSON card (no wizard,
      // no answer routing). With it gone the model falls back to our
      // mcp__yo__ask_user_question, which drives the composer wizard.
      disallowedTools: ["AskUserQuestion"],
      mcpServers: { "yo": mcpServer },
      systemPrompt: this.buildSystemPrompt(),
      abortController: this.abortController,
      includePartialMessages: true,
      // Forward sub-agent (Task / call_agent) text + thinking as assistant/user
      // messages tagged with parent_tool_use_id. Without this the SDK only
      // emits the sub-agent's tool_use/tool_result blocks, so the Workbench
      // Sub-Agents panel can't show a live transcript. We route every parented
      // message to cb.onSubAgent({ kind: "token" }) below.
      forwardSubagentText: true,
      persistSession: true,
      todoFeatureEnabled: true,
      // Phase 4 of THE-PIVOT-BYOK: SDK calls api.anthropic.com directly
      // using the user's Claude Code OAuth creds at ~/.claude/.credentials.json
      // (or platform equivalent). yo-server is no longer in the inference
      // path. ANTHROPIC_API_KEY / BASE_URL deliberately NOT set so the SDK
      // auto-discovers the CC credentials.
      env: {
        ...process.env,
        PATH: shellPath,
        CLAUDE_AGENT_SDK_CLIENT_APP: "yosup/3.0.0",
      },
    };

    if (this.sessionId) {
      options.resume = this.sessionId;
    }

    let fullText = "";
    const startTs = Date.now();
    let totalInput = 0;
    let totalOutput = 0;
    const toolsUsed = new Set<string>();
    // Full, ordered tool calls for this turn — persisted with the
    // assistant message so reloaded history shows the complete run
    // (not just the final answer text).
    const turnTools: Array<{ name: string; input?: unknown }> = [];
    // Tool-use blocks tracked by streaming index for the current assistant
    // message. Emitting onToolUse from the streaming events (in block order)
    // — rather than from the buffered `assistant` message that lands at
    // message-end — keeps tool rows interleaved with text in true stream
    // order. Keyed by content-block index; reset at each message_start.
    let toolBlocks = new Map<number, { id: string; name: string; inputJson: string }>();
    // Parent tool-use ids whose sub-agent text already arrived via partial
    // stream events this message, so the buffered assistant message can skip
    // re-emitting it. forwardSubagentText forwards sub-agent turns as buffered
    // assistant/user messages; whether partials are *also* emitted per
    // sub-agent isn't guaranteed, so we cover both paths and dedup here.
    const subAgentStreamed = new Set<string>();

    try {
      const gen = sdk.query({ prompt: message, options });

      for await (const msg of gen) {
        if (this.abortController.signal.aborted) break;

        switch (msg.type) {
          case "system":
            if (msg.subtype === "init" && msg.session_id) {
              this.sessionId = msg.session_id;
            }
            break;

          case "assistant": {
            const content = msg.message?.content;
            if (!Array.isArray(content)) break;
            const asstParentId = (msg as any).parent_tool_use_id as string | null | undefined;
            if (asstParentId) {
              // Buffered sub-agent message (forwardSubagentText). Surface its
              // text + tool calls in the Sub-Agents panel transcript. Text is
              // emitted here UNLESS it already streamed token-by-token via
              // stream_event above (dedup), so it shows up exactly once whether
              // or not the SDK emits partials per sub-agent.
              const alreadyStreamed = subAgentStreamed.has(asstParentId);
              for (const block of content as any[]) {
                if (block.type === "text" && block.text) {
                  if (!alreadyStreamed) {
                    cb.onSubAgent?.({ id: asstParentId, kind: "token", source: "task", text: block.text });
                  }
                } else if (block.type === "thinking" && block.thinking) {
                  if (!alreadyStreamed) {
                    cb.onSubAgent?.({ id: asstParentId, kind: "token", source: "task", text: block.thinking });
                  }
                } else if (block.type === "tool_use") {
                  const arg = briefToolArg(block.input);
                  cb.onSubAgent?.({
                    id: asstParentId,
                    kind: "token",
                    source: "task",
                    text: `\n\n→ ${block.name}${arg ? ` ${arg}` : ""}\n`,
                  });
                }
              }
              subAgentStreamed.delete(asstParentId);
              break;
            }
            for (const block of content) {
              if (block.type === "tool_use") {
                if (block.name === "TodoWrite" && Array.isArray((block.input as any)?.todos)) {
                  this._lastTodos = (block.input as any).todos;
                }
                toolsUsed.add(block.name);
                turnTools.push({ name: block.name, input: block.input });
                // NOTE: cb.onToolUse is emitted from the streaming events
                // (content_block_stop) so tool rows interleave with text in
                // true stream order. The buffered `assistant` message lands at
                // message-end and would push every tool row below the text.
                // The side effects below still read the fully-formed block
                // input here (order-insensitive: they hit other views/files).
                // The SDK's internal sub-agent tool. Surface it in the Workbench
                // Sub-Agents view as a new tab; the result closes the tab via
                // "result" below. NOTE: the @anthropic-ai/claude-agent-sdk names
                // this tool "Agent" (older Claude Code called it "Task") — match
                // both so the panel actually spawns. This was the bug where the
                // panel showed "No sub-agents running" forever: we only matched
                // "Task" but the SDK emits "Agent".
                if (block.name === "Agent" || block.name === "Task") {
                  const taskInput = (block.input as { description?: string; prompt?: string; subagent_type?: string }) || {};
                  cb.onSubAgent?.({
                    id: block.id,
                    kind: "spawn",
                    source: "task",
                    name: taskInput.subagent_type || (taskInput.description?.slice(0, 40)) || "agent",
                    description: taskInput.prompt || taskInput.description,
                  });
                }
                // mcp__yo__call_agent / create_swarm surface in the Workbench
                // Sub-Agents view too, but the panel tab + live transcript are
                // driven by the swarm lifecycle in main.ts (runSwarm spawns a
                // tab per roster agent keyed `swarm:<agentId>`, and the cypher
                // bus streams each agent's activity into it). We deliberately
                // do NOT spawn a tab here keyed by this tool_use_id — that
                // would create an empty duplicate that never receives tokens,
                // since the agent's work runs in the swarm process, not under
                // this top-level tool block.
                // ExitPlanMode — Claude Code's canonical plan-mode artifact
                // hook. The agent calls it with { plan: "..." } when planning
                // finishes; we route that markdown straight to .yo/plan.md so
                // the Workbench Plan slot renders it automatically (same
                // pattern Claude Code Desktop uses to surface plans in its
                // plan panel — the host watches a known path).
                if (block.name === "ExitPlanMode") {
                  const planText = (block.input as { plan?: string } | null)?.plan || "";
                  if (planText.trim()) {
                    try {
                      const planDir = path.join(rightRailCwd(), ".yo");
                      fs.mkdirSync(planDir, { recursive: true });
                      fs.writeFileSync(path.join(planDir, "plan.md"), planText, { mode: 0o600 });
                    } catch { /* ignore — best-effort */ }
                  }
                }
              }
            }
            break;
          }

          case "stream_event": {
            const event = msg.event as any;
            if (!event) break;
            const subParentId = (msg as any).parent_tool_use_id as string | null | undefined;
            if (subParentId) {
              // Sub-agent streaming text → live tokens in the Sub-Agents panel
              // (only when the SDK emits partials per sub-agent). We mark the
              // parent as "streamed" so the buffered assistant message below
              // doesn't re-emit the same text. Tool blocks are surfaced from
              // the buffered message (formatted, in order), and we keep the
              // sub-agent out of the top-level toolBlocks index space.
              if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
                cb.onSubAgent?.({ id: subParentId, kind: "token", source: "task", text: event.delta.text });
                subAgentStreamed.add(subParentId);
              }
              break;
            }
            if (event.type === "message_start") {
              // New assistant message — block indices restart at 0.
              toolBlocks = new Map();
            } else if (event.type === "content_block_start") {
              const block = event.content_block;
              if (block?.type === "tool_use") {
                toolBlocks.set(event.index, { id: block.id, name: block.name, inputJson: "" });
              }
            } else if (event.type === "content_block_delta") {
              const delta = event.delta;
              if (delta?.type === "text_delta" && delta.text) {
                fullText += delta.text;
                cb.onText(delta.text);
              } else if (delta?.type === "input_json_delta") {
                const tb = toolBlocks.get(event.index);
                if (tb) tb.inputJson += delta.partial_json || "";
              }
            } else if (event.type === "content_block_stop") {
              // A tool-use block just finished streaming. Emit it now, in
              // stream order, so its row lands before any text that follows.
              const tb = toolBlocks.get(event.index);
              if (tb) {
                let input: unknown = {};
                try { input = tb.inputJson ? JSON.parse(tb.inputJson) : {}; } catch { /* partial/empty — keep {} */ }
                cb.onToolUse(tb.id, tb.name, input);
                toolBlocks.delete(event.index);
              }
            }
            break;
          }

          case "user": {
            const content = msg.message?.content;
            if (!Array.isArray(content)) break;
            const userParentId = (msg as any).parent_tool_use_id as string | null | undefined;
            for (const block of content as any[]) {
              if (block.type === "tool_result" && block.tool_use_id) {
                const text = typeof block.content === "string"
                  ? block.content
                  : Array.isArray(block.content)
                    ? block.content.map((c: any) => c.text || "").join("")
                    : "";
                if (userParentId) {
                  // A sub-agent's OWN internal tool result. Surface a short
                  // confirmation in its transcript — do NOT close the parent
                  // tab (that happens when the top-level Task tool_result lands
                  // below, with parent_tool_use_id === null).
                  const trimmed = text.trim();
                  if (trimmed) {
                    cb.onSubAgent?.({
                      id: userParentId,
                      kind: "token",
                      source: "task",
                      text: `   ✓ ${trimmed.slice(0, 160).replace(/\s+/g, " ")}\n`,
                    });
                  }
                  continue;
                }
                cb.onToolResult?.(block.tool_use_id, text.slice(0, 500));
                // Close out any sub-agent tab keyed by this tool_use_id (Task
                // tool or mcp__yo__call_agent). The Sub-Agents view ignores
                // events with unknown ids, so emitting unconditionally is safe.
                cb.onSubAgent?.({
                  id: block.tool_use_id,
                  kind: "result",
                  source: "task",
                  text,
                });
              }
            }
            break;
          }

          case "tool_progress": {
            cb.onToolProgress?.(msg.tool_use_id, msg.tool_name?.replace(/_/g, " ") || "working");
            break;
          }

          case "result": {
            const usage = msg.usage;
            if (usage) {
              totalInput += usage.input_tokens || 0;
              totalOutput += usage.output_tokens || 0;
              usageTracker.record("orchestrator", {
                inputTokens: usage.input_tokens || 0,
                outputTokens: usage.output_tokens || 0,
              });
              this.reportUsage(usage.input_tokens || 0, usage.output_tokens || 0, model);
            }
            if (msg.is_error && msg.result) {
              if (this.abortController?.signal.aborted || /abort/i.test(msg.result)) break;
              cb.onError(msg.result);
              return;
            }
            break;
          }
        }
      }

      // Mark that the plan was delivered — next user message triggers transition.
      if (this._mode === "plan") {
        this._planDelivered = true;
      }

      // Save chat record
      this.saveChatRecord(message, fullText, startTs, turnTools);

      promptLog.record({
        id: `${startTs}-${Math.random().toString(36).slice(2, 8)}`,
        startTs,
        endTs: Date.now(),
        prompt: message.slice(0, 2000),
        response: fullText.slice(0, 2000),
        inputTokens: totalInput,
        outputTokens: totalOutput,
        model,
        provider: "anthropic",
        mode: this._mode,
        toolsUsed: [...toolsUsed],
      });

      // Ingest structured turn into capture store
      if (this.captureStore && fullText.trim()) {
        const structured = this.buildStructuredCapture(message, fullText);
        this.captureStore.ingest("yo-agent", structured, this.workspaceGetter?.()).catch(() => {});
      }

      cb.onDone(fullText);
    } catch (err: any) {
      // Treat anything abort-flavored as a clean stop. AbortError is the
      // standard signal, but the SDK also surfaces text-only abort messages
      // ("process aborted by user", "aborted") that aren't AbortError
      // instances — those used to leak into the panel as red error rows.
      const msg: string = err?.message || String(err || "");
      const isAbort = err?.name === "AbortError" || /\b(abort(ed)?|cancell?ed)\b/i.test(msg);
      if (isAbort) {
        cb.onDone(fullText);
      } else {
        cb.onError(msg);
      }
    }
  }

  getLastResponse(): string {
    return "";
  }

  getChatId(): string | null { return this.chatId; }
  getChatTitle(): string { return this.chatTitle; }

  // ── Structured capture ─────────────────────────────────

  private _lastTodos: Array<{ content: string; status: string }> = [];

  updateTodos(todos: Array<{ content: string; status: string }>): void {
    this._lastTodos = todos;
  }

  private buildStructuredCapture(userMessage: string, assistantText: string): string {
    const meta: string[] = [];
    if (this.chatId) meta.push(`chatId: ${this.chatId}`);
    if (this.sessionId) meta.push(`sessionId: ${this.sessionId}`);
    if (this.chatTitle) meta.push(`intent: ${this.chatTitle}`);
    if (this._lastTodos.length > 0) {
      const progress = this._lastTodos.map((t) => {
        const icon = t.status === "completed" ? "✓" : t.status === "in_progress" ? "→" : "○";
        return `${icon} ${t.content}`;
      }).join("\n");
      meta.push(`progress:\n${progress}`);
    }
    const header = meta.length > 0 ? `[meta]\n${meta.join("\n")}\n\n` : "";
    return `${header}[user]\n${userMessage}\n\n[assistant]\n${assistantText}`;
  }

  // ── System prompt builder ────────────────────���─────────

  private buildSystemPrompt(): { type: "preset"; preset: "claude_code"; append?: string } {
    // Stock Claude Code behavior. The only thing we ever append is the
    // context-recovery block when resuming a chat without a live SDK session
    // — without it the model has zero memory of prior turns in this thread.
    if (this.chatId && !this.sessionId) {
      const context = this.buildContextRecovery();
      if (context) return { type: "preset", preset: "claude_code", append: context };
    }
    return { type: "preset", preset: "claude_code" };
  }

  private buildContextRecovery(): string | null {
    if (!this.chatId) return null;
    const filepath = path.join(CHATS_DIR, `${this.chatId}.md`);
    if (!fs.existsSync(filepath)) return null;
    try {
      const raw = fs.readFileSync(filepath, "utf-8");
      const jsonMatch = raw.match(/```json\n([\s\S]*?)\n```/);
      if (!jsonMatch) return null;
      const all: Array<{ role: string; content: string }> = JSON.parse(jsonMatch[1]);
      // Only the actual conversation feeds context recovery — swarm-activity
      // entries are thread history, not turns the model should replay.
      const messages = all.filter((m) => m.role === "user" || m.role === "assistant");
      if (messages.length === 0) return null;
      // Take last 6 messages (3 exchanges) for context window efficiency
      const recent = messages.slice(-6);
      const summary = recent.map((m) => {
        const tag = m.role === "user" ? "User" : "You";
        const text = m.content.length > 500 ? m.content.slice(0, 500) + "..." : m.content;
        return `${tag}: ${text}`;
      }).join("\n\n");
      return `CONTINUED CONVERSATION — this thread was resumed. Recent context:\n${summary}`;
    } catch {
      return null;
    }
  }

  // ── Usage reporting ────────────────────────────────────

  private reportUsage(inputTokens: number, outputTokens: number, model: string): void {
    // Client sends raw tokens — server is the authority on yos calculation
    usageQueue.enqueue({
      inputTokens,
      outputTokens,
      model,
      yosConsumed: 0,
      agent: "orchestrator",
    });
  }

  // ── Chat management ────────────────────────────────────

  clear(): void {
    // Flush buffered swarm activity into the outgoing chat before we drop it.
    this.flushSwarmEntries();
    this.sessionId = null;
    this.chatId = null;
    this.chatTitle = "";
    this.mcpServer = null;
  }

  loadChat(id: string): Array<{ role: string; text: string; tools?: Array<{ name: string; input?: unknown }> }> | null {
    const filepath = path.join(CHATS_DIR, `${id}.md`);
    if (!fs.existsSync(filepath)) return null;
    try {
      const raw = fs.readFileSync(filepath, "utf-8");
      const parsed = this.parseChatFile(raw);
      this.chatId = id;
      this.chatTitle = parsed.title;
      this.sessionId = parsed.sessionId || null;
      this._planDelivered = false;
      // Restore the chat's working directory if it still exists, so the
      // agent + files view re-point to the same folder.
      if (parsed.workingDirectory && fs.existsSync(parsed.workingDirectory)) {
        setWorkingDirectory(parsed.workingDirectory);
      }
      return parsed.display;
    } catch {
      return null;
    }
  }

  listChats(): ChatSummary[] {
    fs.mkdirSync(CHATS_DIR, { recursive: true });
    try {
      // Recents = real conversations only. Scheduled/manual task runs
      // (run-*.md) are surfaced in the Scheduled section via runsList, not here.
      const files = fs.readdirSync(CHATS_DIR)
        .filter((f) => f.endsWith(".md") && !f.startsWith("run-"));

      const summaries = files.map((f) => {
        try {
          const raw = fs.readFileSync(path.join(CHATS_DIR, f), "utf-8");
          const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
          let title = f.replace(/\.md$/, "");
          let created = "";
          let messageCount = 0;
          let type: string | undefined;
          let skillName: string | undefined;
          if (fmMatch) {
            const fm = fmMatch[1];
            const t = fm.match(/^title:\s*(.+)$/m);
            if (t) title = t[1].trim();
            const c = fm.match(/^created:\s*(.+)$/m);
            if (c) created = c[1].trim();
            const m = fm.match(/^messages:\s*(\d+)$/m);
            if (m) messageCount = parseInt(m[1], 10);
            const ty = fm.match(/^type:\s*(.+)$/m);
            if (ty) type = ty[1].trim();
            const sk = fm.match(/^skillName:\s*(.+)$/m);
            if (sk) skillName = sk[1].trim();
          }
          return { id: f.replace(/\.md$/, ""), title, created, messageCount, type, skillName };
        } catch {
          return { id: f.replace(/\.md$/, ""), title: f, created: "", messageCount: 0 };
        }
      });
      // Newest first by actual created timestamp (ISO strings sort lexically).
      summaries.sort((a, b) => (b.created || "").localeCompare(a.created || ""));
      return summaries;
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

  /** Delete all persisted run-*.md chats for a given task/skill name. */
  deleteRunsForSkill(skillName: string): number {
    let removed = 0;
    try {
      for (const f of fs.readdirSync(CHATS_DIR).filter((f) => f.startsWith("run-") && f.endsWith(".md"))) {
        try {
          const raw = fs.readFileSync(path.join(CHATS_DIR, f), "utf-8");
          const m = raw.match(/^skillName:\s*(.+)$/m);
          if (m && m[1].trim() === skillName) { fs.unlinkSync(path.join(CHATS_DIR, f)); removed++; }
        } catch { /* skip */ }
      }
    } catch { /* no dir */ }
    return removed;
  }

  /**
   * Persist a completed task run as a special `type: run` chat so it can be
   * opened in the agent panel and listed in Activity / the schedule detail.
   * Lives in CHATS_DIR alongside chats but is filtered out of Recents.
   */
  saveRunChat(opts: {
    skillName: string;
    trigger: string;
    output?: unknown;
    error?: string;
    startedAt: number;
    instructions?: string;
  }): string {
    fs.mkdirSync(CHATS_DIR, { recursive: true });
    const id = `run-${opts.startedAt}-${crypto.randomBytes(3).toString("hex")}`;
    const label = opts.trigger === "schedule" ? "Ran scheduled task" : "Ran task";
    const outText = opts.error
      ? `**Run failed**\n\n${opts.error}`
      : (typeof opts.output === "string" ? opts.output : "```json\n" + JSON.stringify(opts.output ?? null, null, 2) + "\n```");
    const messages: ChatMessage[] = [
      { role: "run", content: label, tools: [{ name: opts.skillName }] },
      ...(opts.instructions ? [{ role: "user", content: opts.instructions } as ChatMessage] : []),
      { role: "assistant", content: outText },
    ];
    const startedIso = new Date(Number.isFinite(opts.startedAt) ? opts.startedAt : Date.now()).toISOString();
    const lines = [
      "---",
      `title: ${opts.skillName}`,
      `created: ${startedIso}`,
      `messages: 1`,
      `type: run`,
      `skillName: ${opts.skillName}`,
      `trigger: ${opts.trigger}`,
      ...(opts.error ? ["status: error"] : ["status: ok"]),
      "---",
      "",
      "```json",
      JSON.stringify(messages, null, 2),
      "```",
    ];
    fs.writeFileSync(path.join(CHATS_DIR, `${id}.md`), lines.join("\n"), "utf-8");
    // Keep run history bounded — prune oldest run files beyond a cap.
    this.pruneRuns();
    return id;
  }

  /** Read a single run's display messages without making it the active chat. */
  getRun(id: string): { title: string; messages: Array<{ role: string; text: string; tools?: Array<{ name: string; input?: unknown }> }> } | null {
    const filepath = path.join(CHATS_DIR, `${id}.md`);
    if (!fs.existsSync(filepath)) return null;
    try {
      const parsed = this.parseChatFile(fs.readFileSync(filepath, "utf-8"));
      return { title: parsed.title, messages: parsed.display };
    } catch { return null; }
  }

  /** List persisted task runs (optionally for one skill), newest first. */
  listRuns(skillName?: string): RunSummary[] {
    fs.mkdirSync(CHATS_DIR, { recursive: true });
    try {
      return fs.readdirSync(CHATS_DIR)
        .filter((f) => f.startsWith("run-") && f.endsWith(".md"))
        .map((f) => {
          const raw = fs.readFileSync(path.join(CHATS_DIR, f), "utf-8");
          const fm = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] || "";
          const get = (k: string) => fm.match(new RegExp(`^${k}:\\s*(.+)$`, "m"))?.[1].trim() || "";
          return {
            id: f.replace(/\.md$/, ""),
            skillName: get("skillName") || get("title"),
            title: get("title"),
            created: get("created"),
            trigger: get("trigger") || "manual",
            ok: get("status") !== "error",
          } as RunSummary;
        })
        .filter((r) => !skillName || r.skillName === skillName)
        .sort((a, b) => (b.created || "").localeCompare(a.created || ""));
    } catch { return []; }
  }

  /** Cap stored run files (keep the newest 100). */
  private pruneRuns(): void {
    try {
      const runs = fs.readdirSync(CHATS_DIR).filter((f) => f.startsWith("run-") && f.endsWith(".md")).sort();
      const excess = runs.length - 100;
      for (let i = 0; i < excess; i++) {
        try { fs.unlinkSync(path.join(CHATS_DIR, runs[i])); } catch {}
      }
    } catch {}
  }

  // ── Persistence ────────────────────────────────────────

  /** Read the message array out of the current chat's .md file. */
  private readChatMessages(): ChatMessage[] {
    if (!this.chatId) return [];
    const filepath = path.join(CHATS_DIR, `${this.chatId}.md`);
    if (!fs.existsSync(filepath)) return [];
    try {
      const raw = fs.readFileSync(filepath, "utf-8");
      const m = raw.match(/```json\n([\s\S]*?)\n```/);
      return m ? JSON.parse(m[1]) : [];
    } catch { return []; }
  }

  /** Write the message array back, regenerating frontmatter. */
  private writeChatFile(messages: ChatMessage[]): void {
    if (!this.chatId) return;
    fs.mkdirSync(CHATS_DIR, { recursive: true });
    const userMsgs = messages.filter((m) => m.role === "user").length;
    // chatId is usually a Date.now() string, but a loaded chat can carry a
    // non-numeric id (e.g. "run-…") — guard so toISOString() never throws
    // "Invalid time value".
    const createdTs = parseInt(this.chatId, 10);
    const createdIso = new Date(Number.isFinite(createdTs) ? createdTs : Date.now()).toISOString();
    const lines = [
      "---",
      `title: ${this.chatTitle}`,
      `created: ${createdIso}`,
      `messages: ${userMsgs}`,
      // Capture the folder this chat works in so reopening it restores
      // the same context (agent cwd + files view).
      `workingDirectory: ${getWorkingDirectory()}`,
      ...(this.sessionId ? [`sessionId: ${this.sessionId}`] : []),
      "---",
      "",
      "```json",
      JSON.stringify(messages, null, 2),
      "```",
    ];
    fs.writeFileSync(path.join(CHATS_DIR, `${this.chatId}.md`), lines.join("\n"), "utf-8");
  }

  private saveChatRecord(
    userMessage: string,
    assistantText: string,
    _startTs: number,
    tools?: Array<{ name: string; input?: unknown }>,
  ): void {
    if (!this.chatId) return;
    const existing = this.readChatMessages();
    existing.push({ role: "user", content: userMessage });
    // Persist the assistant turn even when it produced no text, so a
    // tool-only turn still shows its tool timeline on reload.
    if (assistantText || (tools && tools.length > 0)) {
      const msg: ChatMessage = { role: "assistant", content: assistantText };
      if (tools && tools.length > 0) msg.tools = tools;
      existing.push(msg);
    }
    this.writeChatFile(existing);
    // Swarm activity that fired during this turn belongs after it — flush now
    // so the buffered entries are appended in chronological order.
    this.flushSwarmEntries();
  }

  /**
   * Append a swarm-activity entry (kind "swarm" or "swarm-start") to the
   * active chat so the thread restores in full. Buffered + debounced.
   */
  appendSwarmEntry(role: "swarm" | "swarm-start", content: string): void {
    if (!this.chatId) return;
    this._pendingSwarm.push({ role, content });
    if (!this._swarmFlushTimer) {
      this._swarmFlushTimer = setTimeout(() => {
        this._swarmFlushTimer = null;
        this.flushSwarmEntries();
      }, 1500);
    }
  }

  private flushSwarmEntries(): void {
    if (this._swarmFlushTimer) { clearTimeout(this._swarmFlushTimer); this._swarmFlushTimer = null; }
    if (!this.chatId || this._pendingSwarm.length === 0) return;
    const pending = this._pendingSwarm.splice(0);
    const existing = this.readChatMessages();
    existing.push(...pending);
    this.writeChatFile(existing);
  }

  private parseChatFile(raw: string): {
    title: string;
    sessionId: string | null;
    workingDirectory: string | null;
    display: Array<{ role: string; text: string; tools?: Array<{ name: string; input?: unknown }> }>;
  } {
    let title = "";
    let sessionId: string | null = null;
    let workingDirectory: string | null = null;
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const t = fmMatch[1].match(/^title:\s*(.+)$/m);
      if (t) title = t[1].trim();
      const s = fmMatch[1].match(/^sessionId:\s*(.+)$/m);
      if (s) sessionId = s[1].trim();
      const w = fmMatch[1].match(/^workingDirectory:\s*(.+)$/m);
      if (w) workingDirectory = w[1].trim();
    }

    const jsonMatch = raw.match(/```json\n([\s\S]*?)\n```/);
    let messages: ChatMessage[] = [];
    if (jsonMatch) {
      try { messages = JSON.parse(jsonMatch[1]); } catch {}
    }

    // Carry tools through so the renderer can replay the tool timeline.
    const display = messages.map((m) => ({
      role: m.role,
      text: m.content || "",
      ...(m.tools && m.tools.length > 0 ? { tools: m.tools } : {}),
    }));

    return { title, sessionId, workingDirectory, display };
  }
}
