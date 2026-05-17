/**
 * Yo panel — messaging, streaming, tool timeline, approval UI, voice input,
 * resize handle, and chat history.
 *
 * Extracted from renderer.ts. All DOM queries happen internally; the caller
 * supplies a `renderGridHandles` callback so the module can notify the layout
 * system when the panel opens/closes without importing renderer internals.
 */

import { formatMarkdown } from "./format-markdown.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface YoPanelApi {
  openYoPanel: (query: string) => void;
  closeYoPanel: () => void;
  isYoPanelOpen: () => boolean;
  yoScroll: () => void;
  showYoWelcome: () => void;
  hideYoWelcome: () => void;
  getYoPanelWidth: () => number;
}

export interface YoPanelCallbacks {
  renderGridHandles: () => void;
}

// ── DOM elements (queried once at init) ────────────────────────────────────

let yoPanel: HTMLElement;
let yoPanelMessages: HTMLElement;
let yoPanelInput: HTMLTextAreaElement;
let yoPanelSendBtn: HTMLElement;
let yoPanelMicBtn: HTMLButtonElement | null;
let yoScrollBtn: HTMLElement;
let yoPanelCloseBtn: Element;
let yoPanelResize: HTMLElement;
let yoHistoryToggle: HTMLElement;
let yoHistoryPanel: HTMLElement;
let yoHistoryList: HTMLElement;
let yoChatNewBtn: HTMLElement;

// ── Mode/model dropdowns ───────────────────────────────────────────────────

let yoModeDropdown: HTMLElement;
let yoModeTrigger: HTMLElement;
let yoModeMenu: HTMLElement;
let yoModeOptions: NodeListOf<Element>;
let yoPermDropdown: HTMLElement;
let yoPermTrigger: HTMLElement;
let yoPermMenu: HTMLElement;
let yoPermOptions: NodeListOf<Element>;
let yoControlsInited = false;

const MODE_ICONS: Record<string, string> = {
  standard: "❓",
  council:  "🏛",
  cypher:   "⚡",
};

const MODE_COLORS: Record<string, string> = {
  standard: "#25C75E",
  council:  "#A855F7",
  cypher:   "#FF6B2C",
};

const PERM_ICONS: Record<string, string> = {
  default: "🔒",
  plan: "📋",
  acceptEdits: "⚡",
  bypassPermissions: "🔥",
};

const PERM_COLORS: Record<string, string> = {
  default: "#25C75E",
  plan: "#4A9EFF",
  acceptEdits: "#FF8C00",
  bypassPermissions: "#FF2D55",
};

const PERM_LABELS: Record<string, string> = {
  default: "ask",
  plan: "plan",
  acceptEdits: "auto",
  bypassPermissions: "bypass",
};

let currentMode = "standard";
let currentPerm = "default";

// ── Internal state ─────────────────────────────────────────────────────────

let yoResponseEl: HTMLElement | null = null;
let yoStatusEl: HTMLElement | null = null;
let yoLastAssistantText = "";
let yoTurnFullText = "";
let yoLastUserText = "";
let yoToolsUsed = false;
let yoThinking = false;
// Messages typed while the agent is busy — sent one by one as turns finish.
let pendingYoMessages: string[] = [];

let yoSpinnerInterval: ReturnType<typeof setInterval> | null = null;
let yoSpinnerEl: HTMLElement | null = null;
let yoTimelineEl: HTMLElement | null = null;

let _mdRenderTimer: ReturnType<typeof setTimeout> | null = null;

const yoToolRows = new Map<string, HTMLElement>();

let yoTodoEl: HTMLElement | null = null;

// Callback reference (set once at init)
let _renderGridHandles: () => void;

// ── Constants ──────────────────────────────────────────────────────────────

const DELEGATION_DESC: Record<string, string> = {
  delegate_navigate: "Navigating panels",
  delegate_layout:   "Arranging layout",
  delegate_build:    "Building",
};

const DIRECT_TOOL_DESC: Record<string, string> = {
  search_captures: "Searching captures",
  get_context:     "Reading session",
  format:          "Formatting",
  save_memory:     "Saving to memory",
  search_notes:    "Searching notes",
  read_file:       "Reading file",
  list_files:      "Listing files",
  run_command:     "Running command",
};

const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"];
const PHRASES = ["thinking", "cooking", "vibing", "brewing", "conjuring", "channeling"];
const STOP_QUIPS = [
  "You stopped the music.",
  "Record scratch.",
  "The vibe has been killed.",
  "Pulling the plug.",
  "And... cut.",
  "Mic drop. But not by me.",
  "Walked off stage mid-set.",
  "You hit the brakes.",
];

// ── Helpers: thinking state ────────────────────────────────────────────────

function setYoThinking(thinking: boolean) {
  yoThinking = thinking;
  yoPanelSendBtn.textContent = thinking ? "■" : "↑";
  yoPanelSendBtn.classList.toggle("yo-stop", thinking);
  // Input stays enabled while the agent works — messages queue (drained as
  // each turn finishes), so the user is never blocked from typing.
}

// ── Helpers: welcome screen ────────────────────────────────────────────────

function hideYoWelcome() {
  const w = document.getElementById("yo-panel-welcome");
  if (w) w.remove();
}

function showYoWelcome() {
  hideYoWelcome();
  const w = document.createElement("div");
  w.id = "yo-panel-welcome";
  w.className = "yo-panel-welcome";
  w.innerHTML = `<div class="yo-welcome-logo"><span class="yo-welcome-dot">.</span>Yo</div>
    <div class="yo-welcome-tagline">Your AI workspace agent</div>
    <div class="yo-welcome-hints">
      <div class="yo-welcome-hint">find that reddit thread about pricing</div>
      <div class="yo-welcome-hint">open gmail and claude side by side</div>
      <div class="yo-welcome-hint">create a skill called summarize</div>
      <div class="yo-welcome-hint">what did I capture yesterday?</div>
    </div>`;
  yoPanelMessages.appendChild(w);
  w.querySelectorAll(".yo-welcome-hint").forEach((hint) => {
    hint.addEventListener("click", () => {
      const text = hint.textContent || "";
      hideYoWelcome();
      addYoUserMessage(text);
      showYoStatus("");
      setYoThinking(true);
      window.yo.yoPanelSend(text);
    });
  });
}

// ── Helpers: mode/perm dropdowns ───────────────────────────────────────────

