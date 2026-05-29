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
  const options: Record<string, any> = {
    model: model || cfg?.model_name || "claude-sonnet-4-6",
    maxTurns: getPreference<number>("maxTurns", 200),
    ...asarSafeQueryOptions(instance.cwd),
    permissionMode: perm,
    allowDangerouslySkipPermissions: isBypass,
    tools: { type: "preset", preset: "claude_code" },
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
    // Resolve any in-flight asks as cancelled so the workflow engine can
    // unwind cleanly instead of leaking promises.
    for (const r of instance.pendingAsks.values()) r(null);
    instance.pendingAsks.clear();
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
