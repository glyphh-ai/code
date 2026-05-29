/**
 * Interactive Agent — one engine instance per yo://agent panel.
 *
 * Built as a parallel, simpler path to agent-runner.ts (which is geared
 * for cypher-slot lifecycle, broadcasts, idle timers, etc.). This module
 * is the one used by yo://agent: a single user chats with a single
 * configured agent in a panel.
 *
 * Per-instance state keyed by `instanceId` (panel webview id). Each
 * instance streams events on per-id channels so multiple agent panels
 * coexist without crosstalk:
 *   agent:<id>:token       — text delta
 *   agent:<id>:tool-use    — tool call started
 *   agent:<id>:tool-result — tool call returned
 *   agent:<id>:done        — turn complete
 *   agent:<id>:error       — turn failed
 */

import { ipcMain, type WebContents } from "electron";
import * as fs from "fs/promises";
import * as path from "path";
import { asarSafeQueryOptions } from "./sdk-llm";
import { getShellPath } from "./shell-path";
import { getPreference } from "./stores/preferences-db";
import { getAgent, ensureDefaultAgent, saveAgent, type AgentConfig } from "./agent-store";
import { addRecent } from "./working-directory";
import { gate } from "./action-gate";

export type PermMode = "default" | "plan" | "acceptEdits" | "bypassPermissions";

export interface InteractiveStartOpts {
  instanceId: string;          // unique per panel webview
  agentSlug: string;           // ~/yo/agents/<slug>/agent.json
  cwd: string;                 // working directory
}

interface RunningInstance {
  instanceId: string;
  agentSlug: string;
  cwd: string;
  sessionId: string | null;
  abortController: AbortController | null;
  webContents: WeakRef<WebContents>;
  /** Pending multi-choice asks keyed by askId. Resolved when the renderer
   *  posts agent:ask-resolve. The workflow engine awaits the promise to
   *  decide what to do next (advance phase, edit, abort, etc). */
  pendingAsks: Map<string, (value: string | null) => void>;
  /** Pending per-tool approvals keyed by approvalId. Triggered when perm
   *  mode is "ask" (default) or "auto" and the tool needs gating. The
   *  renderer shows the approval prompt and resolves via the
   *  agent:approval-respond IPC. */
  pendingApprovals: Map<string, (approved: boolean) => void>;
}

const instances = new Map<string, RunningInstance>();

