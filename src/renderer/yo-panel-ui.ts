/**
 * Yo panel — messaging, streaming, tool timeline, approval UI, voice input,
 * resize handle, and chat history.
 *
 * Extracted from renderer.ts. All DOM queries happen internally; the caller
 * supplies a `renderGridHandles` callback so the module can notify the layout
 * system when the panel opens/closes without importing renderer internals.
 */

import { formatMarkdown } from "./format-markdown.js";
import { badgeImgFor, brandForModel, logoUrlFor } from "./model-badges.js";

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
let planEnabled = false;
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
let yoSpinnerFrame = 0;
let yoSpinnerEl: HTMLElement | null = null;
let yoTimelineEl: HTMLElement | null = null;

let _mdRenderTimer: ReturnType<typeof setTimeout> | null = null;

const yoToolRows = new Map<string, HTMLElement>();
// Tool name + input stashed at use-time so finishToolRow can compute a stat.
const yoToolMeta = new Map<string, { name: string; input: unknown }>();

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
  planEnabled = perm === "plan";
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
  const el = document.createElement("div");
  el.className = "yo-msg yo-msg-user";
  el.textContent = text;
  yoPanelMessages.appendChild(el);
  yoPanelMessages.scrollTop = yoPanelMessages.scrollHeight;
}

// ── Swarm activity (inline) ────────────────────────────────────────────────
// When a swarm is running, its bus events stream into the conversation as
// lightweight rows — agent badge, who→who, kind, body.

interface SwarmRosterEntry { position: string; provider?: string; model?: string }
const swarmRoster = new Map<string, SwarmRosterEntry>();
// True while a swarm is running in the background — keeps the yo spinner
// alive after the agent's own turn ends, so the panel never looks idle.
let swarmActive = false;
// Backstop: if a swarm goes fully silent this long we assume it finished (or
// stalled) and drop the spinner — not every swarm emits a leader complete_task.
const SWARM_IDLE_MS = 180_000;
let swarmIdleTimer: ReturnType<typeof setTimeout> | null = null;
// Keeps the spinner pinned as the last child while a swarm runs, even as the
// yo agent's own messages and tool rows land below it.
let swarmPinObserver: MutationObserver | null = null;

/** Reset the idle backstop — called on every swarm signal. */
function bumpSwarmIdle(): void {
  if (swarmIdleTimer) clearTimeout(swarmIdleTimer);
  swarmIdleTimer = setTimeout(() => { if (swarmActive) finishSwarm(); }, SWARM_IDLE_MS);
}

/** Keep the thinking spinner pinned to the bottom of the message list. */
function pinSwarmSpinner(): void {
  if (!swarmActive) return;
  if (!yoStatusEl) showYoStatus("");
  // Move it only when it isn't already last — the guard stops the
  // MutationObserver from re-triggering itself forever.
  if (yoStatusEl && yoPanelMessages.lastElementChild !== yoStatusEl) {
    yoPanelMessages.appendChild(yoStatusEl);
  }
}

/** A swarm finished (or stalled) — drop the persistent spinner + watchers. */
function finishSwarm(): void {
  swarmActive = false;
  if (swarmIdleTimer) { clearTimeout(swarmIdleTimer); swarmIdleTimer = null; }
  if (swarmPinObserver) { swarmPinObserver.disconnect(); swarmPinObserver = null; }
  if (!yoThinking) clearYoStatus();
}

const SWARM_KIND_META: Record<string, { label: string; color: string }> = {
  assign_task:    { label: "assign",   color: "#A855F7" },
  accept_task:    { label: "accept",   color: "#4caf50" },
  complete_task:  { label: "done",     color: "#4caf50" },
  report_status:  { label: "report",   color: "#64b5f6" },
  post:           { label: "post",     color: "#8a8a92" },
  post_to:        { label: "to",       color: "#8a8a92" },
  chat:           { label: "chat",     color: "#8a8a92" },
  agent_tool_use: { label: "tool",     color: "#ffb400" },
  agent_thinking: { label: "thinking", color: "#64b5f6" },
  agent_result:   { label: "result",   color: "#4caf50" },
  agent_error:    { label: "error",    color: "#f44" },
  status:         { label: "status",   color: "#4caf50" },
};
function swarmKindMeta(kind: string): { label: string; color: string } {
  return SWARM_KIND_META[kind] || { label: kind.replace(/^agent_/, ""), color: "#8a8a92" };
}
function swarmEsc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function swarmBadge(agentId: string): string {
  const reg = swarmRoster.get(agentId);
  if (reg?.provider) return badgeImgFor(reg.provider, reg.model || "");
  const letter = (agentId || "?").charAt(0).toUpperCase();
  return `<span class="member-badge-initial">${swarmEsc(letter)}</span>`;
}