function setModeValue(mode: string) {
  currentMode = mode;
  const icon = yoModeTrigger.querySelector(".yo-mode-icon")!;
  const label = yoModeTrigger.querySelector(".yo-mode-label")!;
  icon.textContent = MODE_ICONS[mode] || MODE_ICONS.standard;
  label.textContent = mode;
  yoModeOptions.forEach((opt) => {
    opt.classList.toggle("active", (opt as HTMLElement).dataset.value === mode);
  });
  applyModeColor();
}

function setPermValue(perm: string) {
  currentPerm = perm;
  const icon = yoPermTrigger.querySelector(".yo-perm-icon")!;
  const label = yoPermTrigger.querySelector(".yo-perm-label")!;
  icon.textContent = PERM_ICONS[perm] || PERM_ICONS.default;
  label.textContent = PERM_LABELS[perm] || perm;
  yoPermOptions.forEach((opt) => {
    opt.classList.toggle("active", (opt as HTMLElement).dataset.value === perm);
  });
}

function applyModeColor() {
  const color = MODE_COLORS[currentMode] || MODE_COLORS.standard;
  yoModeTrigger.style.borderColor = color;
  yoPanelInput.style.setProperty("--mode-color", color);
  yoPanelSendBtn.style.background = color;
  document.documentElement.style.setProperty("--yo-mode-color", color);
}

function syncAgentMode(): void {
  if (currentMode === "council") {
    window.yo.setAgentMode("exit-cypher");
    window.yo.setAgentMode("council");
    window.yo.setAgentMode(currentPerm);
  } else if (currentMode === "cypher") {
    window.yo.setAgentMode("exit-council");
    window.yo.setAgentMode("cypher");
    window.yo.setAgentMode(currentPerm);
  } else {
    window.yo.setAgentMode("exit-council");
    window.yo.setAgentMode("exit-cypher");
    window.yo.setAgentMode(currentPerm);
  }
}

async function initYoControls() {
  const mode = await window.yo.getAgentMode();
  if (mode === "council" || mode === "cypher") {
    setModeValue(mode);
    setPermValue("default");
  } else {
    setModeValue("standard");
    setPermValue(mode);
  }
}

// ── Helpers: messages ──────────────────────────────────────────────────────

function addYoUserMessage(text: string) {
  const el = document.createElement("div");
  el.className = "yo-msg yo-msg-user";
  el.textContent = text;
  yoPanelMessages.appendChild(el);
  yoPanelMessages.scrollTop = yoPanelMessages.scrollHeight;
}

// ── Helpers: scroll ────────────────────────────────────────────────────────

function yoScroll() {
  yoPanelMessages.scrollTop = yoPanelMessages.scrollHeight;
  yoScrollBtn.classList.remove("visible");
}

// ── Helpers: spinner ───────────────────────────────────────────────────────

function startSpinner(el: HTMLElement) {
  let fi = 0;
  const s = el.querySelector(".yo-ag-spinner") as HTMLElement;
  if (!s) return;
  if (yoSpinnerInterval) clearInterval(yoSpinnerInterval);
  yoSpinnerInterval = setInterval(() => {
    fi = (fi + 1) % BRAILLE.length;
    s.textContent = BRAILLE[fi];
  }, 80);
}

function stopSpinner() {
  if (yoSpinnerInterval) { clearInterval(yoSpinnerInterval); yoSpinnerInterval = null; }
}

function ensureSpinner() {
  if (yoSpinnerEl) return;
  const phrase = PHRASES[Math.floor(Math.random() * PHRASES.length)];
  yoSpinnerEl = document.createElement("div");
  yoSpinnerEl.className = "yo-ag-active";
  yoSpinnerEl.innerHTML =
    `<span class="yo-ag-spinner">⠋</span>` +
    `<span class="yo-ag-phrase">${phrase}...</span>`;
  yoPanelMessages.appendChild(yoSpinnerEl);
  startSpinner(yoSpinnerEl);
}

function removeSpinner() {
  stopSpinner();
  if (yoSpinnerEl) { yoSpinnerEl.remove(); yoSpinnerEl = null; }
}

// ── Helpers: timeline ──────────────────────────────────────────────────────

function ensureTimeline() {
  if (yoTimelineEl) return;
  yoTimelineEl = document.createElement("div");
  yoTimelineEl.className = "yo-ag-timeline";
  yoPanelMessages.appendChild(yoTimelineEl);
}

function finishTimeline() {
  removeSpinner();
  if (yoTimelineEl) {
    yoTimelineEl.classList.add("done");
    yoTimelineEl = null;
  }
}

// ── Helpers: tool display names ────────────────────────────────────────────

function formatToolDisplayName(name: string): string {
  if (DELEGATION_DESC[name]) return DELEGATION_DESC[name];
  if (DIRECT_TOOL_DESC[name]) return DIRECT_TOOL_DESC[name];
  if (name.startsWith("skill_")) return dedupeLeadingToken(name.slice(6)).replace(/_/g, " ");
  const mcpMatch = name.match(/^mcp__[^_]+__(.+)$/);
  if (mcpMatch) return dedupeLeadingToken(mcpMatch[1]).replace(/_/g, " ");
  const cleaned = dedupeLeadingToken(name);
  const parts = cleaned.split("_");
  if (parts.length >= 2) {
    const app = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
    const action = parts.slice(1).join(" ");
    return `${app}: ${action}`;
  }
  return cleaned.replace(/_/g, " ");
}

/**
 * Pipedream connectors (and a handful of MCP servers) emit tool names like
 * "gmail_gmail_find_email" — the connector slug prepended onto a tool name
 * that already starts with the same slug. Strip the duplicate so the label
 * renders as "Gmail: find email" instead of "Gmail: gmail find email".
 *
 * Two patterns handled:
 *   single underscore: "gmail_gmail_find_email" -> "gmail_find_email"
 *   double underscore: "gmail__gmail_find_email" -> "gmail_find_email"
 *     (this comes from the <server>__<tool> short-name encoding in
 *     mcpRouter.resolveAll(), which collides with the leading token of
 *     hyphen-converted Pipedream tool names like gmail-find-email.)
 */
function dedupeLeadingToken(s: string): string {
  const dblMatch = s.match(/^([^_]+)__\1(_|$)/);
  if (dblMatch) return s.slice(dblMatch[1].length + 2);
  const parts = s.split("_");
  if (parts.length >= 2 && parts[0] && parts[0] === parts[1]) {
    return parts.slice(1).join("_");
  }
  return s;
}

