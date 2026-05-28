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
import { asarSafeQueryOptions } from "./sdk-llm";
import { getShellPath } from "./shell-path";
import { getPreference } from "./stores/preferences-db";
import { getAgent, ensureDefaultAgent } from "./agent-store";

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
}

const instances = new Map<string, RunningInstance>();

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

async function runTurn(instance: RunningInstance, message: string, model: string, perm: PermMode): Promise<void> {
  // Gate on Claude Code creds — pops the in-app sign-in modal if missing.
  // Skip this turn; the next message after sign-in will succeed.
  const { ensureCcAuth } = await import("./cc-bootstrap");
  if (!ensureCcAuth()) {
    emit(instance, "error", "Claude Code sign-in required. Pop opened — try again after authenticating.");
    return;
  }

  const sdk = await ensureSDK();
  const cfg = getAgent(instance.agentSlug);
  const systemPrompt = cfg?.systemPrompt || `You are an agent in the user's yo workspace.`;
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
  try {
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
    emit(instance, "done", fullText);
  } catch (err: any) {
    emit(instance, "error", err?.message || String(err));
  } finally {
    instance.abortController = null;
  }
}

export function registerAgentInteractiveIpc(): void {
  ipcMain.handle("agent:ensure-default", () => {
    const cfg = ensureDefaultAgent();
    return { slug: cfg.id };
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
    });
    return { ok: true };
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
