/**
 * Yo panel — messaging, streaming, tool timeline, approval UI, voice input,
 * resize handle, and chat history.
 *
 * Extracted from renderer.ts. All DOM queries happen internally; the caller
 * supplies a `renderGridHandles` callback so the module can notify the layout
 * system when the panel opens/closes without importing renderer internals.
 *
 * The message-rendering layer is the VS Code-style chat renderer
 * (./chat-renderer); everything else (input, dropdowns, welcome, voice,
 * history, resize, approval, send/stop/queueing) is unchanged.
 */

import { brandForModel, logoUrlFor } from "./model-badges.js";
import { ChatRenderer } from "./chat-renderer/index.js";
import { yoConfirm, hidePanelsForModal, restorePanelsForModal } from "./yo-modal.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface YoPanelApi {
  openYoPanel: (query: string) => void;
  closeYoPanel: () => void;
  isYoPanelOpen: () => boolean;
  yoScroll: () => void;
  showYoWelcome: () => void;
  hideYoWelcome: () => void;
  getYoPanelWidth: () => number;
  // Chat history — exposed so the workspace Recents rail can drive it.
  listChats: () => Promise<Array<{ id: string; title: string; created: string; messageCount: number }>>;
  loadChat: (id: string) => Promise<void>;
  deleteChat: (id: string) => Promise<void>;
  newChat: () => Promise<void>;
}

export interface YoPanelCallbacks {
  renderGridHandles: () => void;
}

// ── DOM elements (queried once at init) ────────────────────────────────────

let yoPanel: HTMLElement;
let yoPanelMessages: HTMLElement;
// VS Code-style chat renderer — owns the message-rendering layer.
let chat: ChatRenderer;
let yoPanelInput: HTMLTextAreaElement;
let yoComposerHost: HTMLElement;
let yoPanelSendBtn: HTMLElement;
let yoPanelMicBtn: HTMLButtonElement | null;
let yoScrollBtn: HTMLElement;
let yoPanelResize: HTMLElement;
let yoHistoryToggle: HTMLElement;
let yoHistoryPanel: HTMLElement;
let yoHistoryList: HTMLElement;
let yoChatNewBtn: HTMLElement;

// ── Mode/model dropdowns ───────────────────────────────────────────────────

let yoPermDropdown: HTMLElement;
let yoPermTrigger: HTMLElement;
let yoPermMenu: HTMLElement;
let yoPermOptions: NodeListOf<Element>;
let yoControlsInited = false;

// Color is driven by PERMISSION. Plan is one of the permission options —
// when selected, it paints the trigger plan-purple.
const PLAN_COLOR = "#8B5CF6";

