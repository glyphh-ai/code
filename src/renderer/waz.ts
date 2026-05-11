/**
 * waz.ts — .waz popup renderer.
 * Same agent loop and look-and-feel as the yo panel, disposable window.
 */

interface WazAPI {
  getContext: () => Promise<{ id: string; prompt: string }>;
  send: (message: string) => void;
  stop: () => void;
  close: () => void;
  minimize: () => void;
  onToken: (cb: (delta: string) => void) => () => void;
  onToolUse: (cb: (id: string, name: string, input: unknown) => void) => () => void;
  onToolResult: (cb: (id: string, detail: string) => void) => () => void;
  onDone: (cb: (fullText: string) => void) => () => void;
  onError: (cb: (error: string) => void) => () => void;
  getTheme: () => Promise<string>;
  onThemeChanged: (cb: (theme: string) => void) => () => void;
}

const api = (window as any).waz as WazAPI;

let isStreaming = false;
let streamEl: HTMLElement | null = null;
let timelineEl: HTMLElement | null = null;

function $(id: string): HTMLElement { return document.getElementById(id)!; }

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function scrollBottom(): void {
  const m = $("messages");
  m.scrollTop = m.scrollHeight;
}

function setStatus(status: "ready" | "running" | "done" | "error"): void {
  const el = $("status");
  el.textContent = status;
  el.className = `waz-status ${status}`;

  const sendBtn = $("btn-send");
  if (status === "running") {
    sendBtn.classList.add("stop");
    sendBtn.innerHTML = "";
  } else {
    sendBtn.classList.remove("stop");
    sendBtn.innerHTML = "&uarr;";
  }
}

function addUserMessage(text: string): void {
  const container = $("messages");
  const el = document.createElement("div");
  el.className = "yo-msg yo-msg-user";
  el.textContent = text;
  container.appendChild(el);
  scrollBottom();
}

function beginStream(): HTMLElement {
  const container = $("messages");

  timelineEl = document.createElement("div");
  timelineEl.className = "yo-ag-timeline";
  container.appendChild(timelineEl);

  const el = document.createElement("div");
  el.className = "yo-msg yo-msg-assistant";
  container.appendChild(el);
  scrollBottom();
  return el;
}

function addToolBlock(name: string): HTMLElement {
  if (!timelineEl) {
    const container = $("messages");
    timelineEl = document.createElement("div");
    timelineEl.className = "yo-ag-timeline";
    container.appendChild(timelineEl);
  }

  const block = document.createElement("div");
  block.className = "yo-result-block yo-active";
  block.innerHTML = `<div class="yo-ag-dot"></div>
<div class="yo-result-header">
  <div class="yo-result-headings">
    <span class="yo-result-name">${escapeHtml(name.replace(/_/g, " "))}</span>
    <span class="yo-result-subtitle"></span>
  </div>
</div>`;
  timelineEl.appendChild(block);
  scrollBottom();
  return block;
}

function finishToolBlock(block: HTMLElement, detail: string): void {
  block.classList.remove("yo-active");
  const subtitle = block.querySelector(".yo-result-subtitle");
  if (subtitle && detail) {
    const truncated = detail.length > 120 ? detail.slice(0, 120) + "…" : detail;
    subtitle.textContent = truncated;
  }
}

function addErrorMessage(error: string): void {
  const container = $("messages");
  const el = document.createElement("div");
  el.className = "yo-msg yo-msg-error";
  el.textContent = error;
  container.appendChild(el);
  scrollBottom();
}

function sendMessage(text: string): void {
  if (!text.trim()) return;

  if (isStreaming) {
    api.stop();
    return;
  }

  addUserMessage(text);
  isStreaming = true;
  timelineEl = null;
  streamEl = beginStream();
  setStatus("running");
  ($("input") as HTMLTextAreaElement).value = "";
  autoResize($("input") as HTMLTextAreaElement);
  api.send(text);
}

function autoResize(textarea: HTMLTextAreaElement): void {
  textarea.style.height = "40px";
  textarea.style.height = Math.min(textarea.scrollHeight, 160) + "px";
}

// ── Track tools by id ──────────────────────────
const toolBlocks = new Map<string, HTMLElement>();

// ── Event handlers ─────────────────────────────
api.onToken((delta) => {
  if (streamEl) {
    streamEl.textContent += delta;
    scrollBottom();
  }
});

api.onToolUse((id, name) => {
  const block = addToolBlock(name);
  toolBlocks.set(id, block);
});

api.onToolResult((id, detail) => {
  const block = toolBlocks.get(id);
  if (block) {
    finishToolBlock(block, detail);
    toolBlocks.delete(id);
  }
});

api.onDone(() => {
  if (timelineEl) timelineEl.classList.add("done");
  toolBlocks.forEach((block) => block.classList.remove("yo-active"));
  toolBlocks.clear();
  streamEl = null;
  timelineEl = null;
  isStreaming = false;
  setStatus("done");
  ($("input") as HTMLTextAreaElement).focus();
});

api.onError((error) => {
  if (timelineEl) timelineEl.classList.add("done");
  toolBlocks.forEach((block) => block.classList.remove("yo-active"));
  toolBlocks.clear();
  streamEl = null;
  timelineEl = null;
  isStreaming = false;
  addErrorMessage(error);
  setStatus("error");
});

// ── Boot ───────────────────────────────────────
async function boot(): Promise<void> {
  const theme = await api.getTheme();
  document.documentElement.setAttribute("data-theme", theme);
  api.onThemeChanged((t) => document.documentElement.setAttribute("data-theme", t));

  const input = $("input") as HTMLTextAreaElement;

  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input.value);
    }
  });
  input.addEventListener("input", () => autoResize(input));

  $("btn-send").addEventListener("click", () => {
    if (isStreaming) {
      api.stop();
    } else {
      sendMessage(input.value);
    }
  });

  $("btn-close").addEventListener("click", () => api.close());
  $("btn-min").addEventListener("click", () => api.minimize());

  const ctx = await api.getContext();
  if (ctx.prompt) {
    sendMessage(ctx.prompt);
  } else {
    input.focus();
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
