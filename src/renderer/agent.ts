/**
 * yo://agent — Agent app panel entry.
 *
 * Mounts a YoAgentRenderer over the right-rail-replica DOM in agent.html
 * (same IDs/classes as #yo-panel in index.html, so the existing styles
 * carry over). Wires the renderer callbacks to per-instance agent:*
 * IPCs from agent-interactive.ts. The only chrome difference from the
 * right-rail is the folder picker bar above the chat.
 */

import { createYoAgentRenderer, type PermMode, type ChatSummary } from "./yo-agent-renderer.js";

interface AgentApi {
  ensureDefault: () => Promise<{ slug: string }>;
  start: (opts: { instanceId: string; agentSlug: string; cwd: string }) => Promise<unknown>;
  send: (instanceId: string, message: string, model: string, perm: PermMode) => Promise<unknown>;
  stop: (instanceId: string) => Promise<unknown>;
  clear: (instanceId: string) => Promise<unknown>;
  dispose: (instanceId: string) => Promise<unknown>;
  rebind: (instanceId: string, cwd: string) => Promise<unknown>;
  getCwd: () => Promise<string>;
  pickCwd: () => Promise<string | null>;
  onEvent: (channel: string, cb: (...args: unknown[]) => void) => void;
  getTheme: () => Promise<string>;
  onThemeChanged: (cb: (theme: string) => void) => () => void;
}

declare global { interface Window { agent: AgentApi } }

function makeInstanceId(): string {
  return `aii-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

function getSlugFromUrl(): string {
  try {
    return new URLSearchParams(window.location.search).get("slug") || "default";
  } catch {
    return "default";
  }
}

function homeShorten(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}

async function init(): Promise<void> {
  if (!window.agent) return;

  const slug = getSlugFromUrl();
  const id = makeInstanceId();

  await window.agent.ensureDefault();

  const folderBtn = document.getElementById("agent-folder-btn");
  const folderLabel = document.getElementById("agent-folder-label");
  let cwd = await window.agent.getCwd().catch(() => "");

  function paintFolderLabel(): void {
    if (!folderLabel) return;
    if (cwd) {
      folderLabel.textContent = homeShorten(cwd);
      folderLabel.classList.remove("agent-folder-empty");
      folderLabel.title = cwd;
    } else {
      folderLabel.textContent = "no folder bound";
      folderLabel.classList.add("agent-folder-empty");
      folderLabel.title = "";
    }
  }
  paintFolderLabel();

  // Folder picker — pick → rebind the instance to the new cwd. New folder
  // also clears any in-flight turn / resumed session on the engine side.
  folderBtn?.addEventListener("click", async () => {
    const picked = await window.agent.pickCwd();
    if (!picked) return;
    cwd = picked;
    paintFolderLabel();
    await window.agent.rebind(id, picked);
  });

  // Build the chat renderer over the pre-rendered DOM.
  const renderer = createYoAgentRenderer({
    callbacks: {
      send: (text, model, perm) => { void window.agent.send(id, text, model, perm); },
      stop: () => { void window.agent.stop(id); },
      newChat: async () => {
        await window.agent.clear(id);
        renderer.clearChat();
      },
      // Per-instance chat persistence isn't wired yet — list/load/delete
      // are stubs for now so the dropdown opens cleanly. Follow-up will
      // wire these to the agent-interactive engine.
      listChats: async (): Promise<ChatSummary[]> => [],
      loadChat: async () => { /* TODO */ },
      deleteChat: async () => { /* TODO */ },
      // Approvals aren't surfaced by the engine yet (it doesn't gate on
      // canUseTool); placeholder for when they are.
      respondApproval: () => { /* TODO */ },
    },
  });

  // Start the engine — runs against current cwd (may be ""; agent-interactive
  // tolerates an empty cwd and the model will simply have no working dir).
  await window.agent.start({ instanceId: id, agentSlug: slug, cwd: cwd || "" });

  // Stream events into the renderer.
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

  window.addEventListener("beforeunload", () => { void window.agent.dispose(id); });
}

document.addEventListener("DOMContentLoaded", () => { void init(); });