// Inline SVG icons matching yo-agent-renderer.PERM_ICONS so the right-rail
// trigger renders the same glyphs as the Agent app (no more emoji 🔒).
const PERM_ICONS: Record<string, string> = {
  default: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
  plan: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="12" y2="17"/></svg>`,
  acceptEdits: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
  bypassPermissions: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
};

const PERM_COLORS: Record<string, string> = {
  default: "#25C75E",
  plan: PLAN_COLOR,
  acceptEdits: "#FF8C00",
  bypassPermissions: "#FF2D55",
};

const PERM_LABELS: Record<string, string> = {
  default: "ask",
  plan: "plan",
  acceptEdits: "auto",
  bypassPermissions: "bypass",
};

let currentPerm = "default";
let currentChatModel: string = "";          // empty = use workspace default

// Shell-style input recall: ↑/↓ steps through previously sent prompts.
const yoInputHistory: string[] = [];
let yoHistIndex = 0;          // points one past the newest entry = the live draft
let yoHistDraft = "";         // the in-progress text, preserved while browsing back

const MODEL_PRETTY: Record<string, string> = {
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-opus-4-7":   "Opus 4.7",
  "claude-haiku-4-5":  "Haiku 4.5",
  "gpt-5-codex":       "GPT-5 Codex",
};
function prettyModelLabel(model: string): string {
  if (!model) return "Default";
  return MODEL_PRETTY[model] || model;
}

// ── Internal state ─────────────────────────────────────────────────────────

let yoThinking = false;
// Messages typed while the agent is busy — sent one by one as turns finish.
// Each keeps its DOM bubble so we can promote it (un-dim) when it's actually
// sent, or remove it if the user deletes it before the agent sees it.
interface PendingYoMessage { text: string; el: HTMLElement }
let pendingYoMessages: PendingYoMessage[] = [];

// Callback reference (set once at init)
let _renderGridHandles: () => void;

// ── Constants ──────────────────────────────────────────────────────────────

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
  // Input stays enabled while the agent works — messages queue (drained as
  // each turn finishes), so the user is never blocked from typing.
  paintSendButton();
}

/** Paint the send button based on (thinking × input has text). While the
 *  agent works, the default action is ■ stop — but the moment the user
 *  starts typing a follow-up, flip to ↑ so the click queues the message
 *  instead of aborting the turn. */
function paintSendButton() {
  const hasText = !!yoPanelInput?.value.trim();
  const showSend = !yoThinking || hasText;
  yoPanelSendBtn.textContent = showSend ? "↑" : "■";
  yoPanelSendBtn.classList.toggle("yo-stop", !showSend);
}

// ── Helpers: welcome screen ────────────────────────────────────────────────

/** Rotating welcome greetings. `{name}` is filled with the user's first name
 *  (or "there" when unknown). One is picked at random each time the welcome
 *  shows — same screen on app load and on a new session. */
const YO_GREETINGS: string[] = [
  "{name}, you ready?",
  "Ready when you are, {name}.",
  "What's the move, {name}?",
  "Let's get into it, {name}.",
  "Where do we start, {name}?",
  "What are we building, {name}?",
  "At your service, {name}.",
  "What's first, {name}?",
  "Point me at it, {name}.",
  "What do you need, {name}?",
  "Let's make something, {name}.",
  "Good to see you, {name}.",
  "What's on your plate, {name}?",
  "Ready to roll, {name}?",
  "Hit me, {name}.",
  "What's cooking, {name}?",
  "Let's knock it out, {name}.",
  "How can I help, {name}?",
  "What's the mission, {name}?",
  "Say the word, {name}.",
  "Let's do this, {name}.",
  "What's next, {name}?",
  "I'm all ears, {name}.",
  "What can I take off your plate, {name}?",
  "Throw me something, {name}.",
  "Let's get to work, {name}.",
  "What's the play, {name}?",
  "Standing by, {name}.",
  "Where to, {name}?",
  "What's the task, {name}?",
  "Let's ship something, {name}.",
  "Ready to dig in, {name}?",
  "What's the goal today, {name}?",
  "Fire away, {name}.",
  "What should we tackle, {name}?",
  "Let's make it happen, {name}.",
  "I've got you, {name}.",
  "What are we automating today, {name}?",
  "What's the ask, {name}?",
  "Let's get rolling, {name}.",
  "Tell me what you need, {name}.",
  "What's the agenda, {name}?",
  "Ready to crush it, {name}?",
  "Where's your head at, {name}?",
  "What's the problem, {name}?",
  "Let's sort it out, {name}.",
  "Lay it on me, {name}.",
  "What's the priority, {name}?",
  "Let's get after it, {name}.",
  "How's it going, {name}?",
  "What's the situation, {name}?",
  "Ready to dive in, {name}?",
  "What's the brief, {name}?",
  "Let's tackle it, {name}.",
  "What's grabbing your attention, {name}?",
  "Game on, {name}.",
  "What's the objective, {name}?",
  "Let's wrap something up, {name}.",
  "What needs doing, {name}?",
  "Whenever you're ready, {name}.",
  "What's the big thing today, {name}?",
  "Let's chip away at it, {name}.",
  "What's eating your time, {name}?",
  "Drop it here, {name}.",
  "What's the one thing, {name}?",
  "Let's move, {name}.",
  "What's slowing you down, {name}?",
  "Ready to go, {name}?",
  "What're we figuring out, {name}?",
  "Let's untangle it, {name}.",
  "What's the headache today, {name}?",
  "Show me what you've got, {name}.",
  "What's worth doing, {name}?",
  "Let's build, {name}.",
  "What's the deal, {name}?",
  "Pick a thread, {name}.",
  "What's on your mind, {name}?",
  "Let's clear the deck, {name}.",
  "What's the win today, {name}?",
  "Anything I can grab, {name}?",
  "What's the next step, {name}?",
  "Let's make progress, {name}.",
  "What's the focus, {name}?",
  "Ready to make a dent, {name}?",
  "What's the to-do, {name}?",
  "Let's get unstuck, {name}.",
  "What's looming, {name}?",
  "Bring it on, {name}.",
  "What's worth your time, {name}?",
  "Let's handle it, {name}.",
  "What's the first step, {name}?",
  "I'm ready when you are, {name}.",
  "What're we shipping today, {name}?",
  "Let's get it done, {name}.",
  "What's the target, {name}?",
  "Queue me up, {name}.",
  "What's the plan, {name}?",
  "Let's start, {name}.",
  "What can we knock out, {name}?",
  "You ready, {name}?",
];

function hideYoWelcome() {
  const w = document.getElementById("yo-panel-welcome");
  if (w) w.remove();
}

function fillGreeting(template: string): string {
  // No account/identity anymore — the greeting always uses the generic form.
  return template.replace(/\{name\}/g, "there");
}

function showYoWelcome() {
  const template = YO_GREETINGS[Math.floor(Math.random() * YO_GREETINGS.length)];

  // The ONE welcome: the empty-state greeting block (#yo-greeting, shown via
  // CSS when #yo-panel.empty). Just rotate its subline; never inject a second
  // welcome into yo-panel-messages (that would mark the panel non-empty and
  // hide the real greeting).
  const sub = document.querySelector<HTMLElement>(".yo-greeting-sub");
  if (sub) {
    hideYoWelcome();
    sub.textContent = fillGreeting(template);
    return;
  }

  // Legacy fallback (no #yo-greeting block): inject the welcome div.
  hideYoWelcome();
  const w = document.createElement("div");
  w.id = "yo-panel-welcome";
  w.className = "yo-panel-welcome";
  w.innerHTML = `<div class="yo-welcome-logo"><img class="glyphh-logo glyphh-logo--black" src="brand/glyphh-logo-black.png" alt="Glyphh" /><img class="glyphh-logo glyphh-logo--white" src="brand/glyphh-logo-white.png" alt="Glyphh" /></div>
    <div class="yo-welcome-tagline" id="yo-welcome-greeting"></div>`;
  const greetingEl = w.querySelector<HTMLElement>("#yo-welcome-greeting");
  if (greetingEl) greetingEl.textContent = fillGreeting(template);
  yoPanelMessages.appendChild(w);
}

// ── Helpers: permission dropdown ───────────────────────────────────────────

function setPermValue(perm: string) {
  currentPerm = perm;
  const icon = yoPermTrigger.querySelector(".yo-perm-icon")!;
  const label = yoPermTrigger.querySelector(".yo-perm-label")!;
  // Inject SVG markup (not textContent) so the trigger renders the icon,
  // not its raw HTML string.
  icon.innerHTML = PERM_ICONS[perm] || PERM_ICONS.default;
  label.textContent = PERM_LABELS[perm] || perm;
  yoPermOptions.forEach((opt) => {
    opt.classList.toggle("active", (opt as HTMLElement).dataset.value === perm);
  });
  applyAccentColor();
}

/** Accent color: the active permission's color (plan-blue when plan is selected). */
function applyAccentColor() {
  const color = PERM_COLORS[currentPerm] || PERM_COLORS.default;
  yoPermTrigger.style.borderColor = color;
  yoPanelInput.style.setProperty("--mode-color", color);
  yoPanelSendBtn.style.background = color;
  document.documentElement.style.setProperty("--yo-mode-color", color);
}

function syncAgentMode(): void {
  // Plan is just another permission value — the backend treats "plan" as a
  // permission mode (no tool calls, plan-mode prompt directive).
  window.yo.setAgentMode(currentPerm);
}

async function initYoModelFromConfig(): Promise<void> {
  try {
    const cfg = await window.yo.getLLMConfig?.();
    currentChatModel = (cfg?.model && cfg.provider === "anthropic") ? cfg.model : "";
  } catch { currentChatModel = ""; }
}

async function initYoControls() {
  // Plan is one of the permission values — "plan" persists like any other.
  const { perm } = await window.yo.getAgentMode();
  setPermValue(perm || "default");
}

// ── Helpers: messages ──────────────────────────────────────────────────────

function addYoUserMessage(text: string) {
  chat.addUserTurn(text);
}

/** A user message typed while the agent is busy. It's queued (not yet sent),
 *  so we render it like a user bubble but dimmed + dashed with a delete X, so
 *  it's clear the agent hasn't seen it yet. Returns the container element. */
function addPendingUserBubble(text: string): HTMLElement {
  const container = document.createElement("div");
  container.className = "interactive-item-container interactive-request yo-pending-turn";
  const value = document.createElement("div");
  value.className = "value";
  value.textContent = text;
  const del = document.createElement("button");
  del.type = "button";
  del.className = "yo-pending-del";
  del.title = "Remove — the agent hasn't seen this yet";
  del.innerHTML =
    `<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>`;
  container.appendChild(del);
  container.appendChild(value);
  chat.appendRaw(container);
  return container;
}

/** Promote a queued bubble to a normal user turn — it's being sent now, so the
 *  agent will see it. Drops the dim/dashed treatment and the delete X. */
function promotePendingBubble(el: HTMLElement): void {
  el.classList.remove("yo-pending-turn");
  el.querySelector(".yo-pending-del")?.remove();
}

// ── Swarm activity (inline) ────────────────────────────────────────────────
// When a swarm is running, its bus events stream into the conversation as
// lightweight rows — agent badge, who→who, kind, body.

interface SwarmRosterEntry { position: string; provider?: string; model?: string }
// ── Helpers: scroll ────────────────────────────────────────────────────────

// Stick-to-bottom during streaming only when the user is already at the
// bottom. If they scroll up to read, streaming stops yanking the view down;
// the scroll-to-bottom button is their way back.
let yoStickToBottom = true;

function yoScroll() {
  if (yoStickToBottom) {
    yoPanelMessages.scrollTop = yoPanelMessages.scrollHeight;
  }
  // Keep the scroll-button visibility in sync regardless of stick state.
  const gap = yoPanelMessages.scrollHeight - yoPanelMessages.scrollTop - yoPanelMessages.clientHeight;
  yoScrollBtn.classList.toggle("visible", gap > 40);
}

// ── Compaction fuel gauge + modal ───────────────────────────────────────────
// A clickable ring in the composer shows how full the conversation context is
// relative to the auto-compaction window. Clicking it opens a modal that lets
// the user trigger /compact with an optional shaping prompt (and save that
// prompt as their default).

// r=15 → circumference = 2·π·15 ≈ 94.2477796 (matches the CSS dasharray).
const YO_GAUGE_CIRCUMFERENCE = 2 * Math.PI * 15;

let yoCompactionBtn: HTMLElement | null = null;
let yoCompactionFill: SVGCircleElement | null = null;
// Last reported usage — read by the modal to show current numbers.
let yoCtxUsed = 0;
let yoCtxWindow = 0;

function fmtTokens(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function updateCompactionGauge(used: number, window: number): void {
  yoCtxUsed = used;
  yoCtxWindow = window;
  const fraction = window > 0 ? Math.min(used / window, 1) : 0;
  if (yoCompactionFill) {
    yoCompactionFill.style.strokeDashoffset = String(YO_GAUGE_CIRCUMFERENCE * (1 - fraction));
  }
  if (yoCompactionBtn) {
    yoCompactionBtn.classList.toggle("amber", fraction >= 0.7 && fraction < 0.9);
    yoCompactionBtn.classList.toggle("danger", fraction >= 0.9);
    const pct = Math.round(fraction * 100);
    yoCompactionBtn.title = window > 0
      ? `Context: ${fmtTokens(used)} / ${fmtTokens(window)} tokens (${pct}%) — click to compact`
      : "Context usage — click to compact";
  }
}

async function openCompactionModal(): Promise<void> {
  // Guard against stacking.
  document.querySelectorAll(".yo-compaction-modal").forEach((el) => el.remove());

  const savedPrompt = (await window.yo.getPreference("compactPrompt", "")) as string;

  // Hide the native app panels first — a DOM modal renders BEHIND BrowserViews
  // otherwise. Awaited so close() can never run before the hide settles.
  const panelsHidden = await hidePanelsForModal();

  const overlay = document.createElement("div");
  overlay.className = "yo-modal yo-compaction-modal";

  const backdrop = document.createElement("div");
  backdrop.className = "yo-modal-backdrop";

  const panel = document.createElement("div");
  panel.className = "yo-modal-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");

  const title = document.createElement("div");
  title.className = "yo-modal-title";
  title.textContent = "Compact conversation";
  panel.appendChild(title);

  const usage = document.createElement("div");
  usage.className = "yo-modal-message";
  const pct = yoCtxWindow > 0 ? Math.round(Math.min(yoCtxUsed / yoCtxWindow, 1) * 100) : 0;
  usage.textContent = yoCtxWindow > 0
    ? `Using ${fmtTokens(yoCtxUsed)} of ${fmtTokens(yoCtxWindow)} tokens (${pct}%) before auto-compaction.`
    : "No context recorded yet.";
  panel.appendChild(usage);

  const textarea = document.createElement("textarea");
  textarea.className = "yo-compaction-textarea";
  textarea.value = savedPrompt;
  textarea.placeholder = "Optional: how should the summary be shaped? (e.g. 'preserve all file paths and decisions')";
  textarea.rows = 4;
  panel.appendChild(textarea);

  const saveRow = document.createElement("label");
  saveRow.className = "yo-compaction-save-row";
  const saveCheck = document.createElement("input");
  saveCheck.type = "checkbox";
  const saveLabel = document.createElement("span");
  saveLabel.textContent = "Save as my default compaction prompt";
  saveRow.appendChild(saveCheck);
  saveRow.appendChild(saveLabel);
  panel.appendChild(saveRow);

  const actions = document.createElement("div");
  actions.className = "yo-modal-actions";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "yo-modal-btn yo-modal-btn-cancel";
  cancelBtn.textContent = "Cancel";

  const compactBtn = document.createElement("button");
  compactBtn.className = "yo-modal-btn yo-modal-btn-confirm";
  compactBtn.textContent = "Compact now";

  actions.appendChild(cancelBtn);
  actions.appendChild(compactBtn);
  panel.appendChild(actions);

  overlay.appendChild(backdrop);
  overlay.appendChild(panel);

  function close(): void {
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
    restorePanelsForModal(panelsHidden);
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
  }

  async function doCompact(): Promise<void> {
    const value = textarea.value.trim();
    if (saveCheck.checked) {
      try { await window.yo.setPreference("compactPrompt", value); } catch { /* best-effort */ }
    }
    close();
    window.yo.yoPanelSend(value ? `/compact ${value}` : "/compact");
  }

  cancelBtn.addEventListener("click", () => close());
  compactBtn.addEventListener("click", () => { void doCompact(); });
  backdrop.addEventListener("click", () => close());
  document.addEventListener("keydown", onKey, true);

  document.body.appendChild(overlay);
  requestAnimationFrame(() => textarea.focus());
}

// ── Composer-area interaction host ─────────────────────────────────────────
// When the agent needs the user (ask_user_question / tool approval), the
// prompt takes over the slot above the input instead of dropping a card into
// the transcript. The input is disabled while an interaction is live; once
// answered we collapse the host, re-enable the input, and leave a compact
// marker in the transcript so history still records what happened.

function openInteraction(panel: HTMLElement): void {
  yoComposerHost.innerHTML = "";
  yoComposerHost.appendChild(panel);
  yoComposerHost.hidden = false;
  // Suppress the absolutely-positioned scroll-to-bottom arrow so it doesn't
  // float over the question.
  yoComposerHost.closest(".yo-panel")?.classList.add("interaction-active");
  yoPanelInput.classList.add("yo-input-disabled");
  yoPanelInput.setAttribute("disabled", "true");
  // Let the panel own keyboard focus (arrow keys, enter, esc).
  panel.focus();
}

function closeInteraction(): void {
  yoComposerHost.innerHTML = "";
  yoComposerHost.hidden = true;
  yoComposerHost.closest(".yo-panel")?.classList.remove("interaction-active");
  yoPanelInput.classList.remove("yo-input-disabled");
  yoPanelInput.removeAttribute("disabled");
  yoPanelInput.focus();
}

/** Drop a one-line record of a resolved interaction into the transcript. */
function appendChatMarker(opts: {
  state: "allowed" | "denied" | "answered";
  label: string;
  value?: string;
}): void {
  const ICONS: Record<string, string> = {
    allowed: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 4 6.5 12 3 8.5"/></svg>`,
    denied: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>`,
    answered: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 4 6.5 12 3 8.5"/></svg>`,
  };
  const row = document.createElement("div");
  row.className =
    "yo-chat-marker" +
    (opts.state === "allowed" || opts.state === "answered" ? " is-allowed" : " is-denied");
  const icon = document.createElement("span");
  icon.className = "yo-chat-marker-icon";
  icon.innerHTML = ICONS[opts.state];
  const text = document.createElement("span");
  const strong = document.createElement("strong");
  strong.textContent = opts.label;
  text.appendChild(strong);
  if (opts.value) text.appendChild(document.createTextNode(` ${opts.value}`));
  row.appendChild(icon);
  row.appendChild(text);
  chat.appendRaw(row);
  // The marker now sits at the bottom of the flow. Seal the pre-interaction
  // turn so the agent's resumed output starts a fresh turn BELOW the marker
  // instead of growing the old turn upward.
  chat.sealCurrentTurn();
}

