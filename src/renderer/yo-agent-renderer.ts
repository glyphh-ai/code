/**
 * YoAgentRenderer — embeddable chat UI for the yo://agent app.
 *
 * Pure visual layer. Mounts into a host element, owns its own DOM (no
 * shared IDs), owns per-instance state. Multiple instances can coexist
 * on a single page.
 *
 * The right-rail .Yo overlay continues to use yo-panel-ui.ts (singleton
 * with deep DOM/IPC coupling). Unifying both onto this module is a
 * follow-up cleanup — see yo-client/docs/AGENT-APP-DESIGN.md §7.
 */

import { formatMarkdown } from "./format-markdown.js";

export type PermMode = "default" | "plan" | "acceptEdits" | "bypassPermissions";

export interface YoAgentRendererProps {
  host: HTMLElement;
  initialModel?: string;
  initialPerm?: PermMode;
  onSend: (text: string, model: string, perm: PermMode) => void;
  onStop: () => void;
  onClear: () => void;
  onPermChange?: (perm: PermMode) => void;
  onModelChange?: (model: string) => void;
}

export interface YoAgentRenderer {
  addUserMessage(text: string): void;
  startAssistantMessage(): void;
  appendToken(delta: string): void;
  showToolUse(id: string, name: string, input: unknown): void;
  showToolResult(id: string, detail: unknown): void;
  finalizeMessage(fullText?: string): void;
  showError(msg: string): void;
  setThinking(thinking: boolean): void;
  clear(): void;
  destroy(): void;
}

const PERM_ICONS: Record<PermMode, string> = {
  default: "🔒",
  plan: "📋",
  acceptEdits: "⚡",
  bypassPermissions: "🔥",
};
const PERM_LABELS: Record<PermMode, string> = {
  default: "ask",
  plan: "plan",
  acceptEdits: "auto",
  bypassPermissions: "bypass",
};