// ── Helpers: tool input summary ────────────────────────────────────────────

function toolInputSummary(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  if (name === "delegate_skill") {
    const parts: string[] = [];
    if (typeof obj.skill_name === "string") parts.push(obj.skill_name);
    if (typeof obj.instruction === "string") parts.push(obj.instruction);
    return parts.join(": ");
  }
  if (name.startsWith("delegate_") && typeof obj.instruction === "string") {
    return obj.instruction;
  }
  if (name === "inject_text" && typeof obj.text === "string") return obj.text;
  if (name === "run_command" && typeof obj.command === "string") return obj.command;
  if (name === "save_memory") {
    if (typeof obj.content === "string") return obj.content;
    if (typeof obj.text === "string") return obj.text;
  }
  const firstStr = Object.values(obj).find((v) => typeof v === "string");
  return typeof firstStr === "string" ? firstStr : "";
}

// ── Helpers: TodoWrite checklist ───────────────────────────────────────────

function renderTodoChecklist(input: unknown): void {
  const todos = (input as any)?.todos;
  if (!Array.isArray(todos)) return;
  ensureTimeline();
  if (!yoTodoEl) {
    yoTodoEl = document.createElement("div");
    yoTodoEl.className = "yo-todo-checklist";
    yoTimelineEl!.appendChild(yoTodoEl);
  }
  yoTodoEl.innerHTML = "";
  for (const item of todos) {
    const row = document.createElement("div");
    row.className = "yo-todo-item";
    const icon = document.createElement("span");
    icon.className = "yo-todo-icon";
    if (item.status === "completed") {
      icon.textContent = "✓";
      icon.classList.add("yo-todo-done");
    } else if (item.status === "in_progress") {
      icon.textContent = "○";
      icon.classList.add("yo-todo-active");
    } else {
      icon.textContent = "○";
    }
    const label = document.createElement("span");
    label.className = "yo-todo-label";
    if (item.status === "completed") label.classList.add("yo-todo-label-done");
    label.textContent = item.content || "";
    row.appendChild(icon);
    row.appendChild(label);
    yoTodoEl.appendChild(row);
  }
  yoScroll();
}

// ── Helpers: tool rows ─────────────────────────────────────────────────────

function findToolRowByName(toolName: string): HTMLElement | null {
  for (const [, el] of yoToolRows) {
    if (el.dataset.tool === toolName) return el;
  }
  return null;
}

function startToolRow(id: string, name: string, input: unknown) {
  ensureTimeline();
  const block = document.createElement("div");
  block.className = "yo-result-block yo-active";
  block.dataset.tool = name;

  const header = document.createElement("div");
  header.className = "yo-result-header";

  const dot = document.createElement("span");
  dot.className = "yo-ag-dot";
  header.appendChild(dot);

  const headings = document.createElement("div");
  headings.className = "yo-result-headings";

  const nameEl = document.createElement("span");
  nameEl.className = "yo-result-name";
  nameEl.textContent = formatToolDisplayName(name);
  headings.appendChild(nameEl);

  const isDelegate = name.startsWith("delegate_");
  const subtitleText = toolInputSummary(name, input);

  if (isDelegate && subtitleText) {
    const instrBox = document.createElement("div");
    instrBox.className = "yo-delegate-instruction";
    const preview = document.createElement("div");
    preview.className = "yo-delegate-preview";
    preview.textContent = subtitleText.length > 120 ? subtitleText.slice(0, 120) + "..." : subtitleText;
    instrBox.appendChild(preview);
    if (subtitleText.length > 120) {
      const full = document.createElement("div");
      full.className = "yo-delegate-full hidden";
      full.textContent = subtitleText;
      instrBox.appendChild(full);
      instrBox.addEventListener("click", (e) => {
        e.stopPropagation();
        const isExpanded = !full.classList.contains("hidden");
        full.classList.toggle("hidden");
        preview.classList.toggle("hidden");
        instrBox.classList.toggle("yo-delegate-expanded", !isExpanded);
      });
    }
    headings.appendChild(instrBox);
  } else if (subtitleText) {
    const sub = document.createElement("span");
    sub.className = "yo-result-subtitle";
    sub.textContent = subtitleText;
    // For file tools, make the path a link that opens it in the .Yo Editor.
    if (/(read|edit|write|create)/i.test(name)) {
      sub.classList.add("yo-file-link");
      sub.title = "Open in .Yo Editor";
      sub.addEventListener("click", (e) => {
        e.stopPropagation();
        window.yo.openInEditor(subtitleText);
      });
    }
    headings.appendChild(sub);
  }
  header.appendChild(headings);
  block.appendChild(header);

  yoTimelineEl!.appendChild(block);
  yoToolRows.set(id, block);
  yoScroll();
}

function cleanToolDetail(raw: string): string {
  let text = raw.trim();
  const stackIdx = text.indexOf("\n    at ");
  if (stackIdx > 0) text = text.slice(0, stackIdx).trim();
  const traceIdx = text.indexOf("\nstack:");
  if (traceIdx > 0) text = text.slice(0, traceIdx).trim();
  text = text.replace(/^(Error|ConfigurationError|TypeError|ReferenceError):\s*/i, "");
  const msgMatch = text.match(/"message"\s*:\s*"([^"]+)"/);
  if (msgMatch) text = msgMatch[1];
  const seeMore = text.indexOf("[See more information here]");
  if (seeMore > 0) text = text.slice(0, seeMore).trim();
  return text;
}

function finishToolRow(id: string, detail: string) {
  const block = yoToolRows.get(id);
  yoToolRows.delete(id);
  if (!block) return;
  block.classList.remove("yo-active");
  block.classList.add("yo-done");

  const trimmed = cleanToolDetail(detail);
  if (trimmed) {
    const content = document.createElement("div");
    content.className = "yo-result-content";
    content.textContent = trimmed;
    block.appendChild(content);

    const showLess = document.createElement("button");
    showLess.type = "button";
    showLess.className = "yo-result-show-less";
    showLess.textContent = "Show less";
    block.appendChild(showLess);

    block.classList.add("yo-has-detail");

    requestAnimationFrame(() => {
      if (content.scrollHeight > content.clientHeight + 1) {
        content.classList.add("yo-overflow");
      }
    });

    block.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (block.classList.contains("yo-expanded")) {
        if (target.closest(".yo-result-show-less")) {
          block.classList.remove("yo-expanded");
        }
      } else {
        block.classList.add("yo-expanded");
      }
    });
  }
  yoScroll();
}