// ── Helpers: status ────────────────────────────────────────────────────────
// The working spinner + thinking indicator are owned by the chat renderer.
// These thin wrappers preserve the call sites in the send/stop/open paths.

function showYoStatus(_toolText: string) {
  chat.beginAssistantTurn();
}

function clearYoStatus() {
  chat.endAssistantTurn();
}

// ── Helpers: tool use/result ───────────────────────────────────────────────

// SDK plumbing the user shouldn't see — deferred-tool loader + the synthetic
// "select:Foo" lookups it spawns. These fire inside the Claude Code SDK while
// it resolves a tool schema before the actual call, and they're noise in the
// chat. Hide them entirely.
const HIDDEN_TOOLS = new Set<string>(["ToolSearch"]);
function isHiddenTool(name: string, input: unknown): boolean {
  if (HIDDEN_TOOLS.has(name)) return true;
  // ToolSearch invocations sometimes surface under different namespaces with a
  // `query: "select:Foo"` shape — treat any select:* query as plumbing too.
  const q = (input as { query?: string } | null)?.query;
  if (typeof q === "string" && q.startsWith("select:")) return true;
  return false;
}

function showYoToolUse(_id: string, _name: string, _input: unknown) {
  // Render only what the model returns as text. Tool calls happen silently.
}

function showYoToolResult(_id: string, _detail: string) {
  // No-op.
}

// ── Helpers: input management ──────────────────────────────────────────────

function autoGrowYoInput() {
  yoPanelInput.style.height = "40px";
  yoPanelInput.style.height = Math.min(yoPanelInput.scrollHeight, 160) + "px";
  paintSendButton();
}

/** Move the caret to the end and resize the textarea. */
function setYoInputValue(value: string) {
  yoPanelInput.value = value;
  autoGrowYoInput();
  const end = value.length;
  yoPanelInput.setSelectionRange(end, end);
}