// `restore` = replaying saved history; render the DOM but skip the live
// side-effects (spinner, idle backstop, marking the swarm active).
function addSwarmStart(info: { title: string; goal: string; agents: Array<{ id: string; position: string; provider?: string; model?: string }> }, restore = false): void {
  swarmRoster.clear();
  for (const a of info.agents) {
    swarmRoster.set(a.id, { position: a.position, provider: a.provider, model: a.model });
  }
  hideYoWelcome();
  const el = document.createElement("div");
  el.className = "yo-msg yo-msg-swarm-start";
  const roster = info.agents
    .map((a) => `<span class="swarm-roster-chip"><span class="swarm-badge">${swarmBadge(a.id)}</span>${swarmEsc(a.id)}${a.position === "leader" ? " ·lead" : ""}</span>`)
    .join("");
  el.innerHTML =
    `<div class="swarm-start-title">🐝 Swarm started — ${swarmEsc(info.title)}</div>` +
    `<div class="swarm-start-goal">${swarmEsc(info.goal)}</div>` +
    `<div class="swarm-start-roster">${roster}</div>`;
  yoPanelMessages.appendChild(el);
  if (restore) return;
  // The swarm now works in the background — keep the spinner alive (with the
  // usual "thinking…" phrase above it) until the leader reports it's done.
  swarmActive = true;
  bumpSwarmIdle();
  if (!swarmPinObserver) {
    swarmPinObserver = new MutationObserver(() => pinSwarmSpinner());
    swarmPinObserver.observe(yoPanelMessages, { childList: true });
  }
  pinSwarmSpinner();
  yoPanelMessages.scrollTop = yoPanelMessages.scrollHeight;
}

// Bodies longer than this collapse behind a "Show more" toggle.
const SWARM_COLLAPSE_CHARS = 320;

function addSwarmActivity(e: { from: string; to?: string; kind: string; body: string; ts: number }, restore = false): void {
  if (!e.from || !e.body?.trim()) return;
  if (e.from === "orchestrator" || e.from === "unknown") return;
  const meta = swarmKindMeta(e.kind);
  const body = e.body.trim().slice(0, 6000);
  const long = body.length > SWARM_COLLAPSE_CHARS;
  const el = document.createElement("div");
  el.className = long ? "yo-msg yo-msg-swarm swarm-collapsible" : "yo-msg yo-msg-swarm";
  el.innerHTML =
    `<span class="swarm-badge">${swarmBadge(e.from)}</span>` +
    `<div class="swarm-body">` +
      `<div class="swarm-meta">` +
        `<span class="swarm-from">${swarmEsc(e.from)}</span>` +
        `${e.to ? `<span class="swarm-to">→ ${swarmEsc(e.to)}</span>` : ""}` +
        `<span class="swarm-kind" style="background:${meta.color}22;color:${meta.color}">${swarmEsc(meta.label)}</span>` +
      `</div>` +
      `<div class="swarm-text yo-md">${formatMarkdown(body)}</div>` +
      (long ? `<button class="swarm-toggle" type="button">Show more</button>` : "") +
    `</div>`;
  if (long) {
    const toggle = el.querySelector(".swarm-toggle") as HTMLButtonElement;
    toggle.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const expanded = el.classList.toggle("swarm-expanded");
      toggle.textContent = expanded ? "Show less" : "Show more";
      if (!expanded) el.scrollIntoView({ block: "nearest" });
    });
  }
  const atBottom = yoPanelMessages.scrollHeight - yoPanelMessages.scrollTop - yoPanelMessages.clientHeight < 80;
  yoPanelMessages.appendChild(el);
  if (restore) return; // replaying history — no live spinner / idle logic
  // The leader signing off (complete_task) means the swarm is done.
  if (e.kind === "complete_task" && swarmRoster.get(e.from)?.position === "leader") {
    finishSwarm();
  } else {
    bumpSwarmIdle();
    pinSwarmSpinner();
  }
  if (atBottom) yoPanelMessages.scrollTop = yoPanelMessages.scrollHeight;
}