export function createYoAgentRenderer(props: YoAgentRendererProps): YoAgentRenderer {
  const host = props.host;
  let currentModel = props.initialModel || "";
  let currentPerm: PermMode = props.initialPerm || "default";
  let thinking = false;
  let assistantEl: HTMLElement | null = null;
  let assistantText = "";

  host.classList.add("yar-host");
  host.innerHTML = `
    <div class="yar-messages" data-role="messages"></div>
    <div class="yar-status" data-role="status"></div>
    <div class="yar-composer">
      <textarea class="yar-input" data-role="input" rows="1" placeholder="Ask your agent…"></textarea>
      <div class="yar-controls">
        <button class="yar-pill" data-role="perm" type="button">
          <span data-role="perm-icon">${PERM_ICONS[currentPerm]}</span>
          <span data-role="perm-label">${PERM_LABELS[currentPerm]}</span>
        </button>
        <input class="yar-pill yar-pill-input" data-role="model" type="text"
               placeholder="default model" value="${currentModel}" />
        <div class="yar-spacer"></div>
        <button class="yar-send" data-role="send" type="button" title="Send">↑</button>
      </div>
    </div>
  `;

  injectStylesOnce();

  const messages = host.querySelector('[data-role="messages"]') as HTMLElement;
  const status = host.querySelector('[data-role="status"]') as HTMLElement;
  const input = host.querySelector('[data-role="input"]') as HTMLTextAreaElement;
  const send = host.querySelector('[data-role="send"]') as HTMLButtonElement;
  const permBtn = host.querySelector('[data-role="perm"]') as HTMLButtonElement;
  const permIcon = host.querySelector('[data-role="perm-icon"]') as HTMLElement;
  const permLabel = host.querySelector('[data-role="perm-label"]') as HTMLElement;
  const modelInput = host.querySelector('[data-role="model"]') as HTMLInputElement;

  function autoGrow() {
    input.style.height = "auto";
    input.style.height = Math.min(160, input.scrollHeight) + "px";
  }
  input.addEventListener("input", autoGrow);

  function rotatePerm() {
    const order: PermMode[] = ["default", "plan", "acceptEdits", "bypassPermissions"];
    const i = order.indexOf(currentPerm);
    currentPerm = order[(i + 1) % order.length];
    permIcon.textContent = PERM_ICONS[currentPerm];
    permLabel.textContent = PERM_LABELS[currentPerm];
    props.onPermChange?.(currentPerm);
  }
  permBtn.addEventListener("click", rotatePerm);

  modelInput.addEventListener("change", () => {
    currentModel = modelInput.value.trim();
    props.onModelChange?.(currentModel);
  });

  function doSend() {
    if (thinking) { props.onStop(); return; }
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    autoGrow();
    props.onSend(text, currentModel, currentPerm);
  }
  send.addEventListener("click", doSend);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  });

  function scrollToEnd() {
    messages.scrollTop = messages.scrollHeight;
  }

  return {
    addUserMessage(text: string) {
      const el = document.createElement("div");
      el.className = "yar-msg yar-msg-user";
      el.textContent = text;
      messages.appendChild(el);
      scrollToEnd();
    },
    startAssistantMessage() {
      assistantText = "";
      assistantEl = document.createElement("div");
      assistantEl.className = "yar-msg yar-msg-assistant";
      messages.appendChild(assistantEl);
      scrollToEnd();
    },
    appendToken(delta: string) {
      if (!assistantEl) this.startAssistantMessage();
      assistantText += delta;
      assistantEl!.innerHTML = formatMarkdown(assistantText);
      scrollToEnd();
    },
    showToolUse(id: string, name: string, input: unknown) {
      const el = document.createElement("div");
      el.className = "yar-tool";
      el.dataset.toolId = id;
      el.innerHTML = `<div class="yar-tool-name">⚙ ${name}</div><pre class="yar-tool-input">${escapeHtml(JSON.stringify(input, null, 2))}</pre>`;
      messages.appendChild(el);
      scrollToEnd();
    },
    showToolResult(id: string, detail: unknown) {
      const el = messages.querySelector<HTMLElement>(`.yar-tool[data-tool-id="${id}"]`);
      if (!el) return;
      const result = document.createElement("div");
      result.className = "yar-tool-result";
      result.textContent = typeof detail === "string" ? detail : JSON.stringify(detail);
      el.appendChild(result);
      scrollToEnd();
    },
    finalizeMessage(fullText?: string) {
      if (fullText && assistantEl) {
        assistantEl.innerHTML = formatMarkdown(fullText);
      }
      assistantEl = null;
      assistantText = "";
      this.setThinking(false);
    },
    showError(msg: string) {
      const el = document.createElement("div");
      el.className = "yar-msg yar-msg-error";
      el.textContent = msg;
      messages.appendChild(el);
      scrollToEnd();
      this.setThinking(false);
    },
    setThinking(v: boolean) {
      thinking = v;
      status.textContent = v ? "thinking…" : "";
      send.textContent = v ? "■" : "↑";
      send.title = v ? "Stop" : "Send";
    },
    clear() {
      messages.innerHTML = "";
      assistantEl = null;
      assistantText = "";
      this.setThinking(false);
      props.onClear();
    },
    destroy() {
      host.innerHTML = "";
      host.classList.remove("yar-host");
    },
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let stylesInjected = false;
function injectStylesOnce(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    .yar-host { display: flex; flex-direction: column; height: 100%; background: var(--bg); color: var(--text); font-family: var(--font); font-size: 14px; }
    .yar-messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
    .yar-msg { padding: 10px 12px; border-radius: 8px; line-height: 1.55; word-wrap: break-word; }
    .yar-msg-user { background: var(--surface-2); border: 1px solid var(--border); align-self: flex-end; max-width: 70%; }
    .yar-msg-assistant { background: transparent; }
    .yar-msg-error { background: rgba(255, 60, 60, 0.08); border: 1px solid rgba(255, 60, 60, 0.3); color: #ff6060; }
    .yar-tool { background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; font-family: var(--font-mono); font-size: 12px; }
    .yar-tool-name { font-weight: 600; }
    .yar-tool-input { margin: 4px 0 0 0; padding: 6px 8px; background: var(--bg); border-radius: 4px; font-size: 11px; max-height: 120px; overflow: auto; white-space: pre-wrap; }
    .yar-tool-result { margin-top: 6px; padding: 6px 8px; background: var(--bg); border-radius: 4px; font-size: 11px; max-height: 200px; overflow: auto; white-space: pre-wrap; }
    .yar-status { padding: 0 16px 4px; min-height: 16px; color: var(--text-3); font-size: 11px; }
    .yar-composer { padding: 10px 16px 14px; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 8px; background: var(--surface); }
    .yar-input { resize: none; width: 100%; min-height: 36px; max-height: 160px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); font-family: inherit; font-size: 14px; line-height: 1.4; outline: none; }
    .yar-input:focus { border-color: var(--accent); }
    .yar-controls { display: flex; align-items: center; gap: 6px; }
    .yar-spacer { flex: 1; }
    .yar-pill { padding: 4px 10px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface-2); color: var(--text-2); font-size: 11px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
    .yar-pill:hover { color: var(--text); border-color: var(--accent); }
    .yar-pill-input { width: 120px; }
    .yar-pill-input:focus { outline: none; border-color: var(--accent); color: var(--text); }
    .yar-send { width: 32px; height: 32px; border-radius: 50%; border: none; background: var(--accent); color: var(--accent-fg, #fff); font-size: 16px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
    .yar-send:hover { filter: brightness(1.1); }
  `;
  document.head.appendChild(style);
}
