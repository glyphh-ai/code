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
  onToolProgress: (cb: (id: string, status: string) => void) => () => void;
  onDone: (cb: (fullText: string) => void) => () => void;
  onError: (cb: (error: string) => void) => () => void;
  onApprovalRequest: (cb: (id: string, toolName: string, toolLabel: string, input: unknown) => void) => () => void;
  approvalRespond: (id: string, approved: boolean) => void;
  setMode: (mode: string) => void;
  getMode: () => Promise<string>;
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

// ── Spinner ───────────────────────────────────────────
const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"];
const PHRASES = ["thinking", "cooking", "vibing", "brewing", "conjuring", "channeling"];

let spinnerInterval: ReturnType<typeof setInterval> | null = null;
let spinnerEl: HTMLElement | null = null;

function startSpinnerAnim(el: HTMLElement): void {
  let fi = 0;
  const s = el.querySelector(".yo-ag-spinner") as HTMLElement;
  if (!s) return;
  if (spinnerInterval) clearInterval(spinnerInterval);
  spinnerInterval = setInterval(() => {
    fi = (fi + 1) % BRAILLE.length;
    s.textContent = BRAILLE[fi];
  }, 80);
}

function ensureSpinner(): void {
  if (spinnerEl) return;
  const phrase = PHRASES[Math.floor(Math.random() * PHRASES.length)];
  spinnerEl = document.createElement("div");
  spinnerEl.className = "yo-ag-active";
  spinnerEl.innerHTML =
    `<span class="yo-ag-spinner">⠋</span>` +
    `<span class="yo-ag-phrase">${phrase}...</span>`;
  $("messages").appendChild(spinnerEl);
  startSpinnerAnim(spinnerEl);
}

function removeSpinner(): void {
  if (spinnerInterval) { clearInterval(spinnerInterval); spinnerInterval = null; }
  if (spinnerEl) { spinnerEl.remove(); spinnerEl = null; }
}

// ── Status ────────────────────────────────────────────

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

// ── Messages ──────────────────────────────────────────

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