function updateToolProgress(id: string, status: string) {
  const block = yoToolRows.get(id);
  if (!block) return;
  const headings = block.querySelector(".yo-result-headings");
  if (!headings) return;
  let sub = headings.querySelector(".yo-result-subtitle") as HTMLElement | null;
  if (!sub) {
    sub = document.createElement("span");
    sub.className = "yo-result-subtitle";
    headings.appendChild(sub);
  }
  sub.textContent = status;
}

// ── Helpers: status ────────────────────────────────────────────────────────

function showYoStatus(_toolText: string) {
  if (yoStatusEl) return;
  yoStatusEl = document.createElement("div");
  yoStatusEl.className = "yo-msg yo-msg-status";
  const phrase = PHRASES[Math.floor(Math.random() * PHRASES.length)];
  yoStatusEl.innerHTML =
    `<span class="yo-ag-spinner">⠋</span>` +
    `<span class="yo-ag-phrase">${phrase}...</span>`;
  yoPanelMessages.appendChild(yoStatusEl);
  startSpinner(yoStatusEl);
}

function clearYoStatus() {
  stopSpinner();
  if (yoStatusEl) { yoStatusEl.remove(); yoStatusEl = null; }
}

// ── Helpers: tool use/result ───────────────────────────────────────────────

function showYoToolUse(id: string, name: string, input: unknown) {
  yoToolsUsed = true;

  if (!yoStatusEl) showYoStatus("");

  closeOpenTextBlock();

  if (name === "TodoWrite") {
    renderTodoChecklist(input);
    return;
  }

  startToolRow(id, name, input);

  if (yoStatusEl) yoPanelMessages.appendChild(yoStatusEl);
}

function showYoToolResult(id: string, detail: string) {
  finishToolRow(id, detail);
  if (yoThinking && !yoStatusEl) showYoStatus("");
  if (yoStatusEl) yoPanelMessages.appendChild(yoStatusEl);
}

// ── Helpers: text streaming ────────────────────────────────────────────────

function closeOpenTextBlock() {
  if (_mdRenderTimer) { clearTimeout(_mdRenderTimer); _mdRenderTimer = null; }
  if (yoResponseEl && yoLastAssistantText.trim()) {
    yoResponseEl.classList.remove("yo-msg-streaming");
    yoResponseEl.innerHTML = formatMarkdown(yoLastAssistantText);
    attachCopyHandlers(yoResponseEl);
  } else if (yoResponseEl && !yoLastAssistantText.trim()) {
    yoResponseEl.remove();
  }
  yoResponseEl = null;
  yoLastAssistantText = "";
}

function appendYoToken(delta: string) {
  if (!delta) return;
  if (!yoResponseEl) {
    clearYoStatus();
    yoResponseEl = document.createElement("div");
    yoResponseEl.className = "yo-msg yo-msg-assistant yo-msg-streaming";
    yoPanelMessages.appendChild(yoResponseEl);
  }
  yoLastAssistantText += delta;
  yoTurnFullText += delta;

  if (!_mdRenderTimer) {
    _mdRenderTimer = setTimeout(() => {
      _mdRenderTimer = null;
      if (yoResponseEl && yoLastAssistantText) {
        yoResponseEl.innerHTML = formatMarkdown(yoLastAssistantText);
        yoScroll();
      }
    }, 80);
  }
}

// ── Helpers: finalize message ──────────────────────────────────────────────