// ── Helpers: scroll ────────────────────────────────────────────────────────

function yoScroll() {
  yoPanelMessages.scrollTop = yoPanelMessages.scrollHeight;
  yoScrollBtn.classList.remove("visible");
}

// ── Helpers: spinner ───────────────────────────────────────────────────────

// One ticker drives EVERY .yo-ag-spinner on screen. A single shared interval
// owned by whoever called startSpinner last used to mean an unrelated
// stopSpinner (e.g. finishTimeline) froze a still-visible spinner — notably
// the swarm's persistent one. The ticker self-stops only when no spinner
// element remains, so it can never strand a visible spinner.
function tickSpinners(): void {
  const spinners = document.querySelectorAll<HTMLElement>(".yo-ag-spinner");
  if (spinners.length === 0) {
    if (yoSpinnerInterval) { clearInterval(yoSpinnerInterval); yoSpinnerInterval = null; }
    return;
  }
  yoSpinnerFrame = (yoSpinnerFrame + 1) % BRAILLE.length;
  spinners.forEach((s) => { s.textContent = BRAILLE[yoSpinnerFrame]; });
}

function startSpinner(_el?: HTMLElement) {
  if (yoSpinnerInterval) return; // already ticking — it picks up every spinner
  yoSpinnerInterval = setInterval(tickSpinners, 80);
}

