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
// when selected, it paints the trigger plan-blue.
const PLAN_COLOR = "#4A9EFF";

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
let pendingYoMessages: string[] = [];

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

let yoAccountFirstName: string | null = null; // null = not yet fetched

function hideYoWelcome() {
  const w = document.getElementById("yo-panel-welcome");
  if (w) w.remove();
}

function fillGreeting(template: string): string {
  const name = (yoAccountFirstName && yoAccountFirstName.trim()) || "there";
  return template.replace(/\{name\}/g, name);
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
    const apply = () => { sub.textContent = fillGreeting(template); };
    apply();
    if (yoAccountFirstName === null && window.yo && (window.yo as { getAccountInfo?: () => Promise<{ firstName?: string } | null> }).getAccountInfo) {
      (window.yo as { getAccountInfo: () => Promise<{ firstName?: string } | null> }).getAccountInfo()
        .then((info) => { yoAccountFirstName = info?.firstName || ""; apply(); })
        .catch(() => { yoAccountFirstName = ""; });
    }
    return;
  }

  // Legacy fallback (no #yo-greeting block): inject the welcome div.
  hideYoWelcome();
  const w = document.createElement("div");
  w.id = "yo-panel-welcome";
  w.className = "yo-panel-welcome";
  w.innerHTML = `<div class="yo-welcome-logo"><span class="yo-welcome-dot">.</span>Yo</div>
    <div class="yo-welcome-tagline" id="yo-welcome-greeting"></div>`;
  const greetingEl = w.querySelector<HTMLElement>("#yo-welcome-greeting");
  if (greetingEl) greetingEl.textContent = fillGreeting(template);
  yoPanelMessages.appendChild(w);
  if (yoAccountFirstName === null && window.yo && (window.yo as { getAccountInfo?: () => Promise<{ firstName?: string } | null> }).getAccountInfo) {
    (window.yo as { getAccountInfo: () => Promise<{ firstName?: string } | null> }).getAccountInfo()
      .then((info) => {
        yoAccountFirstName = info?.firstName || "";
        const live = document.getElementById("yo-welcome-greeting");
        if (live) live.textContent = fillGreeting(template);
      })
      .catch(() => { yoAccountFirstName = ""; });
  }
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

// ── Swarm activity (inline) ────────────────────────────────────────────────
// When a swarm is running, its bus events stream into the conversation as
// lightweight rows — agent badge, who→who, kind, body.

interface SwarmRosterEntry { position: string; provider?: string; model?: string }
// ── Helpers: scroll ────────────────────────────────────────────────────────

function yoScroll() {
  yoPanelMessages.scrollTop = yoPanelMessages.scrollHeight;
  yoScrollBtn.classList.remove("visible");
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
  yoPanelInput.value = "";
  autoGrowYoInput();
  addYoUserMessage(text);
  if (/\.yo\b/i.test(text)) {
    window.yo.dripsPreview("cat");
  }
  (window as unknown as { __yoStartTurnPhase?: () => void }).__yoStartTurnPhase?.();
  showYoStatus("");
  setYoThinking(true);
  window.yo.yoPanelSend(text);
}