/** ↑ — step back to an older history entry (stashing the live draft first). */
function yoHistoryPrev() {
  if (yoInputHistory.length === 0 || yoHistIndex === 0) return;
  if (yoHistIndex === yoInputHistory.length) yoHistDraft = yoPanelInput.value;
  yoHistIndex--;
  setYoInputValue(yoInputHistory[yoHistIndex]);
}

/** ↓ — step forward to a newer entry, or back to the live draft at the end. */
function yoHistoryNext() {
  if (yoHistIndex >= yoInputHistory.length) return;
  yoHistIndex++;
  setYoInputValue(yoHistIndex === yoInputHistory.length ? yoHistDraft : yoInputHistory[yoHistIndex]);
}

function sendYoPanelMessage() {
  const text = yoPanelInput.value.trim();
  if (!text) return;

  // Record into input history (skip consecutive duplicates) and reset browsing.
  if (yoInputHistory[yoInputHistory.length - 1] !== text) yoInputHistory.push(text);
  yoHistIndex = yoInputHistory.length;
  yoHistDraft = "";

  if (/^\.rec$/i.test(text) && yoPanelMicBtn) {
    yoPanelInput.value = "";
    autoGrowYoInput();
    yoPanelMicBtn.click();
    return;
  }

  // Dot-commands (.sup, .dip, .drip, .peace, …) run silently — they're a
  // command DSL, not chat. They never appear in the panel output and never
  // hit the agent. The one exception is `.yo`, which IS how you invoke the
  // agent, so it falls through to the normal send path below.
  if (text.startsWith(".")) {
    const firstWord = text.slice(1).split(/\s+/)[0]?.toLowerCase() ?? "";
    if (firstWord && firstWord !== "yo") {
      yoPanelInput.value = "";
      autoGrowYoInput();
      window.yo.execCommand(text.slice(1)).catch(() => {});
      return;
    }
  }

  // Agent busy → queue the message. It shows immediately as a dimmed, deletable
  // bubble (the agent hasn't seen it yet) and is sent when the current turn
  // finishes (see drainPendingYoMessages).
  if (yoThinking) {
    hideYoWelcome();
    yoPanelInput.value = "";
    autoGrowYoInput();
    const el = addPendingUserBubble(text);
    const entry: PendingYoMessage = { text, el };
    pendingYoMessages.push(entry);
    el.querySelector(".yo-pending-del")?.addEventListener("click", () => {
      const i = pendingYoMessages.indexOf(entry);
      if (i >= 0) pendingYoMessages.splice(i, 1);
      el.remove();
    });
    return;
  }

  hideYoWelcome();
  yoPanelInput.value = "";
  autoGrowYoInput();
  addYoUserMessage(text);
  if (/\.yo\b/i.test(text)) {
    window.yo.dripsPreview("cat");
  }
  // A fresh user turn starts pinned to the bottom.
  yoStickToBottom = true;
  (window as unknown as { __yoStartTurnPhase?: () => void }).__yoStartTurnPhase?.();
  showYoStatus("");
  setYoThinking(true);
  window.yo.yoPanelSend(text);
}

/** Send the next queued message, if any, once a turn finishes. */
function drainPendingYoMessages() {
  if (pendingYoMessages.length === 0) return;
  const next = pendingYoMessages.shift()!;
  // It's being sent now — the agent will see it. Un-dim the bubble.
  promotePendingBubble(next.el);
  (window as unknown as { __yoStartTurnPhase?: () => void }).__yoStartTurnPhase?.();
  showYoStatus("");
  setYoThinking(true);
  window.yo.yoPanelSend(next.text);
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

// Load a saved chat by id and replay its messages into the panel.
// Shared by the in-panel history list and the workspace Recents rail.
async function loadChatById(id: string): Promise<void> {
  const messages = await window.yo.yoChatsLoad(id);
  if (!messages) return;
  chat.reset();
  if (yoHistoryPanel) yoHistoryPanel.classList.add("hidden");

  for (const msg of messages) {
    // Swarm activity is persisted into the thread — replay it inline.
    if (msg.role === "swarm-start" || msg.role === "swarm") {
      continue; // swarm rendering removed
    }
    // Run marker — the header atop a persisted task-run conversation. Clicking
    // it slides open the owning scheduled task (handled in the workspace shell).
    if (msg.role === "run") {
      const skill = msg.tools && msg.tools[0] ? msg.tools[0].name : "";
      const marker = document.createElement("button");
      marker.className = "yo-run-marker";
      marker.type = "button";
      if (skill) marker.title = `Open scheduled task “${skill}”`;
      const svgNS = "http://www.w3.org/2000/svg";
      const clock = document.createElementNS(svgNS, "svg");
      clock.setAttribute("viewBox", "0 0 24 24");
      clock.setAttribute("fill", "none");
      clock.setAttribute("stroke", "currentColor");
      clock.setAttribute("stroke-width", "2");
      clock.innerHTML = `<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>`;
      marker.appendChild(clock);
      const text = document.createElement("span");
      text.className = "yo-run-text";
      const label = document.createElement("span");
      label.className = "yo-run-label";
      label.textContent = msg.text || "Ran task";
      text.appendChild(label);
      if (skill) {
        const skillEl = document.createElement("span");
        skillEl.className = "yo-run-skill";
        skillEl.textContent = skill;
        text.appendChild(skillEl);
      }
      marker.appendChild(text);
      // Chevron on the far right.
      const chev = document.createElementNS(svgNS, "svg");
      chev.setAttribute("class", "yo-run-chevron");
      chev.setAttribute("viewBox", "0 0 24 24");
      chev.setAttribute("fill", "none");
      chev.setAttribute("stroke", "currentColor");
      chev.setAttribute("stroke-width", "2");
      chev.innerHTML = `<polyline points="9 6 15 12 9 18"/>`;
      marker.appendChild(chev);
      if (skill) {
        marker.addEventListener("click", () => {
          window.dispatchEvent(new CustomEvent("open-schedule-task", { detail: { name: skill } }));
        });
      }
      chat.appendRaw(marker);
      continue;
    }
    if (msg.role === "user") {
      chat.addUserTurn(msg.text);
    } else {
      if (!msg.text) continue;
      chat.addAssistantTurn(msg.text);
    }
  }
  yoScroll();
}

// Start a fresh chat — clear the transcript + reset turn state.
async function startNewChat(): Promise<void> {
  await window.yo.yoChatNew();
  chat.reset();
  if (yoHistoryPanel) yoHistoryPanel.classList.add("hidden");
  // Fresh session → empty context: pin to bottom and zero the gauge.
  yoStickToBottom = true;
  updateCompactionGauge(0, 0);
  showYoWelcome();
  yoPanelInput.focus();
}

async function loadYoHistory() {
  const chats = await window.yo.yoChatsList();
  yoHistoryList.innerHTML = "";

  // ── Scheduled section — scheduled tasks (pref) + any task with run history ──
  let scheduledNames: string[] = [];
  try { scheduledNames = (await window.yo.getPreference("scheduledTasks", [])) as string[]; }
  catch { scheduledNames = []; }
  try {
    const runs = await window.yo.runsList();
    const runNames = [...new Set(runs.map((r) => r.skillName).filter(Boolean))];
    scheduledNames = [...new Set([...scheduledNames, ...runNames])];
  } catch { /* runs optional */ }
  const schedHeader = document.createElement("div");
  schedHeader.className = "yo-history-section-header";
  schedHeader.textContent = "Scheduled";
  yoHistoryList.appendChild(schedHeader);
  if (scheduledNames.length === 0) {
    const empty = document.createElement("div");
    empty.className = "yo-history-empty";
    empty.textContent = "no scheduled tasks";
    yoHistoryList.appendChild(empty);
  } else {
    for (const name of scheduledNames) {
      const item = document.createElement("div");
      item.className = "yo-history-item";
      const title = document.createElement("span");
      title.className = "yo-history-title";
      title.textContent = name;
      item.appendChild(title);
      item.addEventListener("click", () => {
        // Open this schedule in the Schedules page (deep-links to its detail).
        window.yo.openHomeSection("schedules", name);
        if (yoHistoryPanel) yoHistoryPanel.classList.add("hidden");
      });
      yoHistoryList.appendChild(item);
    }
  }

  // ── Recents section — existing chat list ──
  const recHeader = document.createElement("div");
  recHeader.className = "yo-history-section-header";
  recHeader.textContent = "Recents";
  yoHistoryList.appendChild(recHeader);
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
    item.addEventListener("click", () => { void loadChatById(chat.id); });
    yoHistoryList.appendChild(item);
  }
}