function updateToolProgress(block: HTMLElement, status: string): void {
  const subtitle = block.querySelector(".yo-result-subtitle");
  if (subtitle) {
    subtitle.textContent = status;
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

// ── Approval UI ───────────────────────────────────────

function addApprovalCard(id: string, toolName: string, toolLabel: string, input: unknown): void {
  const inputObj = input as Record<string, unknown>;
  let detail = "";
  if (typeof inputObj.instruction === "string") detail = inputObj.instruction;
  else if (typeof inputObj.text === "string") detail = inputObj.text;
  else if (typeof inputObj.command === "string") detail = inputObj.command;
  else if (typeof inputObj.url === "string") detail = inputObj.url;
  else {
    const first = Object.values(inputObj).find((v) => typeof v === "string");
    if (typeof first === "string") detail = first;
  }

  const card = document.createElement("div");
  card.className = "yo-approval-card";
  card.innerHTML =
    `<div class="yo-approval-header">` +
      `<span class="yo-approval-icon">?</span>` +
      `<span class="yo-approval-title">${escapeHtml(toolLabel)}</span>` +
    `</div>` +
    (detail ? `<div class="yo-approval-detail">${escapeHtml(detail.slice(0, 200))}</div>` : "") +
    `<div class="yo-approval-actions">` +
      `<button class="yo-approval-btn yo-approval-allow">Allow</button>` +
      `<button class="yo-approval-btn yo-approval-deny">Deny</button>` +
    `</div>`;

  const toolRow = toolBlocks.get(toolName);
  if (toolRow) {
    toolRow.appendChild(card);
  } else {
    $("messages").appendChild(card);
  }
  scrollBottom();

  card.querySelector(".yo-approval-allow")!.addEventListener("click", () => {
    api.approvalRespond(id, true);
    card.classList.add("yo-approval-resolved", "yo-approval-allowed");
    card.querySelector(".yo-approval-actions")!.remove();
    const status = document.createElement("span");
    status.className = "yo-approval-status allowed";
    status.textContent = "allowed";
    card.querySelector(".yo-approval-header")!.appendChild(status);
  });

  card.querySelector(".yo-approval-deny")!.addEventListener("click", () => {
    api.approvalRespond(id, false);
    card.classList.add("yo-approval-resolved", "yo-approval-denied");
    card.querySelector(".yo-approval-actions")!.remove();
    const status = document.createElement("span");
    status.className = "yo-approval-status denied";
    status.textContent = "denied";
    card.querySelector(".yo-approval-header")!.appendChild(status);
  });
}

// ── Send ──────────────────────────────────────────────

function sendMessage(text: string): void {
  if (!text.trim()) return;

  if (isStreaming) {
    api.stop();
    return;
  }

  addUserMessage(text);
  isStreaming = true;
  timelineEl = null;
  removeSpinner();
  ensureSpinner();
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

// ── Track tools by id ─────────────────────────────────
const toolBlocks = new Map<string, HTMLElement>();

// ── Event handlers ────────────────────────────────────
api.onToken((delta) => {
  removeSpinner();
  if (streamEl) {
    streamEl.textContent += delta;
    scrollBottom();
  }
});

api.onToolUse((id, name) => {
  removeSpinner();
  const block = addToolBlock(name);
  toolBlocks.set(id, block);
  ensureSpinner();
});

api.onToolResult((id, detail) => {
  const block = toolBlocks.get(id);
  if (block) {
    finishToolBlock(block, detail);
    toolBlocks.delete(id);
  }
  removeSpinner();
  ensureSpinner();
});

api.onToolProgress((id, status) => {
  const block = toolBlocks.get(id);
  if (block) {
    updateToolProgress(block, status);
  }
});

api.onDone(() => {
  removeSpinner();
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
  removeSpinner();
  if (timelineEl) timelineEl.classList.add("done");
  toolBlocks.forEach((block) => block.classList.remove("yo-active"));
  toolBlocks.clear();
  streamEl = null;
  timelineEl = null;
  isStreaming = false;
  addErrorMessage(error);
  setStatus("error");
});

api.onApprovalRequest((id, toolName, toolLabel, input) => {
  addApprovalCard(id, toolName, toolLabel, input);
});

// ── Permission dropdown (rich — matches yo panel) ─────

const PERM_LABELS: Record<string, { icon: string; label: string }> = {
  default:           { icon: "\u{1F512}", label: "ask" },
  plan:              { icon: "\u{1F4CB}", label: "plan" },
  acceptEdits:       { icon: "⚡",    label: "auto" },
  bypassPermissions: { icon: "\u{1F525}", label: "bypass" },
};

function initPermDropdown(): void {
  const trigger = document.getElementById("waz-perm-trigger");
  const menu = document.getElementById("waz-perm-menu");
  if (!trigger || !menu) return;

  const iconEl = trigger.querySelector(".yo-perm-icon") as HTMLElement;
  const labelEl = trigger.querySelector(".yo-perm-label") as HTMLElement;

  function setPermValue(value: string): void {
    const info = PERM_LABELS[value] || PERM_LABELS.default;
    iconEl.textContent = info.icon;
    labelEl.textContent = info.label;
  }

  api.getMode().then((mode) => setPermValue(mode));

  trigger.addEventListener("click", () => {
    menu.classList.toggle("hidden");
  });

  menu.querySelectorAll<HTMLElement>(".yo-perm-option").forEach((opt) => {
    opt.addEventListener("click", () => {
      const value = opt.dataset.value || "default";
      setPermValue(value);
      api.setMode(value);
      menu.classList.add("hidden");
    });
  });

  document.addEventListener("click", (e) => {
    if (!trigger.contains(e.target as Node) && !menu.contains(e.target as Node)) {
      menu.classList.add("hidden");
    }
  });
}

// ── Boot ──────────────────────────────────────────────
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

  initPermDropdown();

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