function stopSpinner() {
  // Keep ticking while any spinner is still on screen; only stop when none
  // remain (the ticker also self-stops on its next tick).
  if (document.querySelector(".yo-ag-spinner")) return;
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

/** Last path segment, for the compact header file label. */
function toolBasename(p: string): string {
  const clean = p.split(/[?#]/)[0].replace(/[/\\]+$/, "");
  const seg = clean.split(/[/\\]/).pop() || clean;
  return seg || p;
}

/** Is this a file-path tool (read/edit/write/create)? */
function isFileTool(name: string): boolean {
  return /(read|edit|write|create|notebook)/i.test(name) && !name.startsWith("delegate_");
}

/**
 * A one-line stat for a finished tool — Claude-Code style:
 *   Edit  → "+12 −3"      Write → "+40"      Read → "42 lines"
 *   Bash  → "8 lines"     other → "" (or line count when multi-line)
 */
function computeToolStat(name: string, input: unknown, detail: string): string {
  const obj = (input && typeof input === "object") ? input as Record<string, unknown> : {};
  const lc = (s: unknown) => (typeof s === "string" && s.length) ? s.split("\n").length : 0;
  const n = name.toLowerCase();
  const detailLines = detail.trim() ? detail.trim().split("\n").length : 0;
  if (/edit/.test(n)) {
    const add = lc(obj.new_string); const del = lc(obj.old_string);
    if (add || del) return `+${add} −${del}`;
  }
  if (/write|create/.test(n)) {
    const add = lc(obj.content) || lc(obj.text);
    if (add) return `+${add}`;
  }
  if (/read|notebook/.test(n) && detailLines) {
    return `${detailLines} line${detailLines === 1 ? "" : "s"}`;
  }
  if (/command|bash|shell/.test(n)) {
    return detailLines ? `${detailLines} line${detailLines === 1 ? "" : "s"} output` : "done";
  }
  return detailLines > 1 ? `${detailLines} lines` : "";
}

function startToolRow(id: string, name: string, input: unknown) {
  ensureTimeline();
  yoToolMeta.set(id, { name, input });
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

  // Title line — "<Tool>  <file/arg>" on a single row.
  const titleLine = document.createElement("div");
  titleLine.className = "yo-result-titleline";
  const nameEl = document.createElement("span");
  nameEl.className = "yo-result-name";
  nameEl.textContent = formatToolDisplayName(name);
  titleLine.appendChild(nameEl);
  headings.appendChild(titleLine);

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
    sub.className = "yo-result-file";
    if (isFileTool(name)) {
      // Show the basename inline; full path on hover; click opens it.
      sub.textContent = toolBasename(subtitleText);
      sub.title = subtitleText;
      sub.classList.add("yo-file-link");
      sub.addEventListener("click", (e) => {
        e.stopPropagation();
        window.yo.openInEditor(subtitleText);
      });
    } else {
      sub.textContent = subtitleText;
      sub.title = subtitleText;
    }
    titleLine.appendChild(sub);
  }
  header.appendChild(headings);
  block.appendChild(header);

  yoTimelineEl!.appendChild(block);
  yoToolRows.set(id, block);
  yoScroll();
}

function looksLikeMarkdown(text: string): boolean {
  // Cheap heuristic — only switch to markdown rendering when there's clear
  // signal. Otherwise prefer <pre> so command output keeps its whitespace.
  return /```/.test(text)
    || /^#+ /m.test(text)
    || /^\* \S/m.test(text)
    || /^- \S/m.test(text)
    || /^\d+\. \S/m.test(text);
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
  const meta = yoToolMeta.get(id);
  yoToolRows.delete(id);
  yoToolMeta.delete(id);
  if (!block) return;
  block.classList.remove("yo-active");
  block.classList.add("yo-done");

  const trimmed = cleanToolDetail(detail);

  // Stat line — "+12 −3" / "42 lines" — the always-visible one-line summary,
  // and the click target that expands the full output.
  const stat = meta ? computeToolStat(meta.name, meta.input, detail) : "";
  if (stat || trimmed) {
    const statLine = document.createElement("div");
    statLine.className = "yo-tool-stat";
    const statText = document.createElement("span");
    statText.className = "yo-tool-stat-text";
    statText.textContent = stat || "output";
    statLine.appendChild(statText);
    if (trimmed) {
      const chevron = document.createElement("span");
      chevron.className = "yo-tool-stat-chevron";
      chevron.textContent = "▸";
      statLine.appendChild(chevron);
    }
    block.appendChild(statLine);

    if (trimmed) {
      const content = document.createElement("div");
      content.className = "yo-result-content";
      // Render markdown so code fences in tool output become real <pre><code>
      // blocks. Tool outputs that aren't markdown still degrade cleanly — the
      // formatter passes plain text through. Wrapping non-fenced output in a
      // <pre> preserves whitespace for things like Bash stdout.
      if (looksLikeMarkdown(trimmed)) {
        content.innerHTML = formatMarkdown(trimmed);
        attachCopyHandlers(content);
      } else {
        const pre = document.createElement("pre");
        pre.className = "yo-tool-output";
        pre.textContent = trimmed;
        content.appendChild(pre);
      }
      block.appendChild(content);
      block.classList.add("yo-has-detail");
      // Click the stat line to expand / collapse the full output.
      statLine.addEventListener("click", (e) => {
        e.stopPropagation();
        block.classList.toggle("yo-expanded");
      });
    }
  }
  yoScroll();
}

function updateToolProgress(id: string, status: string) {
  const block = yoToolRows.get(id);
  if (!block) return;
  const titleLine = block.querySelector(".yo-result-titleline");
  if (!titleLine) return;
  let sub = titleLine.querySelector(".yo-result-progress") as HTMLElement | null;
  if (!sub) {
    sub = document.createElement("span");
    sub.className = "yo-result-progress";
    titleLine.appendChild(sub);
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
  // While a swarm runs in the background, the spinner stays put — the
  // agent's own turn ending doesn't mean the panel is idle.
  if (swarmActive) return;
  stopSpinner();
  if (yoStatusEl) { yoStatusEl.remove(); yoStatusEl = null; }
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

function showYoToolUse(id: string, name: string, input: unknown) {
  if (isHiddenTool(name, input)) return;

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
    // Close out the prior tool timeline so the new text bubble is at the
    // bottom and any subsequent tool calls start a FRESH timeline below the
    // text — instead of getting tacked onto the previous timeline, which
    // would render them above this just-streamed text.
    if (yoTimelineEl) {
      yoTimelineEl.classList.add("done");
      yoTimelineEl = null;
    }
    yoResponseEl = document.createElement("div");
    yoResponseEl.className = "yo-msg yo-msg-assistant yo-msg-streaming";
    yoPanelMessages.appendChild(yoResponseEl);
  }
  // Keep the spinner pinned BELOW the streaming text so the user always sees
  // a "still working" indicator even during long quiet stretches between
  // token bursts. It only clears when finalizeYoMessage marks the turn done.
  if (yoThinking) {
    if (!yoStatusEl) showYoStatus("");
    if (yoStatusEl && yoPanelMessages.lastElementChild !== yoStatusEl) {
      yoPanelMessages.appendChild(yoStatusEl);
    }
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

  if (planEnabled && yoLastUserText) {
    showPlanActions();
  }

  yoScroll();
  yoPanelInput.focus();
}

// ── Helpers: plan actions ──────────────────────────────────────────────────

function showPlanActions() {
  // Render the plan-finish prompt as the standard "Input required" card so
  // it matches every other multi-choice question the agent emits. The three
  // existing actions become three card options the user picks between, with
  // "Proceed" pre-selected as the recommended default.
  showAskCard({
    question: "Plan is ready. How do you want to proceed?",
    options: [
      { value: "proceed",      label: "Proceed",         description: "Execute the plan with your current permission setting.", recommended: true },
      { value: "proceed-auto", label: "Proceed (auto)",  description: "Execute the plan and auto-accept edits — no per-tool prompts." },
      { value: "edit",         label: "Edit the request", description: "Bring my previous message back into the input so I can refine it." },
    ],
    onSubmit: (value) => {
      if (value === "proceed") {
        window.yo.setAgentMode("default");
        setPermValue("default");
        showYoStatus("");
        setYoThinking(true);
        window.yo.yoPanelSend("Execute the plan above.");
      } else if (value === "proceed-auto") {
        window.yo.setAgentMode("acceptEdits");
        setPermValue("acceptEdits");
        showYoStatus("");
        setYoThinking(true);
        window.yo.yoPanelSend("Execute the plan above.");
      } else if (value === "edit") {
        yoPanelInput.value = yoLastUserText;
        yoPanelInput.focus();
        autoGrowYoInput();
      }
    },
  });
}

/** Multi-choice "Input required" card — purple-bordered, matches the design
 *  used for any other question the agent surfaces (AskUserQuestion etc.).
 *  Pre-selects the recommended option so a quick Submit ships the default. */
interface AskOption { value: string; label: string; description?: string; recommended?: boolean; preview?: string }
function showAskCard(opts: {
  question: string;
  header?: string;
  options: AskOption[];
  onSubmit: (value: string | null) => void;
}) {
  clearYoStatus();
  const card = document.createElement("div");
  card.className = "yo-ask-card";

  const recommendedIdx = opts.options.findIndex((o) => o.recommended);
  let pickedIdx = recommendedIdx >= 0 ? recommendedIdx : 0;
  const hasPreviews = opts.options.some((o) => !!o.preview);
  if (hasPreviews) card.classList.add("yo-ask-with-preview");

  card.innerHTML = `
    <div class="yo-ask-header">
      <svg class="yo-ask-header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      <span class="yo-ask-header-label"></span>
    </div>
    <div class="yo-ask-question"></div>
    <div class="yo-ask-body">
      <div class="yo-ask-options"></div>
      ${hasPreviews ? `<div class="yo-ask-preview"></div>` : ""}
    </div>
    <div class="yo-ask-actions">
      <button type="button" class="yo-ask-btn yo-ask-cancel">Cancel</button>
      <button type="button" class="yo-ask-btn yo-ask-submit">Submit answer</button>
    </div>
  `;
  (card.querySelector(".yo-ask-header-label") as HTMLElement).textContent = opts.header || "Input required";
  (card.querySelector(".yo-ask-question") as HTMLElement).textContent = opts.question;
  const optsEl = card.querySelector(".yo-ask-options") as HTMLElement;
  const previewEl = card.querySelector(".yo-ask-preview") as HTMLElement | null;

  function paintPreview() {
    if (!previewEl) return;
    const opt = opts.options[pickedIdx];
    if (opt?.preview) {
      previewEl.innerHTML = formatMarkdown(opt.preview);
      attachCopyHandlers(previewEl);
    } else {
      previewEl.innerHTML = `<div class="yo-ask-preview-empty">No preview for this option.</div>`;
    }
  }

  opts.options.forEach((opt, i) => {
    const row = document.createElement("div");
    row.className = "yo-ask-option" + (i === pickedIdx ? " selected" : "");
    const badge = opt.recommended ? `<span class="yo-ask-recommended">Recommended</span>` : "";
    row.innerHTML = `
      <div class="yo-ask-option-head">
        <span class="yo-ask-option-label"></span>
        ${badge}
      </div>
      ${opt.description ? `<div class="yo-ask-option-desc"></div>` : ""}
    `;
    (row.querySelector(".yo-ask-option-label") as HTMLElement).textContent = opt.label;
    const descEl = row.querySelector(".yo-ask-option-desc") as HTMLElement | null;
    if (descEl && opt.description) descEl.textContent = opt.description;
    row.addEventListener("click", () => {
      pickedIdx = i;
      optsEl.querySelectorAll(".yo-ask-option").forEach((el) => el.classList.remove("selected"));
      row.classList.add("selected");
      paintPreview();
    });
    optsEl.appendChild(row);
  });
  paintPreview();

  const resolve = (value: string | null) => {
    card.classList.add("yo-ask-resolved");
    card.querySelectorAll<HTMLButtonElement>("button").forEach((b) => (b.disabled = true));
    opts.onSubmit(value);
  };
  card.querySelector(".yo-ask-cancel")!.addEventListener("click", () => resolve(null));
  card.querySelector(".yo-ask-submit")!.addEventListener("click", () => {
    resolve(opts.options[pickedIdx]?.value ?? null);
  });

  yoPanelMessages.appendChild(card);
  yoScroll();
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

// Load a saved chat by id and replay its messages into the panel.
// Shared by the in-panel history list and the workspace Recents rail.
async function loadChatById(id: string): Promise<void> {
  const messages = await window.yo.yoChatsLoad(id);
  if (!messages) return;
  yoPanelMessages.innerHTML = "";
  yoResponseEl = null;
  yoStatusEl = null;
  yoLastAssistantText = "";
  yoTurnFullText = "";
  if (yoHistoryPanel) yoHistoryPanel.classList.add("hidden");

  for (const msg of messages) {
    // Swarm activity is persisted into the thread — replay it inline.
    if (msg.role === "swarm-start" || msg.role === "swarm") {
      try {
        const data = JSON.parse(msg.text);
        if (msg.role === "swarm-start") addSwarmStart(data, true);
        else addSwarmActivity(data, true);
      } catch { /* skip a malformed swarm entry */ }
      continue;
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
      yoPanelMessages.appendChild(marker);
      continue;
    }
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

// Start a fresh chat — clear the transcript + reset turn state.
async function startNewChat(): Promise<void> {
  await window.yo.yoChatNew();
  yoPanelMessages.innerHTML = "";
  yoResponseEl = null;
  yoStatusEl = null;
  yoLastAssistantText = "";
  yoTurnFullText = "";
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
  window.yo.onYoPanelToken((delta) => appendYoToken(delta));
  window.yo.onYoPanelToolUse((id, name, input) => showYoToolUse(id, name, input));
  window.yo.onYoPanelToolResult((id, detail) => showYoToolResult(id, detail));
  window.yo.onYoPanelToolProgress((id, status) => updateToolProgress(id, status));
  window.yo.onYoPanelDone((fullText) => { finalizeYoMessage(fullText); drainPendingYoMessages(); });
  window.yo.onYoPanelError((err) => showYoError(err));
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

  // Swarm activity streams inline into the conversation.
  window.yo.onYoPanelSwarmStart((info) => addSwarmStart(info));
  window.yo.onYoPanelSwarmActivity((event) => addSwarmActivity(event));
  window.yo.onYoPanelDripEffect((recipe) => {
    window.yo.dripsPreview(recipe);
  });
  // -- Send/stop button --
  // The button is "stop" (■) only when the agent is thinking AND the input is
  // empty. Once the user types, it flips to "send" (↑) so click queues the
  // follow-up instead of aborting the in-flight turn.
  yoPanelSendBtn.addEventListener("click", () => {
    const isStopMode = yoThinking && !yoPanelInput.value.trim();
    if (isStopMode) {
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
          yoPanelMessages.appendChild(el);
          yoScroll();
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

  // -- Ask UI (mcp__yo__ask_user_question) --
  window.yo.onYoAskRequest((id, questions) => {
    // Currently render one question at a time; future-proof for multi.
    const q = questions[0];
    if (!q) { window.yo.respondYoAsk(id, []); return; }
    showAskCard({
      question: q.question,
      header: q.header,
      options: q.options.map((o) => ({
        value: o.label,
        label: o.label,
        description: o.description,
        recommended: (o as { recommended?: boolean }).recommended,
        preview: (o as { preview?: string }).preview,
      })),
      onSubmit: (value) => {
        const answers = questions.map((qq, i) => i === 0 ? value : null);
        window.yo.respondYoAsk(id, answers);
      },
    });
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