// ── Panel open/close ───────────────────────────────────────────────────────

async function openYoPanel(query: string) {
  if (!yoControlsInited) {
    yoControlsInited = true;
    initYoControls();
    void initYoModelFromConfig().then(() => {
      // Repaint label + active state once the saved model is known.
      const label = document.getElementById("yo-model-trigger")?.querySelector(".yo-model-label");
      if (label) label.textContent = prettyModelLabel(currentChatModel);
      document.querySelectorAll<HTMLElement>("#yo-model-menu .yo-model-option").forEach((o) => {
        o.classList.toggle("active", (o.dataset.value || "") === currentChatModel);
      });
    });
  }

  const defaultWidth = 380;
  yoPanel.style.width = `${defaultWidth}px`;
  document.body.style.setProperty("--right-inset", `${defaultWidth}px`);
  window.yo.yoPanelResize(defaultWidth);
  yoPanel.classList.remove("hidden");
  void yoPanel.offsetHeight;
  yoPanel.classList.add("open");
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
    const savedWidth = await window.yo.yoPanelGetWidth();
    if (savedWidth && savedWidth !== defaultWidth) {
      yoPanel.style.width = `${savedWidth}px`;
      document.body.style.setProperty("--right-inset", `${savedWidth}px`);
      window.yo.yoPanelResize(savedWidth);
    }
  } catch { /* panel is already open — personalization is best-effort */ }
}

function closeYoPanel() {
  yoPanel.classList.remove("open");
  document.body.style.setProperty("--right-inset", "0px");
  setTimeout(() => {
    yoPanel.classList.add("hidden");
    chat.reset();
    _renderGridHandles();
  }, 200);
}

function isYoPanelOpen(): boolean {
  return yoPanel.classList.contains("open");
}

// ── Workdir bar (folder picker + git branch + add-folder) ──
// Ported from the (removed) Agent app so the right-rail Yo follows the
// user's current working folder. Shares the working-dir preference with
// every other folder-bound surface (Workbench, etc.) via the existing
// working-dir:* IPCs already on window.yo.

function basenameOf(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() || p;
}
function homeShortenPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}

let workdirCurrent = "";