export interface AskOption {
  value: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

/** Block until the user picks an option (or cancels). The renderer paints
 *  the approval card; the main process listens for ask-resolve and fulfills
 *  the promise. Rejects if the instance is disposed or aborted. */
function ask(instance: RunningInstance, question: string, options: AskOption[]): Promise<string | null> {
  const askId = `ask-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
  emit(instance, "ask", askId, question, options);
  return new Promise<string | null>((resolve) => {
    instance.pendingAsks.set(askId, resolve);
  });
}
void ask; // exposed via runTurn later (spec workflow)

/** Send an event to the panel webview that owns this instance. */
function emit(instance: RunningInstance, channel: string, ...args: unknown[]): void {
  const wc = instance.webContents.deref();
  if (!wc || wc.isDestroyed()) return;
  wc.send(`agent:${instance.instanceId}:${channel}`, ...args);
}

let sdkRef: any = null;
async function ensureSDK(): Promise<any> {
  if (sdkRef) return sdkRef;
  sdkRef = await import("@anthropic-ai/claude-agent-sdk");
  return sdkRef;
}

/** One SDK pass — streams tokens / tool events to the renderer. Does NOT
 *  emit "done" so callers can chain multiple passes (e.g. the spec
 *  workflow phase loop). Returns the streamed text for downstream use. */
/** Build the SDK MCP server that exposes the agent's "yo" custom tools —
 *  the model can call these alongside the preset Claude Code toolset.
 *  Today: one tool, `ask` — pops the purple "Input required" approval card
 *  in the renderer and returns the user's pick. Reuses the same ask()
 *  helper the spec workflow uses, so the model and the workflow share one
 *  approval-card mechanism.
 *
 *  Follows the same createSdkMcpServer/tool() pattern as yo-agent.ts. */
function buildYoMcpServer(sdk: any, instance: RunningInstance): any {
  const { z } = require("zod");
  const askTool = sdk.tool(
    "ask",
    "Ask the user a multi-choice question and wait for their pick. Use this whenever you need a decision from the user that has a discrete set of options (yes/no, A vs B, which of N, approve/reject, etc). The user sees a purple \"Input required\" card with the options; one can be marked recommended so it's preselected. Returns the picked option's `value` (or \"cancelled\" if the user dismissed the card).",
    {
      question: z.string().describe("The question text shown above the options. Should be short and direct."),
      options: z.array(z.object({
        value: z.string().describe("Stable identifier returned when this option is picked."),
        label: z.string().describe("Bold row title shown to the user."),
        description: z.string().optional().describe("Optional lighter row body. Keep it under one short sentence."),
        recommended: z.boolean().optional().describe("If true, this row is preselected and gets a purple \"Recommended\" pill. At most one option should set this."),
      })).min(2).describe("The choices shown to the user. At least two."),
    },
    async (args: { question: string; options: AskOption[] }) => {
      const picked = await ask(instance, args.question, args.options);
      return {
        content: [{ type: "text" as const, text: picked === null ? "cancelled" : picked }],
      };
    },
  );
  return sdk.createSdkMcpServer({
    name: "yo",
    version: "1.0.0",
    tools: [askTool],
    alwaysLoad: true,
  });
}

async function runSdkTurn(
  instance: RunningInstance,
  message: string,
  model: string,
  perm: PermMode,
  systemPromptOverride?: string,
): Promise<string> {
  const sdk = await ensureSDK();
  const cfg = getAgent(instance.agentSlug);
  const systemPrompt = systemPromptOverride
    || cfg?.systemPrompt
    || `You are an agent in the user's yo workspace.`;
  const shellPath = getShellPath();
  instance.abortController = new AbortController();

  const isBypass = perm === "bypassPermissions";
  const yoMcp = buildYoMcpServer(sdk, instance);
  const options: Record<string, any> = {
    model: model || cfg?.model_name || "claude-sonnet-4-6",
    maxTurns: getPreference<number>("maxTurns", 200),
    ...asarSafeQueryOptions(instance.cwd),
    permissionMode: perm,
    allowDangerouslySkipPermissions: isBypass,
    // canUseTool routes risky tool calls through the inline Allow/Deny
    // approval prompt when perm mode requires it. Without this the SDK's
    // permissionMode does nothing in embedded use — there's no place to
    // ask. Same gate() logic as yo-agent.ts uses for the right rail.
    ...(isBypass ? {} : {
      canUseTool: async (toolName: string, input: Record<string, unknown>) => {
        const mode = perm as "default" | "plan" | "acceptEdits" | "bypassPermissions";
        const decision = gate(toolName, mode);
        if (decision === "execute") return { behavior: "allow", updatedInput: input };
        if (decision === "skip") return { behavior: "deny", message: `Tool "${toolName}" denied by mode "${mode}".` };
        // needs_approval — pop the inline prompt and await user.
        const approvalId = `app-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
        const approved = await new Promise<boolean>((resolve) => {
          instance.pendingApprovals.set(approvalId, resolve);
          emit(instance, "approval-prompt", approvalId, toolName, toolName, input);
        });
        return approved
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: "User denied tool call." };
      },
    }),
    tools: { type: "preset", preset: "claude_code" },
    // Our custom MCP server adds the `ask` tool that surfaces the purple
    // approval card. The model invokes it as `mcp__yo__ask`.
    mcpServers: { yo: yoMcp },
    systemPrompt,
    abortController: instance.abortController,
    includePartialMessages: true,
    persistSession: true,
    env: {
      ...process.env,
      PATH: shellPath,
      CLAUDE_AGENT_SDK_CLIENT_APP: "yosup/3.0.0",
    },
  };
  if (instance.sessionId) options.resume = instance.sessionId;

  let fullText = "";
  const gen = sdk.query({ prompt: message, options });
  for await (const msg of gen) {
    if (instance.abortController?.signal.aborted) break;

    switch (msg.type) {
      case "system":
        if (msg.subtype === "init" && msg.session_id) {
          instance.sessionId = msg.session_id;
        }
        break;
      case "stream_event": {
        const event = msg.event;
        if (event?.type === "content_block_delta") {
          const delta = (event as any).delta;
          if (delta?.type === "text_delta" && delta.text) {
            fullText += delta.text;
            emit(instance, "token", delta.text);
          }
        }
        break;
      }
      case "assistant": {
        for (const block of msg.message.content || []) {
          if (block.type === "tool_use") {
            emit(instance, "tool-use", block.id, block.name, block.input);
          }
        }
        break;
      }
      case "user": {
        for (const block of msg.message.content || []) {
          if (block.type === "tool_result") {
            emit(instance, "tool-result", block.tool_use_id, block.content);
          }
        }
        break;
      }
      case "result":
        if (msg.is_error && msg.result) {
          emit(instance, "error", msg.result);
        }
        break;
    }
  }
  instance.abortController = null;
  return fullText;
}

// ── Workflow templates ──
// Each phase's system prompt scopes the model: tells it which file to
// write, where, and how to use prior phase files as context. Files live
// under <cwd>/.yo/plan/ — created on first write by the Write tool.
const SPEC_PHASES = ["requirements", "design", "tasks"] as const;
type SpecPhase = (typeof SPEC_PHASES)[number];
function planDir(instance: RunningInstance): string { return path.join(instance.cwd, ".yo", "plan"); }
function planFile(instance: RunningInstance, phase: string): string {
  return path.join(planDir(instance), `${phase}.md`);
}
function specSystemPrompt(instance: RunningInstance, phase: SpecPhase, originalRequest: string): string {
  const reqPath = planFile(instance, "requirements");
  const designPath = planFile(instance, "design");
  const tasksPath = planFile(instance, "tasks");
  const dir = planDir(instance);
  const phaseInstructions: Record<SpecPhase, string> = {
    requirements:
      `Write the REQUIREMENTS for this work as full markdown. List what must be true when this is done. Stay scoped to what the user asked — do not invent features. Use bullet lists; group by category (functional, non-functional, constraints, out-of-scope).`,
    design:
      `Write the DESIGN markdown — the technical approach. Components, data flow, file layout, key types/state, framework/library choices, important interactions. Reference the requirements file at ${reqPath} (read it). Be concrete and complete enough that someone could implement from it.`,
    tasks:
      `Write the TASKS markdown — a numbered list of small, executable tasks that implement the design. Each task should be doable in one focused session and produce a checkable result. Group by phase if helpful. Read both prior files first: ${reqPath} and ${designPath}.`,
  };
  const targetFile = phase === "requirements" ? reqPath : phase === "design" ? designPath : tasksPath;
  return [
    `You are in the SPEC workflow, phase: ${phase.toUpperCase()}.`,
    `Stay focused on the current phase only — do NOT write the other phase files.`,
    ``,
    `${phaseInstructions[phase]}`,
    ``,
    `OUTPUT FORMAT — important:`,
    `1. Print the COMPLETE markdown content for ${phase}.md in your chat reply, so the user can read it streaming. Do not summarise; show the full content.`,
    `2. After you've written the markdown out, save the same content using the Write tool to: ${targetFile}`,
    `3. The directory ${dir} already exists; you do NOT need to create it.`,
    `4. End with a short (1-line) confirmation that the file is saved.`,
    ``,
    `User's request:`,
    `---`,
    originalRequest,
    `---`,
  ].join("\n");
}
function vibeSystemPrompt(instance: RunningInstance, originalRequest: string): string {
  const file = planFile(instance, "plan");
  const dir = planDir(instance);
  return [
    `You are in the VIBE workflow.`,
    `Before doing the work, write a short plan as markdown — print the full plan in your chat reply so the user can read it, then save the same content using the Write tool to:`,
    file,
    `The directory ${dir} already exists; you do NOT need to create it.`,
    ``,
    `After the file is saved, proceed with the actual work the user asked for. Keep the plan focused and concrete.`,
    ``,
    `User's request:`,
    `---`,
    originalRequest,
    `---`,
  ].join("\n");
}

/** Standard kind — the original behavior. Single SDK pass, agent's own
 *  system prompt. */
async function runStandardTurn(instance: RunningInstance, message: string, model: string, perm: PermMode): Promise<void> {
  try {
    const text = await runSdkTurn(instance, message, model, perm);
    emit(instance, "done", text);
  } catch (err: any) {
    emit(instance, "error", err?.message || String(err));
  } finally {
    instance.abortController = null;
  }
}

/** Pre-create <cwd>/.yo/plan/ from the main process so the model's
 *  sandboxed Write tool can save files into an existing directory.
 *  The SDK sandbox blocks `mkdir`, so the model can't create this itself. */
async function ensurePlanDir(instance: RunningInstance): Promise<void> {
  try { await fs.mkdir(planDir(instance), { recursive: true }); }
  catch (err: any) {
    emit(instance, "error", `Could not create plan directory: ${err?.message || String(err)}`);
    throw err;
  }
}

/** Vibe kind — single pass, writes plan.md alongside. */
async function runVibeTurn(instance: RunningInstance, message: string, model: string, perm: PermMode): Promise<void> {
  try {
    await ensurePlanDir(instance);
    const sys = vibeSystemPrompt(instance, message);
    const text = await runSdkTurn(instance, message, model, perm, sys);
    emit(instance, "done", text);
  } catch (err: any) {
    emit(instance, "error", err?.message || String(err));
  } finally {
    instance.abortController = null;
  }
}

/** Spec kind — three phases (requirements → design → tasks) with an
 *  approval-card ask gate between each. Same session resumes across
 *  phases so the model can build on its previous output. */
async function runSpecTurn(instance: RunningInstance, message: string, model: string, perm: PermMode): Promise<void> {
  try {
    await ensurePlanDir(instance);
    for (const phase of SPEC_PHASES) {
      const sys = specSystemPrompt(instance, phase, message);
      const summary = await runSdkTurn(instance, message, model, perm, sys);
      void summary;
      if (instance.abortController?.signal.aborted) {
        emit(instance, "done", "");
        return;
      }
      // Gate: ask the user to approve before moving on. They can edit the
      // file in the Plan app at any point while this card is up.
      const choice = await ask(
        instance,
        `${phase.charAt(0).toUpperCase() + phase.slice(1)} written — approve to continue?`,
        [
          { value: "approve", label: "Approve", description: "Continue to the next phase", recommended: true },
          { value: "reject", label: "Reject", description: "Stop the spec workflow here" },
        ],
      );
      if (choice !== "approve") {
        emit(instance, "done", "");
        return;
      }
    }
    emit(instance, "done", "");
  } catch (err: any) {
    emit(instance, "error", err?.message || String(err));
  } finally {
    instance.abortController = null;
  }
}

async function runTurn(instance: RunningInstance, message: string, model: string, perm: PermMode): Promise<void> {
  // Gate on Claude Code creds — pops the in-app sign-in modal if missing.
  const { ensureCcAuth } = await import("./cc-bootstrap");
  if (!ensureCcAuth()) {
    emit(instance, "error", "Claude Code sign-in required. Pop opened — try again after authenticating.");
    return;
  }
  const cfg = getAgent(instance.agentSlug);
  // Every time the agent does work in a folder, bump the recent so the
  // (agent, folder) pair sorts to the top of Welcome / Agent's recents
  // list. Deduped on (kind, id, folder) — same combo just refreshes ts.
  if (instance.cwd) {
    try {
      addRecent({
        kind: "app",
        id: "agent",
        name: cfg?.name || cfg?.id || "Agent",
        folder: instance.cwd,
      });
    } catch { /* recents are best-effort */ }
  }
  // Dispatch by the agent's persisted workflow kind (mutable via the type
  // dropdown). Standard = today's behaviour; vibe = single plan.md;
  // spec = three-phase approval-gated loop.
  const kind = cfg?.kind || "standard";
  if (kind === "spec") return runSpecTurn(instance, message, model, perm);
  if (kind === "vibe") return runVibeTurn(instance, message, model, perm);
  return runStandardTurn(instance, message, model, perm);
}

export function registerAgentInteractiveIpc(): void {
  ipcMain.handle("agent:ensure-default", () => {
    const cfg = ensureDefaultAgent();
    return { slug: cfg.id };
  });

  // Read just the kind for an agent slug. Falls back to "standard" when the
  // agent isn't found or the field is unset.
  ipcMain.handle("agent:get-kind", (_e, slug: string) => {
    const cfg = slug ? getAgent(slug) : null;
    return { kind: cfg?.kind || "standard" };
  });

  // Persist the workflow kind on an agent. Switchable mid-conversation; the
  // change takes effect from the NEXT turn (current in-flight turn finishes
  // under the previous kind).
  ipcMain.handle("agent:set-kind", (_e, slug: string, kind: "standard" | "spec" | "vibe") => {
    if (!slug) return { ok: false };
    const cfg = getAgent(slug);
    if (!cfg) return { ok: false, error: "agent not found" };
    const next: AgentConfig = { ...cfg, kind };
    saveAgent(next);
    return { ok: true };
  });

  // Read the saved model + perm + kind for an agent. Used by the renderer
  // to seed dropdowns on mount so a restart preserves the last selection
  // (falling back to "" / "default" / "standard" when unset).
  ipcMain.handle("agent:get-prefs", (_e, slug: string) => {
    const cfg = slug ? getAgent(slug) : null;
    return {
      model: cfg?.model_name || "",
      perm: cfg?.perm_mode || "default",
      kind: cfg?.kind || "standard",
    };
  });
  // Persist the model selection from the model dropdown.
  ipcMain.handle("agent:set-model", (_e, slug: string, model: string) => {
    if (!slug) return { ok: false };
    const cfg = getAgent(slug);
    if (!cfg) return { ok: false, error: "agent not found" };
    saveAgent({ ...cfg, model_name: model || "" });
    return { ok: true };
  });
  // Persist the perm-mode selection from the perm dropdown.
  ipcMain.handle("agent:set-perm", (_e, slug: string, perm: "default" | "plan" | "acceptEdits" | "bypassPermissions") => {
    if (!slug) return { ok: false };
    const cfg = getAgent(slug);
    if (!cfg) return { ok: false, error: "agent not found" };
    saveAgent({ ...cfg, perm_mode: perm });
    return { ok: true };
  });

  ipcMain.handle("agent:start", (e, opts: InteractiveStartOpts) => {
    if (!opts?.instanceId) return { error: "instanceId required" };
    if (instances.has(opts.instanceId)) return { ok: true };
    // e.sender IS the panel's webContents — do NOT resolve through BrowserWindow,
    // which would return the host window's webContents instead and route
    // agent:<id>:* events to the wrong renderer.
    const wc = e.sender;
    instances.set(opts.instanceId, {
      instanceId: opts.instanceId,
      agentSlug: opts.agentSlug || "default",
      cwd: opts.cwd,
      sessionId: null,
      abortController: null,
      webContents: new WeakRef(wc),
      pendingAsks: new Map(),
      pendingApprovals: new Map(),
    });
    return { ok: true };
  });

  // Resolve a pending ask from the renderer's approval card.
  ipcMain.on("agent:ask-resolve", (_e, instanceId: string, askId: string, value: string | null) => {
    const instance = instances.get(instanceId);
    if (!instance) return;
    const r = instance.pendingAsks.get(askId);
    if (!r) return;
    instance.pendingAsks.delete(askId);
    r(value);
  });

  // Resolve a pending per-tool approval (Allow / Deny on the inline prompt).
  ipcMain.on("agent:approval-respond", (_e, instanceId: string, approvalId: string, approved: boolean) => {
    const instance = instances.get(instanceId);
    if (!instance) return;
    const r = instance.pendingApprovals.get(approvalId);
    if (!r) return;
    instance.pendingApprovals.delete(approvalId);
    r(!!approved);
  });

  ipcMain.handle("agent:send", async (_e, instanceId: string, message: string, model: string, perm: PermMode) => {
    const instance = instances.get(instanceId);
    if (!instance) return { error: "instance not found" };
    void runTurn(instance, message, model || "", perm || "default");
    return { ok: true };
  });

  ipcMain.handle("agent:stop", (_e, instanceId: string) => {
    const instance = instances.get(instanceId);
    if (!instance) return { ok: false };
    instance.abortController?.abort();
    return { ok: true };
  });

  ipcMain.handle("agent:clear", (_e, instanceId: string) => {
    const instance = instances.get(instanceId);
    if (!instance) return { ok: false };
    instance.sessionId = null;
    return { ok: true };
  });

  ipcMain.handle("agent:dispose", (_e, instanceId: string) => {
    const instance = instances.get(instanceId);
    if (!instance) return { ok: false };
    instance.abortController?.abort();
    // Resolve any in-flight asks/approvals as cancelled so the engine can
    // unwind cleanly instead of leaking promises.
    for (const r of instance.pendingAsks.values()) r(null);
    instance.pendingAsks.clear();
    for (const r of instance.pendingApprovals.values()) r(false);
    instance.pendingApprovals.clear();
    instances.delete(instanceId);
    return { ok: true };
  });

  ipcMain.handle("agent:rebind", (_e, instanceId: string, cwd: string) => {
    const instance = instances.get(instanceId);
    if (!instance || typeof cwd !== "string" || !cwd) return { ok: false };
    instance.cwd = cwd;
    // Drop any in-flight turn so the next send runs against the new cwd.
    instance.abortController?.abort();
    instance.sessionId = null;
    return { ok: true };
  });
}
