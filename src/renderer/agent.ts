/**
 * yo://agent — Agent app panel entry.
 *
 * Mounts a YoAgentRenderer in a full-window host, wires it to the main-side
 * agent-interactive engine via per-instance IPC channels.
 */

import { createYoAgentRenderer, type PermMode } from "./yo-agent-renderer.js";

interface AgentApi {
  ensureDefault: () => Promise<{ slug: string }>;
  start: (opts: { instanceId: string; agentSlug: string; cwd: string }) => Promise<unknown>;
  send: (instanceId: string, message: string, model: string, perm: PermMode) => Promise<unknown>;
  stop: (instanceId: string) => Promise<unknown>;
  clear: (instanceId: string) => Promise<unknown>;
  dispose: (instanceId: string) => Promise<unknown>;
  getCwd: () => Promise<string>;
  pickCwd: () => Promise<string | null>;
  onEvent: (channel: string, cb: (...args: unknown[]) => void) => void;
  getTheme: () => Promise<string>;
  onThemeChanged: (cb: (theme: string) => void) => () => void;
}

declare global { interface Window { agent: AgentApi } }

function instanceId(): string {
  // Random per-panel id. Multiple agent panels coexist; each gets its own.
  return `aii-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

function getSlugFromUrl(): string {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("slug") || "default";
  } catch {
    return "default";
  }
}

async function init(): Promise<void> {
  const host = document.getElementById("agent-host");
  if (!host || !window.agent) return;

  const slug = getSlugFromUrl();
  const id = instanceId();

  let cwd = await window.agent.getCwd();
  if (!cwd) {
    // Folder-bound app: ask once on first mount when nothing is set.
    cwd = (await window.agent.pickCwd()) || "";
  }
  if (!cwd) {
    host.innerHTML = `<div class="agent-error">No folder selected. Pick a folder to start the agent.</div>`;
    return;
  }

  // Make sure the default agent exists (creates it with Claude Code preamble
  // if missing — see agent-store ensureDefaultAgent).
  await window.agent.ensureDefault();

  const renderer = createYoAgentRenderer({
    host: host as HTMLElement,
    onSend: (text, model, perm) => {
      renderer.addUserMessage(text);
      renderer.setThinking(true);
      renderer.startAssistantMessage();
      void window.agent.send(id, text, model, perm);
    },
    onStop: () => { void window.agent.stop(id); },
    onClear: () => { void window.agent.clear(id); },
  });

  await window.agent.start({ instanceId: id, agentSlug: slug, cwd });

  window.agent.onEvent(`agent:${id}:token`, (delta: unknown) => {
    renderer.appendToken(String(delta));
  });
  window.agent.onEvent(`agent:${id}:tool-use`, (toolId: unknown, name: unknown, input: unknown) => {
    renderer.showToolUse(String(toolId), String(name), input);
  });
  window.agent.onEvent(`agent:${id}:tool-result`, (toolId: unknown, detail: unknown) => {
    renderer.showToolResult(String(toolId), detail);
  });
  window.agent.onEvent(`agent:${id}:done`, (full: unknown) => {
    renderer.finalizeMessage(typeof full === "string" ? full : undefined);
  });
  window.agent.onEvent(`agent:${id}:error`, (err: unknown) => {
    renderer.showError(String(err));
  });

  window.addEventListener("beforeunload", () => {
    void window.agent.dispose(id);
  });
}

document.addEventListener("DOMContentLoaded", () => { void init(); });