function wireWorkdirBar(): void {
  const workdirBtn = document.getElementById("workdir-btn") as HTMLButtonElement | null;
  const workdirName = document.getElementById("workdir-name");
  const workdirAdd = document.getElementById("workdir-add-btn") as HTMLButtonElement | null;
  const branchWrap = document.getElementById("workdir-branch-wrap");
  const branchEl = document.getElementById("workdir-branch");
  if (!workdirBtn || !workdirName) return;

  const dropdown = document.createElement("div");
  dropdown.className = "yo-workdir-menu";
  dropdown.setAttribute("role", "menu");
  document.body.appendChild(dropdown);
  const closeDropdown = () => dropdown.classList.remove("open");
  const isDropdownOpen = () => dropdown.classList.contains("open");

  const FOLDER_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>`;
  const CHECK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

  async function paintBar(dir: string): Promise<void> {
    workdirCurrent = dir || "";
    if (workdirName) workdirName.textContent = dir ? basenameOf(dir) : "Pick a folder";
    if (workdirBtn) workdirBtn.title = dir ? `working directory: ${dir}` : "Pick a folder";
    if (!dir) { if (branchWrap) (branchWrap as HTMLElement).style.display = "none"; return; }
    try {
      const info = await (window.yo as any).gitInfo?.(dir);
      if (info?.isRepo && info.branch && branchWrap && branchEl) {
        branchEl.textContent = info.branch;
        (branchWrap as HTMLElement).style.display = "";
      } else if (branchWrap) {
        (branchWrap as HTMLElement).style.display = "none";
      }
    } catch { if (branchWrap) (branchWrap as HTMLElement).style.display = "none"; }
  }

  async function openDropdown(): Promise<void> {
    const recents = await window.yo.getWorkingDirRecents().catch(() => [] as string[]);
    dropdown.innerHTML = "";
    const list = recents.length ? recents : (workdirCurrent ? [workdirCurrent] : []);
    for (const dir of list) {
      const item = document.createElement("button");
      item.className = "yo-workdir-menu-item";
      item.innerHTML =
        `<span class="check">${dir === workdirCurrent ? CHECK_SVG : ""}</span>` +
        `<span class="ic">${FOLDER_SVG}</span>` +
        `<span class="nm"></span>`;
      (item.querySelector(".nm") as HTMLElement).textContent = homeShortenPath(dir);
      item.title = dir;
      item.addEventListener("click", async () => {
        closeDropdown();
        if (dir !== workdirCurrent) await window.yo.setWorkingDir(dir);
      });
      dropdown.appendChild(item);
    }
    const sep = document.createElement("div");
    sep.className = "yo-workdir-menu-sep";
    dropdown.appendChild(sep);
    const choose = document.createElement("button");
    choose.className = "yo-workdir-menu-item";
    choose.textContent = "Choose folder…";
    choose.addEventListener("click", async () => { closeDropdown(); await window.yo.pickWorkingDir(); });
    dropdown.appendChild(choose);
    const r = workdirBtn!.getBoundingClientRect();
    dropdown.style.left = `${r.left}px`;
    dropdown.style.bottom = `${window.innerHeight - r.top + 4}px`;
    dropdown.style.top = "auto";
    dropdown.classList.add("open");
  }

  workdirBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    isDropdownOpen() ? closeDropdown() : void openDropdown();
  });
  workdirAdd?.addEventListener("click", (e) => { e.stopPropagation(); void window.yo.pickWorkingDir(); });
  document.addEventListener("click", (e) => {
    if (!isDropdownOpen()) return;
    if (dropdown.contains(e.target as Node)) return;
    if (workdirBtn.contains(e.target as Node)) return;
    closeDropdown();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && isDropdownOpen()) closeDropdown(); });

  // Initial paint + react to changes from anywhere in the app.
  void window.yo.getWorkingDir().then((d) => paintBar(d || ""));
  window.yo.onWorkingDirChanged((d) => { void paintBar(d || ""); });
}

// ── Init ───────────────────────────────────────────────────────────────────

export function initYoPanel(callbacks: YoPanelCallbacks): YoPanelApi {
  _renderGridHandles = callbacks.renderGridHandles;

  // Query DOM elements
  yoPanel = document.getElementById("yo-panel")!;
  yoPanelMessages = document.getElementById("yo-panel-messages")!;
  chat = new ChatRenderer(yoPanelMessages);
  yoPanelInput = document.getElementById("yo-panel-input") as HTMLTextAreaElement;
  yoComposerHost = document.getElementById("yo-composer-interaction")!;
  yoPanelSendBtn = document.getElementById("yo-panel-send")!;
  yoPanelMicBtn = document.getElementById("yo-panel-mic") as HTMLButtonElement | null;
  yoScrollBtn = document.getElementById("yo-scroll-btn")!;
  yoPanelResize = document.getElementById("yo-panel-resize")!;
  yoHistoryToggle = document.getElementById("yo-history-toggle")!;
  yoHistoryPanel = document.getElementById("yo-history")!;
  yoHistoryList = document.getElementById("yo-history-list")!;
  yoChatNewBtn = document.getElementById("yo-chat-new")!;

  // Permission dropdown elements
  yoPermDropdown = document.getElementById("yo-perm-dropdown")!;
  yoPermTrigger = document.getElementById("yo-perm-trigger")!;
  yoPermMenu = document.getElementById("yo-perm-menu")!;
  yoPermOptions = yoPermMenu.querySelectorAll(".yo-perm-option");

  // -- Workdir bar (folder picker + git branch + add-folder) --
  // Ported from the (removed) Agent app so the right-rail Yo is folder-bound.
  wireWorkdirBar();

  // -- Scroll-to-bottom button --
  yoPanelMessages.addEventListener("scroll", () => {
    const gap = yoPanelMessages.scrollHeight - yoPanelMessages.scrollTop - yoPanelMessages.clientHeight;
    yoScrollBtn.classList.toggle("visible", gap > 40);
    yoStickToBottom = gap < 40;
  });
  yoScrollBtn.addEventListener("click", () => {
    yoPanelMessages.scrollTop = yoPanelMessages.scrollHeight;
    yoStickToBottom = true;
  });

  // -- Compaction fuel gauge --
  yoCompactionBtn = document.getElementById("yo-panel-compaction");
  yoCompactionFill = yoCompactionBtn?.querySelector(".yo-compaction-fill") ?? null;
  yoCompactionBtn?.addEventListener("click", () => { void openCompactionModal(); });
  updateCompactionGauge(0, 0);
  window.yo.onYoContextUsage(({ used, window }) => updateCompactionGauge(used, window));

  // -- Mic button visibility --
  if (yoPanelMicBtn) {
    yoPanelMicBtn.style.display = "none";
    window.yo.getPreference("voiceEnabled", false).then((v) => {
      yoPanelMicBtn!.style.display = v ? "" : "none";
    });
  }

  // -- Permission dropdown listeners --
  yoPermTrigger.addEventListener("click", (e) => {
    e.stopPropagation();
    yoPermMenu.classList.toggle("hidden");
  });

  yoPermOptions.forEach((opt) => {
    opt.addEventListener("click", () => {
      const value = (opt as HTMLElement).dataset.value!;
      setPermValue(value);
      syncAgentMode();
      yoPermMenu.classList.add("hidden");
    });
  });

  // Model dropdown — sections (Claude / GPT). GPT items are disabled until
  // the GPT loop is wired. Changing the model warns the user that the
  // current chat will be reset (context lost) and starts a new one.
  const modelDropdown = document.getElementById("yo-model-dropdown");
  const modelTrigger = document.getElementById("yo-model-trigger");
  const modelMenu = document.getElementById("yo-model-menu");
  const modelOptions = modelMenu?.querySelectorAll<HTMLElement>(".yo-model-option");
  function paintModelLabel(): void {
    const label = modelTrigger?.querySelector(".yo-model-label");
    if (!label) return;
    if (!currentChatModel) { label.textContent = "Default"; return; }
    label.textContent = prettyModelLabel(currentChatModel);
  }
  /** Brand chrome in the panel title: <logo> .Sup <firstName>. Logo
   *  follows the active model's brand; the name addresses the user
   *  (this is the right-rail; the Agent app uses the brand display
   *  name instead — see yo-agent-renderer.paintBrand). */
  function paintBrand(): void {
    const logoEl = document.getElementById("yo-brand-logo") as HTMLImageElement | null;
    const nameEl = document.getElementById("yo-brand-name");
    const brand = brandForModel(currentChatModel);
    if (logoEl) {
      const url = logoUrlFor(brand);
      if (url) { logoEl.src = url; logoEl.alt = brand; logoEl.style.display = ""; }
      else { logoEl.removeAttribute("src"); logoEl.style.display = "none"; }
    }
    if (nameEl) {
      nameEl.textContent = "there";
    }
  }
  if (modelTrigger && modelMenu) {
    modelTrigger.addEventListener("click", (e) => {
      e.stopPropagation();
      modelMenu.classList.toggle("hidden");
      yoPermMenu.classList.add("hidden");
    });
  }
  function wireModelOption(opt: HTMLElement): void {
    opt.addEventListener("click", async () => {
      if (opt.classList.contains("disabled")) return;
      const newModel = opt.dataset.value || "";
      modelMenu?.classList.add("hidden");
      if (newModel === currentChatModel) return;
      // If a chat is in progress, warn before resetting. Empty messages =
      // welcome screen = safe to change silently.
      const inChat = yoPanelMessages.children.length > 0 && !yoPanelMessages.querySelector(".yo-panel-welcome");
      if (inChat && !(await yoConfirm({
        title: "Change model?",
        message: "Changing the model will start a new chat — context will be lost.",
        confirmText: "Change model",
        cancelText: "Cancel",
      }))) return;
      currentChatModel = newModel;
      modelMenu?.querySelectorAll<HTMLElement>(".yo-model-option").forEach((o) => o.classList.toggle("active", o === opt));
      paintModelLabel();
      paintBrand();
      await window.yo.saveLLMConfig({ provider: "anthropic", model: newModel || "claude-haiku-4-5-20251001" });
      if (inChat) await startNewChat();
    });
  }
  modelOptions?.forEach(wireModelOption);
  paintModelLabel();
  paintBrand();
  modelOptions?.forEach((o) => o.classList.toggle("active", (o.dataset.value || "") === currentChatModel));

  // Replace the static list with the server-filtered model list for THIS user
  // (Anthropic ∩ plan ∩ org ∩ user, via /api/models?proxy=1) and reset any
  // stale/disallowed selection. Without this, a persisted/static model the plan
  // doesn't allow (or a wrong id form) makes every request 403.
  async function populateModels(): Promise<void> {
    if (!modelMenu) return;
    let data: { models: Array<{ provider: string; model: string; display_name: string }>; default_model: string | null };
    try { data = await (window.yo as any).agentModels(); } catch (e) { console.warn("[yo-panel] agentModels failed", e); return; }
    console.log("[yo-panel] agentModels →", (data?.models || []).map((m) => m.model), "default:", data?.default_model);
    if (!data || !Array.isArray(data.models) || data.models.length === 0) return;
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
    const check = '<span class="yo-mode-opt-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>';
    modelMenu.innerHTML = '<div class="yo-model-section-header">Models</div>' + data.models.map((m) =>
      `<div class="yo-model-option" data-provider="${esc(m.provider)}" data-value="${esc(m.model)}"><div class="yo-mode-opt-text"><span class="yo-mode-opt-label">${esc(m.display_name)}</span></div>${check}</div>`,
    ).join("");
    modelMenu.querySelectorAll<HTMLElement>(".yo-model-option").forEach(wireModelOption);
    const ids = new Set(data.models.map((m) => m.model));
    if (!currentChatModel || !ids.has(currentChatModel)) {
      const fallback = (data.default_model && ids.has(data.default_model)) ? data.default_model : data.models[0].model;
      currentChatModel = fallback;
      await window.yo.saveLLMConfig({ provider: "anthropic", model: fallback });
    }
    modelMenu.querySelectorAll<HTMLElement>(".yo-model-option").forEach((o) => o.classList.toggle("active", (o.dataset.value || "") === currentChatModel));
    paintModelLabel();
    paintBrand();
  }
  void populateModels();

  document.addEventListener("click", (e) => {
    if (!yoPermDropdown.contains(e.target as Node)) {
      yoPermMenu.classList.add("hidden");
    }
    if (modelDropdown && !modelDropdown.contains(e.target as Node)) {
      modelMenu?.classList.add("hidden");
    }
  });

  // -- Permission changes from main process --
  window.yo.onAgentModeChanged?.((mode: string) => {
    setPermValue(mode);
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
  // Agent response — streamed through the VS Code-style chat renderer. The
  // thinking indicator shows at turn start and disappears on first content;
  // tokens accumulate into a markdown text part; tool calls render as
  // collapsible Input/Output blocks that update as results/progress arrive.

  // Public so sendYoPanelMessage can flag the start of a turn (thinking
  // indicator + working spinner).
  (window as unknown as { __yoStartTurnPhase?: () => void }).__yoStartTurnPhase = () => chat.beginAssistantTurn();

  window.yo.onYoPanelToken((delta) => {
    if (!delta) return;
    chat.appendText(delta);
    yoScroll();
  });
  window.yo.onYoPanelToolUse((id, name, input) => {
    if (isHiddenTool(name, input)) return;
    chat.addTool(id, name, input);
    yoScroll();
  });
  window.yo.onYoPanelToolResult((id, detail) => {
    chat.setToolResult(id, detail);
  });
  window.yo.onYoPanelToolProgress((id, status) => {
    chat.setToolProgress(id, status);
  });
  window.yo.onYoPanelDone(() => {
    clearYoStatus();
    setYoThinking(false);
    drainPendingYoMessages();
  });
  window.yo.onYoPanelError((err) => {
    clearYoStatus();
    setYoThinking(false);
    const el = document.createElement("div");
    el.className = "yo-msg yo-msg-error";
    el.textContent = err || "The agent hit an error.";
    chat.appendRaw(el);
    yoScroll();
    drainPendingYoMessages();
  });
  window.yo.onYoPanelClose(() => closeYoPanel());
  window.yo.onYoPanelRefocus(() => yoPanelInput.focus());
  window.yo.onYoPanelPrefill((text) => {
    // Prefill the input without sending — the user finishes + submits.
    yoPanelInput.value = text;
    autoGrowYoInput();
    yoPanelInput.focus();
    yoPanelInput.setSelectionRange(text.length, text.length);
  });
  window.yo.onYoPanelLoadChat((id) => { void loadChatById(id); });

  // Swarm rendering removed.
  // -- Send/stop button --
  // The button is "stop" (■) only when the agent is thinking AND the input is
  // empty. Once the user types, it flips to "send" (↑) so click queues the
  // follow-up instead of aborting the in-flight turn.
  yoPanelSendBtn.addEventListener("click", () => {
    const isStopMode = yoThinking && !yoPanelInput.value.trim();
    if (isStopMode) {
      window.yo.yoPanelStop();
      clearYoStatus();
      setYoThinking(false);
      // Discard queued messages — they were never sent. Remove their bubbles.
      pendingYoMessages.forEach((m) => m.el.remove());
      pendingYoMessages = [];
      const quip = STOP_QUIPS[Math.floor(Math.random() * STOP_QUIPS.length)];
      const stopEl = document.createElement("div");
      stopEl.className = "yo-msg yo-msg-stopped";
      stopEl.innerHTML = `<em>${quip}</em>`;
      chat.appendRaw(stopEl);
    } else {
      sendYoPanelMessage();
    }
  });

  // -- Enter to send; ↑/↓ to recall input history --
  yoPanelInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendYoPanelMessage();
      return;
    }
    // Only hijack the arrows at the text edges so multi-line editing still works.
    if (e.key === "ArrowUp") {
      const caret = yoPanelInput.selectionStart;
      const onFirstLine = yoPanelInput.value.lastIndexOf("\n", caret - 1) === -1;
      if (onFirstLine && caret === yoPanelInput.selectionEnd) {
        e.preventDefault();
        yoHistoryPrev();
      }
    } else if (e.key === "ArrowDown") {
      const caret = yoPanelInput.selectionStart;
      const onLastLine = yoPanelInput.value.indexOf("\n", caret) === -1;
      if (onLastLine && caret === yoPanelInput.selectionEnd) {
        e.preventDefault();
        yoHistoryNext();
      }
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
          chat.appendRaw(el);
        }
      };

      mediaRecorder.start();
    });
  }

  // -- Close button --
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

  // -- Chat history (dropdown anchored to the clock icon in the header) --
  yoHistoryToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    const isHidden = yoHistoryPanel.classList.contains("hidden");
    if (isHidden) {
      loadYoHistory();
      yoHistoryPanel.classList.remove("hidden");
      const search = document.getElementById("yo-history-search") as HTMLInputElement | null;
      if (search) { search.value = ""; applyHistoryFilter(""); search.focus(); }
    } else {
      yoHistoryPanel.classList.add("hidden");
    }
  });

  // Close history dropdown on outside click.
  document.addEventListener("click", (e) => {
    if (yoHistoryPanel.classList.contains("hidden")) return;
    const target = e.target as Node;
    if (!yoHistoryPanel.contains(target) && !yoHistoryToggle.contains(target)) {
      yoHistoryPanel.classList.add("hidden");
    }
  });

  // Search: hide history rows whose title doesn't match; keep section
  // headers visible only when at least one of their following items matches.
  const yoHistorySearch = document.getElementById("yo-history-search") as HTMLInputElement | null;
  function applyHistoryFilter(q: string): void {
    const query = q.trim().toLowerCase();
    const children = Array.from(yoHistoryList.children) as HTMLElement[];
    let currentHeader: HTMLElement | null = null;
    let currentMatched = 0;
    for (const el of children) {
      if (el.classList.contains("yo-history-section-header")) {
        if (currentHeader) currentHeader.style.display = currentMatched > 0 ? "" : "none";
        currentHeader = el;
        currentMatched = 0;
      } else if (el.classList.contains("yo-history-item")) {
        const text = (el.querySelector(".yo-history-title")?.textContent || "").toLowerCase();
        const match = !query || text.includes(query);
        el.style.display = match ? "" : "none";
        if (match) currentMatched++;
      } else if (el.classList.contains("yo-history-empty")) {
        // Hide empty placeholders when actively searching — they're noise.
        el.style.display = query ? "none" : "";
      }
    }
    if (currentHeader) currentHeader.style.display = currentMatched > 0 ? "" : "none";
  }
  yoHistorySearch?.addEventListener("input", () => applyHistoryFilter(yoHistorySearch.value));

  yoChatNewBtn.addEventListener("click", () => { void startNewChat(); });

  // -- Approval UI (composer-area takeover) --
  window.yo.onApprovalRequest((id, _toolName, toolLabel, input) => {
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

    const panel = document.createElement("div");
    panel.className = "yo-ci-panel";
    panel.tabIndex = 0;

    const header = document.createElement("div");
    header.className = "yo-ci-header";
    header.innerHTML =
      `<span class="yo-ci-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>` +
      `<span class="yo-ci-title">Permission required</span>`;
    panel.appendChild(header);

    const q = document.createElement("div");
    q.className = "yo-ci-question";
    q.textContent = toolLabel;
    panel.appendChild(q);

    if (detail) {
      const d = document.createElement("div");
      d.className = "yo-ci-detail";
      d.textContent = detail.slice(0, 400);
      panel.appendChild(d);
    }

    const actions = document.createElement("div");
    actions.className = "yo-ci-actions";
    actions.innerHTML =
      `<span class="yo-ci-hint">enter allow · esc deny</span>` +
      `<button type="button" class="yo-ci-btn danger yo-ci-deny">Deny</button>` +
      `<button type="button" class="yo-ci-btn primary yo-ci-allow">Allow</button>`;
    panel.appendChild(actions);

    let done = false;
    function resolve(approved: boolean): void {
      if (done) return;
      done = true;
      window.yo.approvalRespond(id, approved);
      appendChatMarker({ state: approved ? "allowed" : "denied", label: toolLabel });
      closeInteraction();
    }
    actions.querySelector(".yo-ci-allow")!.addEventListener("click", () => resolve(true));
    actions.querySelector(".yo-ci-deny")!.addEventListener("click", () => resolve(false));
    panel.addEventListener("keydown", (e) => {
      if (done) return;
      if (e.key === "Enter") { e.preventDefault(); resolve(true); }
      else if (e.key === "Escape") { e.preventDefault(); resolve(false); }
    });

    openInteraction(panel);
  });

  // ── ask_user_question — composer-area "Input required" prompt ───────────────
  // The agent (mcp__yo__ask_user_question) blocks until the user answers. The
  // prompt takes over the slot above the input: one selectable-option block per
  // question, pre-selecting the recommended option (or the first). We reply with
  // one chosen label per question (null = cancelled) and leave a marker in the
  // transcript recording the answer.
  window.yo.onYoAskRequest((id, questions) => {
    const list = Array.isArray(questions) ? questions : [];
    if (list.length === 0) { window.yo.respondYoAsk(id, []); return; }

    const multi = list.length > 1;

    const panel = document.createElement("div");
    panel.className = "yo-ci-panel";
    panel.dataset.askId = id;
    panel.tabIndex = 0; // focusable so the panel owns keyboard nav

    // Header: icon + title, plus step dots on the right when there's more than
    // one question (wizard mode).
    const header = document.createElement("div");
    header.className = "yo-ci-header";
    header.innerHTML =
      `<span class="yo-ci-icon"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></span>` +
      `<span class="yo-ci-title"></span>` +
      (multi ? `<span class="yo-ci-steps"></span>` : "");
    const titleEl = header.querySelector(".yo-ci-title") as HTMLElement;
    panel.appendChild(header);

    const stepsEl = header.querySelector(".yo-ci-steps") as HTMLElement | null;
    const stepDots: HTMLElement[] = [];
    if (stepsEl) {
      list.forEach(() => {
        const dot = document.createElement("span");
        dot.className = "yo-ci-step-dot";
        stepsEl.appendChild(dot);
        stepDots.push(dot);
      });
    }

    // Body — rebuilt for each step (one question at a time).
    const body = document.createElement("div");
    body.className = "yo-ci-body";
    panel.appendChild(body);

    // Footer — hint + Back/Next (or Cancel/Submit).
    const actions = document.createElement("div");
    actions.className = "yo-ci-actions";
    actions.innerHTML =
      `<span class="yo-ci-hint"></span>` +
      `<button type="button" class="yo-ci-btn yo-ci-back">Back</button>` +
      `<button type="button" class="yo-ci-btn yo-ci-cancel">Cancel</button>` +
      `<button type="button" class="yo-ci-btn primary yo-ci-next">Next</button>`;
    panel.appendChild(actions);
    const hintEl = actions.querySelector(".yo-ci-hint") as HTMLElement;
    const backBtn = actions.querySelector(".yo-ci-back") as HTMLButtonElement;
    const cancelBtn = actions.querySelector(".yo-ci-cancel") as HTMLButtonElement;
    const nextBtn = actions.querySelector(".yo-ci-next") as HTMLButtonElement;

    // Per-question selected index, defaulting to the recommended option (or 0).
    const picked: number[] = list.map((q) =>
      Math.max(0, q.options.findIndex((o) => o.recommended)),
    );
    let step = 0;          // which question is showing
    let cursor = 0;        // keyboard cursor within the current question
    let rows: HTMLElement[] = []; // option rows for the current step

    function isLast(): boolean { return step === list.length - 1; }

    function paintRows(): void {
      rows.forEach((row, oi) => {
        const isSel = picked[step] === oi;
        const isCur = oi === cursor;
        row.classList.toggle("selected", isSel);
        row.classList.toggle("cursor", isCur);
        row.setAttribute("aria-checked", isSel ? "true" : "false");
      });
    }
    function setCursor(i: number): void {
      cursor = Math.max(0, Math.min(rows.length - 1, i));
      picked[step] = cursor; // highlight implies selection for this question
      paintRows();
      rows[cursor]?.scrollIntoView({ block: "nearest" });
    }

    // Render the question + options for the current step into the body.
    function renderStep(): void {
      const q = list[step];
      body.innerHTML = "";
      // re-trigger the step-fade animation
      body.style.animation = "none";
      void body.offsetWidth;
      body.style.animation = "";

      const qEl = document.createElement("div");
      qEl.className = "yo-ci-question";
      qEl.textContent = q.question || "";
      body.appendChild(qEl);

      const opts = document.createElement("div");
      opts.className = "yo-ci-options";
      rows = [];
      q.options.forEach((opt, oi) => {
        const row = document.createElement("div");
        row.className = "yo-ci-option";
        row.setAttribute("role", "radio");
        const badge = opt.recommended ? `<span class="yo-ci-recommended">Recommended</span>` : "";
        row.innerHTML =
          `<span class="yo-ci-radio" aria-hidden="true"></span>` +
          `<span class="yo-ci-option-main">` +
            `<span class="yo-ci-option-head"><span class="yo-ci-option-label"></span>${badge}</span>` +
            (opt.description ? `<span class="yo-ci-option-desc"></span>` : "") +
          `</span>`;
        (row.querySelector(".yo-ci-option-label") as HTMLElement).textContent = opt.label;
        const desc = row.querySelector(".yo-ci-option-desc") as HTMLElement | null;
        if (desc && opt.description) desc.textContent = opt.description;
        row.addEventListener("click", () => { setCursor(oi); panel.focus(); });
        row.addEventListener("dblclick", () => { setCursor(oi); advance(); });
        opts.appendChild(row);
        rows.push(row);
      });
      body.appendChild(opts);

      // Title reflects the current question's header (falls back per step).
      titleEl.textContent = q.header || (multi ? `Question ${step + 1} of ${list.length}` : "Input required");

      // Cursor starts on this question's current selection.
      cursor = picked[step];
      paintRows();

      // Footer state.
      backBtn.hidden = step === 0;
      cancelBtn.hidden = step !== 0; // only offer Cancel on the first step
      nextBtn.textContent = isLast() ? "Submit" : "Next";
      hintEl.textContent = multi
        ? (isLast() ? "↑↓ choose · enter submit · esc back" : "↑↓ choose · enter next · esc back")
        : "↑↓ choose · enter submit · esc cancel";

      stepDots.forEach((dot, i) => {
        dot.classList.toggle("current", i === step);
        dot.classList.toggle("done", i < step);
      });
    }

    let resolved = false;
    function finish(answers: Array<string | null>, cancelled: boolean): void {
      if (resolved) return;
      resolved = true;
      window.yo.respondYoAsk(id, answers);
      if (cancelled) {
        appendChatMarker({ state: "denied", label: "Cancelled" });
      } else {
        const summary = list
          .map((q, qi) => q.options[picked[qi]]?.label)
          .filter(Boolean)
          .join(" · ");
        appendChatMarker({ state: "answered", label: "Answered:", value: summary });
      }
      closeInteraction();
    }
    const submit = () => finish(list.map((q, qi) => q.options[picked[qi]]?.label ?? null), false);
    const cancel = () => finish(list.map(() => null), true);

    // Advance: next step, or submit on the last one.
    function advance(): void {
      if (isLast()) { submit(); return; }
      step += 1;
      renderStep();
    }
    function back(): void {
      if (step === 0) return;
      step -= 1;
      renderStep();
    }

    backBtn.addEventListener("click", back);
    cancelBtn.addEventListener("click", cancel);
    nextBtn.addEventListener("click", advance);

    panel.addEventListener("keydown", (e) => {
      if (resolved) return;
      if (e.key === "ArrowDown") { e.preventDefault(); setCursor(cursor + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setCursor(cursor - 1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); back(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); if (!isLast()) advance(); }
      else if (e.key === "Enter") { e.preventDefault(); advance(); }
      else if (e.key === "Escape") {
        e.preventDefault();
        // Esc steps back through the wizard; cancels from the first question.
        if (step === 0) cancel(); else back();
      }
      else if (/^[1-9]$/.test(e.key)) {
        const target = Number(e.key) - 1;
        if (target < rows.length) { e.preventDefault(); setCursor(target); }
      }
    });

    renderStep();
    openInteraction(panel);
  });

  // Set the rotating greeting on the empty-state block at startup so it's
  // live from app load (not just after opening the panel / a new session).
  if (!yoPanelMessages.children.length) showYoWelcome();

  // Return the public API
  return {
    openYoPanel,
    closeYoPanel,
    isYoPanelOpen,
    yoScroll,
    showYoWelcome,
    hideYoWelcome,
    getYoPanelWidth: () => yoPanel.offsetWidth,
    listChats: () => window.yo.yoChatsList(),
    loadChat: (id: string) => loadChatById(id),
    deleteChat: async (id: string) => { await window.yo.yoChatsDelete(id); },
    newChat: () => startNewChat(),
  };
}