function finalizeYoMessage(fullText: string) {
  clearYoStatus();
  setYoThinking(false);
  finishTimeline();

  if (!yoResponseEl && fullText && fullText.trim()) {
    yoResponseEl = document.createElement("div");
    yoResponseEl.className = "yo-msg yo-msg-assistant";
    yoPanelMessages.appendChild(yoResponseEl);
    yoLastAssistantText = fullText;
    yoTurnFullText += fullText;
  }

  const text = yoTurnFullText || yoLastAssistantText || fullText;

  if (yoResponseEl) {
    yoResponseEl.classList.remove("yo-msg-streaming");
    yoResponseEl.innerHTML = formatMarkdown(yoLastAssistantText || fullText);
    attachCopyHandlers(yoResponseEl);
  }

  if (yoResponseEl && text.trim()) {
    const actions = document.createElement("div");
    actions.className = "yo-msg-actions";
    const copyBtn = document.createElement("button");
    copyBtn.className = "yo-msg-copy-btn";
    copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>Copy</span>`;
    copyBtn.addEventListener("click", () => {
      const doCopy = () => {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0;";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      };
      try {
        if (window.yo.copyToClipboard) {
          window.yo.copyToClipboard(text);
        } else {
          doCopy();
        }
      } catch { doCopy(); }
      copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg><span>Copied</span>`;
      copyBtn.classList.add("yo-copied");
      setTimeout(() => {
        copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>Copy</span>`;
        copyBtn.classList.remove("yo-copied");
      }, 2000);
    });
    actions.appendChild(copyBtn);
    yoResponseEl.appendChild(actions);
  }

  yoLastAssistantText = "";
  yoTurnFullText = "";
  yoResponseEl = null;

  if (currentMode === "plan" && yoLastUserText) {
    showPlanActions();
  }

  yoScroll();
  yoPanelInput.focus();
}

// ── Helpers: plan actions ──────────────────────────────────────────────────

function showPlanActions() {
  const card = document.createElement("div");
  card.className = "yo-plan-actions";
  card.innerHTML =
    `<button class="yo-plan-btn yo-plan-proceed">Proceed</button>` +
    `<button class="yo-plan-btn yo-plan-auto">Proceed (auto)</button>` +
    `<button class="yo-plan-btn yo-plan-edit">Edit</button>`;
  yoPanelMessages.appendChild(card);

  card.querySelector(".yo-plan-proceed")!.addEventListener("click", () => {
    card.remove();
    window.yo.setAgentMode("default");
    setPermValue("default");
    showYoStatus("");
    setYoThinking(true);
    window.yo.yoPanelSend("Execute the plan above.");
  });

  card.querySelector(".yo-plan-auto")!.addEventListener("click", () => {
    card.remove();
    window.yo.setAgentMode("acceptEdits");
    setPermValue("acceptEdits");
    showYoStatus("");
    setYoThinking(true);
    window.yo.yoPanelSend("Execute the plan above.");
  });

  card.querySelector(".yo-plan-edit")!.addEventListener("click", () => {
    card.remove();
    yoPanelInput.value = yoLastUserText;
    yoPanelInput.focus();
    autoGrowYoInput();
  });
}

// ── Helpers: copy/link handlers ────────────────────────────────────────────

function attachCopyHandlers(container: HTMLElement) {
  container.querySelectorAll<HTMLButtonElement>(".yo-md-copy-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const codeId = btn.dataset.codeId;
      if (!codeId) return;
      const block = container.querySelector(`.yo-md-codeblock[data-code-id="${codeId}"] code`);
      if (!block) return;
      window.yo.copyToClipboard(block.textContent || "");
      btn.textContent = "Copied";
      btn.classList.add("yo-copied");
      setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("yo-copied"); }, 2000);
    });
  });
  container.querySelectorAll<HTMLElement>(".yo-md-cmd").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const cmd = el.dataset.cmd || el.textContent || "";
      window.yo.copyToClipboard(cmd);
      el.classList.add("yo-cmd-copied");
      const orig = el.textContent;
      el.textContent = "Copied!";
      setTimeout(() => { el.textContent = orig; el.classList.remove("yo-cmd-copied"); }, 1500);
    });
  });
  container.querySelectorAll<HTMLAnchorElement>(".yo-md-link").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const href = a.getAttribute("href");
      if (href) window.yo.openExternal(href);
    });
  });
}

// ── Helpers: error display ─────────────────────────────────────────────────

function showYoError(err: string) {
  clearYoStatus();
  setYoThinking(false);
  pendingYoMessages = [];
  finishTimeline();
  if (yoResponseEl) { yoResponseEl.remove(); yoResponseEl = null; }
  yoLastAssistantText = "";
  yoTurnFullText = "";
  const cleaned = err
    .replace(/Claude Code/gi, ".Yo")
    .replace(/Claude/gi, ".Yo")
    .replace(/Anthropic/gi, ".Yo");
  const el = document.createElement("div");
  el.className = "yo-msg yo-msg-error";
  el.textContent = cleaned;
  yoPanelMessages.appendChild(el);
  yoScroll();
  yoPanelInput.focus();
}

// ── Helpers: input management ──────────────────────────────────────────────

function autoGrowYoInput() {
  yoPanelInput.style.height = "40px";
  yoPanelInput.style.height = Math.min(yoPanelInput.scrollHeight, 160) + "px";
}

function sendYoPanelMessage() {
  const text = yoPanelInput.value.trim();
  if (!text) return;

  if (/^\.rec$/i.test(text) && yoPanelMicBtn) {
    yoPanelInput.value = "";
    autoGrowYoInput();
    yoPanelMicBtn.click();
    return;
  }

  // Agent busy → queue the message; it shows immediately and is sent when the
  // current turn finishes (see drainPendingYoMessages).
  if (yoThinking) {
    hideYoWelcome();
    yoPanelInput.value = "";
    autoGrowYoInput();
    addYoUserMessage(text);
    pendingYoMessages.push(text);
    return;
  }

  hideYoWelcome();
  closeOpenTextBlock();
  yoPanelInput.value = "";
  autoGrowYoInput();
  yoToolsUsed = false;
  yoTimelineEl = null;
  yoTodoEl = null;
  yoSpinnerEl = null;
  yoLastAssistantText = "";
  yoTurnFullText = "";
  yoLastUserText = text;
  addYoUserMessage(text);
  if (/\.yo\b/i.test(text)) {
    window.yo.dripsPreview("cat");
  }
  showYoStatus("");
  setYoThinking(true);
  window.yo.yoPanelSend(text);
}

/** Send the next queued message, if any, once a turn finishes. */
function drainPendingYoMessages() {
  if (pendingYoMessages.length === 0) return;
  const next = pendingYoMessages.shift()!;
  closeOpenTextBlock();
  yoToolsUsed = false;
  yoTimelineEl = null;
  yoTodoEl = null;
  yoSpinnerEl = null;
  yoLastAssistantText = "";
  yoTurnFullText = "";
  yoLastUserText = next;
  showYoStatus("");
  setYoThinking(true);
  window.yo.yoPanelSend(next);
}

// ── Helpers: voice tones ───────────────────────────────────────────────────

function playTone(freq: number, durationMs: number, volume = 0.15) {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.value = volume;
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durationMs / 1000);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + durationMs / 1000);
  osc.onended = () => ctx.close();
}
function playRecordStart() { playTone(880, 120); setTimeout(() => playTone(1320, 100), 130); }
function playRecordStop() { playTone(1320, 120); setTimeout(() => playTone(880, 100), 130); }

// ── Helpers: chat history ──────────────────────────────────────────────────

async function loadYoHistory() {
  const chats = await window.yo.yoChatsList();
  yoHistoryList.innerHTML = "";
  if (chats.length === 0) {
    const empty = document.createElement("div");
    empty.className = "yo-history-empty";
    empty.textContent = "no conversations yet";
    yoHistoryList.appendChild(empty);
    return;
  }
  for (const chat of chats) {
    const item = document.createElement("div");
    item.className = "yo-history-item";

    const title = document.createElement("span");
    title.className = "yo-history-title";
    title.textContent = chat.title || chat.id;

    const date = document.createElement("span");
    date.className = "yo-history-date";
    if (chat.created) {
      const d = new Date(chat.created);
      const now = new Date();
      if (d.toDateString() === now.toDateString()) {
        date.textContent = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      } else {
        date.textContent = d.toLocaleDateString([], { month: "short", day: "numeric" });
      }
    }

    const del = document.createElement("button");
    del.className = "yo-history-delete";
    del.textContent = "×";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      await window.yo.yoChatsDelete(chat.id);
      loadYoHistory();
    });

    item.appendChild(title);
    item.appendChild(date);
    item.appendChild(del);
    item.addEventListener("click", async () => {
      const messages = await window.yo.yoChatsLoad(chat.id);
      if (messages) {
        yoPanelMessages.innerHTML = "";
        yoResponseEl = null;
        yoStatusEl = null;
        yoLastAssistantText = "";
        yoTurnFullText = "";
        yoHistoryPanel.classList.add("hidden");

        for (const msg of messages) {
          if (msg.role === "assistant" && msg.tools && msg.tools.length > 0) {
            const timeline = document.createElement("div");
            timeline.className = "yo-ag-timeline done";
            for (const tool of msg.tools) {
              const block = document.createElement("div");
              block.className = "yo-result-block yo-done";
              const header = document.createElement("div");
              header.className = "yo-result-header";
              const dot = document.createElement("span");
              dot.className = "yo-ag-dot";
              header.appendChild(dot);
              const headings = document.createElement("div");
              headings.className = "yo-result-headings";
              const nameEl = document.createElement("span");
              nameEl.className = "yo-result-name";
              nameEl.textContent = formatToolDisplayName(tool.name);
              headings.appendChild(nameEl);
              const sub = toolInputSummary(tool.name, tool.input);
              if (sub) {
                const subEl = document.createElement("span");
                subEl.className = "yo-result-subtitle";
                subEl.textContent = sub;
                headings.appendChild(subEl);
              }
              header.appendChild(headings);
              block.appendChild(header);
              timeline.appendChild(block);
            }
            yoPanelMessages.appendChild(timeline);
          }

          const el = document.createElement("div");
          if (msg.role === "user") {
            el.className = "yo-msg yo-msg-user";
            el.textContent = msg.text;
          } else {
            if (!msg.text) continue;
            el.className = "yo-msg yo-msg-assistant";
            el.innerHTML = formatMarkdown(msg.text);
            attachCopyHandlers(el);
          }
          yoPanelMessages.appendChild(el);
        }
        yoLastAssistantText = "";
        yoTurnFullText = "";
        yoScroll();
      }
    });
    yoHistoryList.appendChild(item);
  }
}

// ── Panel open/close ───────────────────────────────────────────────────────

async function openYoPanel(query: string) {
  if (!yoControlsInited) {
    yoControlsInited = true;
    initYoControls();
  }

  const defaultWidth = 380;
  yoPanel.style.width = `${defaultWidth}px`;
  document.body.style.setProperty("--right-inset", `${defaultWidth}px`);
  window.yo.yoPanelResize(defaultWidth);
  yoPanel.classList.remove("hidden");
  void yoPanel.offsetHeight;
  yoPanel.classList.add("open");
  yoToolsUsed = false;
  yoTimelineEl = null;
  yoSpinnerEl = null;
  if (query) {
    hideYoWelcome();
    addYoUserMessage(query);
    showYoStatus("");
    setYoThinking(true);
    window.yo.yoPanelSend(query);
  } else if (!yoPanelMessages.children.length) {
    showYoWelcome();
  }
  yoPanelInput.value = "";
  autoGrowYoInput();
  setTimeout(() => { yoPanelInput.focus(); yoPanelInput.select(); _renderGridHandles(); }, 220);

  try {
    const [account, savedWidth] = await Promise.all([
      window.yo.getAccountInfo(),
      window.yo.yoPanelGetWidth(),
    ]);
    if (savedWidth && savedWidth !== defaultWidth) {
      yoPanel.style.width = `${savedWidth}px`;
      document.body.style.setProperty("--right-inset", `${savedWidth}px`);
      window.yo.yoPanelResize(savedWidth);
    }
    const titleEl = document.querySelector(".yo-panel-title");
    if (titleEl && account?.firstName) {
      titleEl.innerHTML = `<span class="yo-dot">.</span>Yo <span class="yo-dot">.</span>Sup ${account.firstName}`;
    }
  } catch { /* panel is already open — personalization is best-effort */ }
}

function closeYoPanel() {
  yoPanel.classList.remove("open");
  document.body.style.setProperty("--right-inset", "0px");
  setTimeout(() => {
    yoPanel.classList.add("hidden");
    yoPanelMessages.innerHTML = "";
    yoResponseEl = null;
    yoStatusEl = null;
    yoLastAssistantText = "";
    yoTurnFullText = "";
    yoTimelineEl = null;
    yoSpinnerEl = null;
    _renderGridHandles();
  }, 200);
}

function isYoPanelOpen(): boolean {
  return yoPanel.classList.contains("open");
}

// ── Init ───────────────────────────────────────────────────────────────────

export function initYoPanel(callbacks: YoPanelCallbacks): YoPanelApi {
  _renderGridHandles = callbacks.renderGridHandles;

  // Query DOM elements
  yoPanel = document.getElementById("yo-panel")!;
  yoPanelMessages = document.getElementById("yo-panel-messages")!;
  yoPanelInput = document.getElementById("yo-panel-input") as HTMLTextAreaElement;
  yoPanelSendBtn = document.getElementById("yo-panel-send")!;
  yoPanelMicBtn = document.getElementById("yo-panel-mic") as HTMLButtonElement | null;
  yoScrollBtn = document.getElementById("yo-scroll-btn")!;
  yoPanelCloseBtn = document.querySelector(".yo-panel-close")!;
  yoPanelResize = document.getElementById("yo-panel-resize")!;
  yoHistoryToggle = document.getElementById("yo-history-toggle")!;
  yoHistoryPanel = document.getElementById("yo-history")!;
  yoHistoryList = document.getElementById("yo-history-list")!;
  yoChatNewBtn = document.getElementById("yo-chat-new")!;

  // Mode/perm dropdown elements
  yoModeDropdown = document.getElementById("yo-mode-dropdown")!;
  yoModeTrigger = document.getElementById("yo-mode-trigger")!;
  yoModeMenu = document.getElementById("yo-mode-menu")!;
  yoModeOptions = yoModeMenu.querySelectorAll(".yo-mode-option");
  yoPermDropdown = document.getElementById("yo-perm-dropdown")!;
  yoPermTrigger = document.getElementById("yo-perm-trigger")!;
  yoPermMenu = document.getElementById("yo-perm-menu")!;
  yoPermOptions = yoPermMenu.querySelectorAll(".yo-perm-option");

  // -- Scroll-to-bottom button --
  yoPanelMessages.addEventListener("scroll", () => {
    const gap = yoPanelMessages.scrollHeight - yoPanelMessages.scrollTop - yoPanelMessages.clientHeight;
    yoScrollBtn.classList.toggle("visible", gap > 40);
  });
  yoScrollBtn.addEventListener("click", () => {
    yoPanelMessages.scrollTop = yoPanelMessages.scrollHeight;
  });

  // -- Mic button visibility --
  if (yoPanelMicBtn) {
    yoPanelMicBtn.style.display = "none";
    window.yo.getPreference("voiceEnabled", false).then((v) => {
      yoPanelMicBtn!.style.display = v ? "" : "none";
    });
  }

  // -- Mode dropdown listeners --
  yoModeTrigger.addEventListener("click", (e) => {
    e.stopPropagation();
    yoModeMenu.classList.toggle("hidden");
    yoPermMenu.classList.add("hidden");
  });

  yoModeOptions.forEach((opt) => {
    opt.addEventListener("click", () => {
      const value = (opt as HTMLElement).dataset.value!;
      setModeValue(value);
      syncAgentMode();
      yoModeMenu.classList.add("hidden");
    });
  });

  yoPermTrigger.addEventListener("click", (e) => {
    e.stopPropagation();
    yoPermMenu.classList.toggle("hidden");
    yoModeMenu.classList.add("hidden");
  });

  yoPermOptions.forEach((opt) => {
    opt.addEventListener("click", () => {
      const value = (opt as HTMLElement).dataset.value!;
      setPermValue(value);
      syncAgentMode();
      yoPermMenu.classList.add("hidden");
    });
  });

  document.addEventListener("click", (e) => {
    if (!yoModeDropdown.contains(e.target as Node)) {
      yoModeMenu.classList.add("hidden");
    }
    if (!yoPermDropdown.contains(e.target as Node)) {
      yoPermMenu.classList.add("hidden");
    }
  });

  // -- Mode changes from main process --
  window.yo.onAgentModeChanged?.((mode: string) => {
    if (mode === "standard" || mode === "council" || mode === "cypher") {
      setModeValue(mode);
    } else {
      setModeValue("standard");
      setPermValue(mode);
    }
    applyModeColor();
    if (mode === "cypher" && !isYoPanelOpen()) {
      openYoPanel("");
    }
  });

  // -- Auto-grow textarea --
  yoPanelInput.addEventListener("input", autoGrowYoInput);

  // -- IPC listeners --
  window.yo.onYoPanelOpen((query) => openYoPanel(query));
  window.yo.onYoPanelToggle(() => {
    if (isYoPanelOpen()) {
      window.yo.yoPanelDismiss();
    } else {
      window.yo.yoPanelOpen("");
      openYoPanel("");
    }
  });
  window.yo.onYoPanelKickoff((prompt: string) => {
    hideYoWelcome();
    addYoUserMessage(prompt);
    setYoThinking(true);
  });
  window.yo.onYoPanelToken((delta) => appendYoToken(delta));
  window.yo.onYoPanelToolUse((id, name, input) => showYoToolUse(id, name, input));
  window.yo.onYoPanelToolResult((id, detail) => showYoToolResult(id, detail));
  window.yo.onYoPanelToolProgress((id, status) => updateToolProgress(id, status));
  window.yo.onYoPanelDone((fullText) => { finalizeYoMessage(fullText); drainPendingYoMessages(); });
  window.yo.onYoPanelError((err) => showYoError(err));
  window.yo.onYoPanelClose(() => closeYoPanel());
  // Cypher chat no longer renders in the private yo panel — it belongs in
  // the shared cypher feed (three-layer model). See main.ts chat routing.
  window.yo.onYoPanelDripEffect((recipe) => {
    window.yo.dripsPreview(recipe);
  });
  window.yo.onYoPanelCouncilReady((info) => {
    hideYoWelcome();
    const el = document.createElement("div");
    el.className = "yo-msg yo-msg-assistant";
    const members = info.members.map((m: any) => `<strong>${typeof m === "string" ? m : m.model || m.provider}</strong>`).join(", ");
    el.innerHTML = `<div style="margin-bottom:8px"><strong>Council "${info.name}"</strong> is ready.</div>` +
      `<div style="font-size:12px;color:var(--text-2);margin-bottom:8px">${members}<br>Style: ${info.style} &middot; ${info.round_cap} rounds max</div>` +
      `<div style="font-size:12px;color:var(--text-3)">` +
      `Say <strong>"go"</strong> to start round 1<br>` +
      `Ask a specific member a question<br>` +
      `Add guidance before starting with <strong>"interject"</strong><br>` +
      `<strong>"stop"</strong> or <strong>"summarize"</strong> at any time</div>`;
    yoPanelMessages.appendChild(el);
    yoPanelMessages.scrollTop = yoPanelMessages.scrollHeight;
  });

  // -- Send/stop button --
  yoPanelSendBtn.addEventListener("click", () => {
    if (yoThinking) {
      window.yo.yoPanelStop();
      clearYoStatus();
      finishTimeline();
      setYoThinking(false);
      pendingYoMessages = [];
      const quip = STOP_QUIPS[Math.floor(Math.random() * STOP_QUIPS.length)];
      const stopEl = document.createElement("div");
      stopEl.className = "yo-msg yo-msg-stopped";
      stopEl.innerHTML = `<em>${quip}</em>`;
      yoPanelMessages.appendChild(stopEl);
      yoResponseEl = null;
      yoScroll();
    } else {
      sendYoPanelMessage();
    }
  });

  // -- Enter to send --
  yoPanelInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendYoPanelMessage();
    }
  });

  // -- Voice input --
  if (yoPanelMicBtn) {
    let recording = false;
    let mediaRecorder: MediaRecorder | null = null;
    let audioChunks: Blob[] = [];
    let micStream: MediaStream | null = null;
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    let silenceCheckInterval: ReturnType<typeof setInterval> | null = null;

    const SILENCE_THRESHOLD = 0.01;
    const SILENCE_TIMEOUT = 1500;

    function stopRecording() {
      if (silenceCheckInterval) { clearInterval(silenceCheckInterval); silenceCheckInterval = null; }
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
      mediaRecorder?.stop();
    }

    yoPanelMicBtn.addEventListener("click", async () => {
      if (yoThinking) return;

      if (recording) {
        stopRecording();
        return;
      }

      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        console.warn("Mic access denied:", err);
        return;
      }

      recording = true;
      audioChunks = [];
      yoPanelMicBtn!.classList.add("listening");
      playRecordStart();

      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(micStream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      let speaking = false;

      silenceCheckInterval = setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        const rms = Math.sqrt(buf.reduce((sum, v) => sum + v * v, 0) / buf.length);

        if (rms > SILENCE_THRESHOLD) {
          speaking = true;
          if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
        } else if (speaking && !silenceTimer) {
          silenceTimer = setTimeout(() => {
            audioCtx.close();
            stopRecording();
          }, SILENCE_TIMEOUT);
        }
      }, 100);

      mediaRecorder = new MediaRecorder(micStream, { mimeType: "audio/webm" });
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        recording = false;
        yoPanelMicBtn!.classList.remove("listening");
        playRecordStop();
        if (silenceCheckInterval) { clearInterval(silenceCheckInterval); silenceCheckInterval = null; }
        if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
        micStream?.getTracks().forEach((t) => t.stop());
        micStream = null;

        if (audioChunks.length === 0) return;

        const blob = new Blob(audioChunks, { type: "audio/webm" });
        audioChunks = [];

        const arrayBuf = await blob.arrayBuffer();
        const decodeCtx = new AudioContext({ sampleRate: 16000 });
        let decoded: AudioBuffer;
        try {
          decoded = await decodeCtx.decodeAudioData(arrayBuf);
        } catch {
          console.warn("Failed to decode audio");
          decodeCtx.close();
          return;
        }
        const mono = decoded.getChannelData(0);
        decodeCtx.close();

        yoPanelMicBtn!.classList.add("disabled");
        yoPanelMicBtn!.title = "Transcribing...";

        const result = await window.yo.transcribeAudio(mono.buffer as ArrayBuffer);

        yoPanelMicBtn!.classList.remove("disabled");
        yoPanelMicBtn!.title = "Voice input";

        if (result.ok && result.text) {
          yoPanelInput.value = (yoPanelInput.value + " " + result.text).trim();
          yoPanelInput.style.height = "auto";
          yoPanelInput.style.height = yoPanelInput.scrollHeight + "px";
          yoPanelInput.focus();
        } else if (!result.ok) {
          const errMsg = (result.error || "Transcription failed")
            .replace(/^Whisper API \d+:\s*/, "")
            .replace(/\{[\s\S]*$/, "")
            .trim() || "Transcription failed";
          const el = document.createElement("div");
          el.className = "yo-msg yo-msg-error";
          el.textContent = errMsg;
          yoPanelMessages.appendChild(el);
          yoScroll();
        }
      };

      mediaRecorder.start();
    });
  }

  // -- Close button --
  yoPanelCloseBtn.addEventListener("click", () => {
    window.yo.yoPanelDismiss();
  });

  // -- Resize handle --
  let yoPanelDragging = false;

  yoPanelResize.addEventListener("mousedown", (e) => {
    e.preventDefault();
    yoPanelDragging = true;
    yoPanelResize.classList.add("dragging");
    yoPanel.style.transition = "none";
  });

  document.addEventListener("mousemove", (e) => {
    if (!yoPanelDragging) return;
    const newWidth = Math.max(280, Math.min(window.innerWidth * 0.6, window.innerWidth - e.clientX));
    yoPanel.style.width = `${newWidth}px`;
    document.body.style.setProperty("--right-inset", `${newWidth}px`);
    window.yo.yoPanelResize(newWidth);
  });

  document.addEventListener("mouseup", () => {
    if (!yoPanelDragging) return;
    yoPanelDragging = false;
    yoPanelResize.classList.remove("dragging");
    yoPanel.style.transition = "";
    const width = parseInt(yoPanel.style.width, 10);
    if (width) window.yo.yoPanelWidthSave(width);
  });

  // -- Chat history --
  yoHistoryToggle.addEventListener("click", () => {
    const isHidden = yoHistoryPanel.classList.contains("hidden");
    if (isHidden) {
      loadYoHistory();
      yoHistoryPanel.classList.remove("hidden");
    } else {
      yoHistoryPanel.classList.add("hidden");
    }
  });

  yoChatNewBtn.addEventListener("click", async () => {
    await window.yo.yoChatNew();
    yoPanelMessages.innerHTML = "";
    yoResponseEl = null;
    yoStatusEl = null;
    yoLastAssistantText = "";
    yoTurnFullText = "";
    yoHistoryPanel.classList.add("hidden");
    yoPanelInput.focus();
  });

  // -- Approval UI --
  window.yo.onApprovalRequest((id, toolName, toolLabel, input) => {
    const inputObj = input as Record<string, unknown>;
    let detail = "";
    if (typeof inputObj.instruction === "string") detail = inputObj.instruction;
    else if (typeof inputObj.text === "string") detail = inputObj.text;
    else if (typeof inputObj.command === "string") detail = inputObj.command;
    else if (typeof inputObj.url === "string") detail = inputObj.url;
    else if (typeof inputObj.panel_id === "string") detail = `panel: ${inputObj.panel_id}`;
    else {
      const first = Object.values(inputObj).find((v) => typeof v === "string");
      if (typeof first === "string") detail = first;
    }

    const card = document.createElement("div");
    card.className = "yo-approval-card";
    card.innerHTML =
      `<div class="yo-approval-header">` +
        `<span class="yo-approval-icon">?</span>` +
        `<span class="yo-approval-title">${toolLabel}</span>` +
      `</div>` +
      (detail ? `<div class="yo-approval-detail">${detail.replace(/&/g, "&amp;").replace(/</g, "&lt;").slice(0, 200)}</div>` : "") +
      `<div class="yo-approval-actions">` +
        `<button class="yo-approval-btn yo-approval-allow">Allow</button>` +
        `<button class="yo-approval-btn yo-approval-deny">Deny</button>` +
      `</div>`;

    const toolRow = findToolRowByName(toolName);
    if (toolRow) {
      toolRow.appendChild(card);
    } else if (yoStatusEl) {
      yoStatusEl.before(card);
    } else {
      yoPanelMessages.appendChild(card);
    }
    yoScroll();

    card.querySelector(".yo-approval-allow")!.addEventListener("click", () => {
      window.yo.approvalRespond(id, true);
      card.classList.add("yo-approval-resolved", "yo-approval-allowed");
      card.querySelector(".yo-approval-actions")!.remove();
      const status = document.createElement("span");
      status.className = "yo-approval-status allowed";
      status.textContent = "allowed";
      card.querySelector(".yo-approval-header")!.appendChild(status);
    });

    card.querySelector(".yo-approval-deny")!.addEventListener("click", () => {
      window.yo.approvalRespond(id, false);
      card.classList.add("yo-approval-resolved", "yo-approval-denied");
      card.querySelector(".yo-approval-actions")!.remove();
      const status = document.createElement("span");
      status.className = "yo-approval-status denied";
      status.textContent = "denied";
      card.querySelector(".yo-approval-header")!.appendChild(status);
    });
  });

  // Return the public API
  return {
    openYoPanel,
    closeYoPanel,
    isYoPanelOpen,
    yoScroll,
    showYoWelcome,
    hideYoWelcome,
    getYoPanelWidth: () => yoPanel.offsetWidth,
  };
}