/** Send the next queued message, if any, once a turn finishes. */
function drainPendingYoMessages() {
  if (pendingYoMessages.length === 0) return;
  const next = pendingYoMessages.shift()!;
  (window as unknown as { __yoStartTurnPhase?: () => void }).__yoStartTurnPhase?.();
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
    const [account, savedWidth] = await Promise.all([
      window.yo.getAccountInfo(),
      window.yo.yoPanelGetWidth(),
    ]);
    if (savedWidth && savedWidth !== defaultWidth) {
      yoPanel.style.width = `${savedWidth}px`;
      document.body.style.setProperty("--right-inset", `${savedWidth}px`);
      window.yo.yoPanelResize(savedWidth);
    }
    // Update the brand chrome's name span without clobbering the new
    // <brand-logo> .Sup <name> structure. paintBrand() already sets the
    // logo from the active model — we just want to refresh the name now
    // that the account first-name is in hand.
    if (account?.firstName) {
      yoAccountFirstName = account.firstName;
      const nameEl = document.getElementById("yo-brand-name");
      if (nameEl) nameEl.textContent = account.firstName;
      const logoEl = document.getElementById("yo-brand-logo") as HTMLImageElement | null;
      if (logoEl && (!logoEl.src || logoEl.style.display === "none")) {
        const url = logoUrlFor(brandForModel(currentChatModel));
        if (url) { logoEl.src = url; logoEl.style.display = ""; }
      }
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
      const first = (yoAccountFirstName && yoAccountFirstName.trim()) || "there";
      nameEl.textContent = first;
    }
  }
  if (modelTrigger && modelMenu) {
    modelTrigger.addEventListener("click", (e) => {
      e.stopPropagation();
      modelMenu.classList.toggle("hidden");
      yoPermMenu.classList.add("hidden");
    });
  }
  modelOptions?.forEach((opt) => {
    opt.addEventListener("click", async () => {
      if (opt.classList.contains("disabled")) return;
      const newModel = opt.dataset.value || "";
      modelMenu?.classList.add("hidden");
      if (newModel === currentChatModel) return;
      // If a chat is in progress, warn before resetting. Empty messages =
      // welcome screen = safe to change silently.
      const inChat = yoPanelMessages.children.length > 0 && !yoPanelMessages.querySelector(".yo-panel-welcome");
      if (inChat && !confirm("Changing the model will start a new chat — context will be lost. Continue?")) return;
      currentChatModel = newModel;
      modelOptions.forEach((o) => o.classList.toggle("active", o === opt));
      paintModelLabel();
      paintBrand();
      // Persist via saveLLMConfig — provider is always anthropic until the
      // GPT loop ships. (The GPT items are disabled, so we never hit that
      // branch from this dropdown.)
      const fallback = newModel || "claude-sonnet-4-6";
      await window.yo.saveLLMConfig({ provider: "anthropic", model: fallback });
      if (inChat) await startNewChat();
    });
  });
  paintModelLabel();
  paintBrand();
  // Initial paint: highlight the active default.
  modelOptions?.forEach((o) => o.classList.toggle("active", (o.dataset.value || "") === currentChatModel));

  // Also repaint when the account first-name resolves (async after init).
  if (yoAccountFirstName === null && window.yo && (window.yo as { getAccountInfo?: () => Promise<{ firstName?: string } | null> }).getAccountInfo) {
    (window.yo as { getAccountInfo: () => Promise<{ firstName?: string } | null> }).getAccountInfo()
      .then((info) => { yoAccountFirstName = info?.firstName || ""; paintBrand(); })
      .catch(() => { yoAccountFirstName = ""; paintBrand(); });
  }

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

    chat.appendRaw(card);
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

  // ── ask_user_question — the purple "Input required" dialog ──────────────────
  // The agent (mcp__yo__ask_user_question) blocks until the user answers. We
  // render one selectable-option block per question, pre-select the recommended
  // option (or the first), and reply with one chosen label per question
  // (null = cancelled). Same card family + theme tokens as the approval card.
  window.yo.onYoAskRequest((id, questions) => {
    const list = Array.isArray(questions) ? questions : [];
    if (list.length === 0) { window.yo.respondYoAsk(id, []); return; }

    const card = document.createElement("div");
    card.className = "yo-ask-card";
    card.dataset.askId = id;
    card.tabIndex = 0; // focusable so the card owns keyboard nav

    const header = document.createElement("div");
    header.className = "yo-ask-header";
    header.innerHTML =
      `<svg class="yo-ask-header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>` +
      `<span></span>`;
    (header.querySelector("span") as HTMLElement).textContent =
      list.length === 1 && list[0].header ? list[0].header : "Input required";
    card.appendChild(header);

    // Per-question selected index, defaulting to the recommended option (or 0).
    const picked: number[] = list.map((q) =>
      Math.max(0, q.options.findIndex((o) => o.recommended)),
    );
    // Flat list of every option row, so ↑/↓ can walk across questions.
    const flat: Array<{ qi: number; oi: number; row: HTMLElement }> = [];
    let cursor = 0;

    list.forEach((q, qi) => {
      const qEl = document.createElement("div");
      qEl.className = "yo-ask-question";
      qEl.textContent = q.question || "";
      card.appendChild(qEl);

      const opts = document.createElement("div");
      opts.className = "yo-ask-options";
      q.options.forEach((opt, oi) => {
        const row = document.createElement("div");
        row.className = "yo-ask-option";
        row.setAttribute("role", "radio");
        const badge = opt.recommended ? `<span class="yo-ask-recommended">Recommended</span>` : "";
        row.innerHTML =
          `<span class="yo-ask-radio" aria-hidden="true"></span>` +
          `<span class="yo-ask-option-main">` +
            `<span class="yo-ask-option-head"><span class="yo-ask-option-label"></span>${badge}</span>` +
            (opt.description ? `<span class="yo-ask-option-desc"></span>` : "") +
          `</span>`;
        (row.querySelector(".yo-ask-option-label") as HTMLElement).textContent = opt.label;
        const desc = row.querySelector(".yo-ask-option-desc") as HTMLElement | null;
        if (desc && opt.description) desc.textContent = opt.description;
        const flatIdx = flat.length;
        row.addEventListener("click", () => { setCursor(flatIdx); card.focus(); });
        row.addEventListener("dblclick", () => { setCursor(flatIdx); submit(); });
        opts.appendChild(row);
        flat.push({ qi, oi, row });
      });
      card.appendChild(opts);
    });

    const actions = document.createElement("div");
    actions.className = "yo-ask-actions";
    actions.innerHTML =
      `<span class="yo-ask-hint">↑↓ choose · enter submit · esc cancel</span>` +
      `<button type="button" class="yo-ask-btn yo-ask-cancel">Cancel</button>` +
      `<button type="button" class="yo-ask-btn yo-ask-submit">Submit answer</button>`;
    card.appendChild(actions);

    // Selecting a row = picking it for its question (radio behavior) and
    // moving the keyboard cursor onto it.
    function paint(): void {
      flat.forEach(({ qi, oi, row }, i) => {
        const isSel = picked[qi] === oi;
        const isCur = i === cursor;
        row.classList.toggle("selected", isSel);
        row.classList.toggle("cursor", isCur);
        row.setAttribute("aria-checked", isSel ? "true" : "false");
      });
    }
    function setCursor(i: number): void {
      cursor = Math.max(0, Math.min(flat.length - 1, i));
      const { qi, oi, row } = flat[cursor];
      picked[qi] = oi; // highlight implies selection for that question
      paint();
      row.scrollIntoView({ block: "nearest" });
    }
    // Start the cursor on the first question's default selection.
    cursor = flat.findIndex((f) => f.qi === 0 && f.oi === picked[0]);
    if (cursor < 0) cursor = 0;
    paint();

    let resolved = false;
    function finish(answers: Array<string | null>): void {
      if (resolved) return;
      resolved = true;
      card.classList.add("yo-ask-resolved");
      card.removeAttribute("tabindex");
      card.querySelectorAll<HTMLButtonElement>("button").forEach((b) => (b.disabled = true));
      window.yo.respondYoAsk(id, answers);
    }
    const submit = () => finish(list.map((q, qi) => q.options[picked[qi]]?.label ?? null));
    const cancel = () => finish(list.map(() => null));
    actions.querySelector(".yo-ask-cancel")!.addEventListener("click", cancel);
    actions.querySelector(".yo-ask-submit")!.addEventListener("click", submit);

    card.addEventListener("keydown", (e) => {
      if (resolved) return;
      if (e.key === "ArrowDown") { e.preventDefault(); setCursor(cursor + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setCursor(cursor - 1); }
      else if (e.key === "Enter") { e.preventDefault(); submit(); }
      else if (e.key === "Escape") { e.preventDefault(); cancel(); }
      else if (/^[1-9]$/.test(e.key)) {
        // Jump to the Nth option within the cursor's current question.
        const qi = flat[cursor].qi;
        const target = flat.findIndex((f) => f.qi === qi && f.oi === Number(e.key) - 1);
        if (target >= 0) { e.preventDefault(); setCursor(target); }
      }
    });

    chat.appendRaw(card);
    yoScroll();
    card.focus();
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
