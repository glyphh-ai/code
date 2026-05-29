/**
 * YoAgentRenderer — embeddable, per-instance chat UI for the .Yo agent.
 *
 * Mounts into a pre-rendered DOM tree that uses the same IDs/classes as the
 * right-rail .Yo panel (see index.html / agent.html). Behaviors mirror
 * yo-panel-ui.ts but are SCOPED to the host root and DRIVEN by callback
 * bindings (not direct window.yo IPC), so the same class can back the
 * right-rail (window.yo.* callbacks) AND the yo://agent app (per-instance
 * window.agent.* callbacks).
 *
 * Phase 1 covers the core agent loop: send + stream + tool-use cards +
 * tool-results + todo checklist + approvals + error display + perm/model
 * dropdowns + history dropdown + auto-scroll. The drip picker, voice
 * input, plan actions, swarm activity, and input-history recall stay in
 * yo-panel-ui.ts for now and will fold into this class in a follow-up.
 */

import { formatMarkdown } from "./format-markdown.js";
import { brandDisplayFor, brandForModel, logoUrlFor } from "./model-badges.js";

export type PermMode = "default" | "plan" | "acceptEdits" | "bypassPermissions";

export interface ChatSummary {
  id: string;
  title: string;
  created: string;
  messageCount: number;
}

export interface YoAgentCallbacks {
  /** User sent a message. */
  send: (text: string, model: string, perm: PermMode) => void;
  /** User hit the stop / square button while the agent was thinking. */
  stop: () => void;
  /** User asked to start a new chat. */
  newChat: () => void | Promise<void>;
  /** User clicked a chat row in the history dropdown. */
  loadChat: (id: string) => void | Promise<void>;
  /** User clicked × on a chat row. */
  deleteChat: (id: string) => void | Promise<void>;
  /** History dropdown opened — return the chat list to render. */
  listChats: () => Promise<ChatSummary[]>;
  /** Approval prompt response. */
  respondApproval: (id: string, approved: boolean) => void;
  /** Multi-choice ask response — value is the picked option's `value`, or
   *  null when the user cancelled. The agent engine consumes this to
   *  decide what to do next (e.g. spec workflow advances, edits, retries,
   *  or aborts based on a phase-approval pick). */
  respondAsk?: (askId: string, value: string | null) => void;
  /** User picked a different workflow kind from the type dropdown. The
   *  current in-flight turn (if any) keeps its kind; the change applies
   *  from the next user message. Optional — surfaces that don't have a
   *  type dropdown leave this unset. */
  kindChanged?: (kind: AgentKind) => void;
  /** User picked a different model. Optional; when wired, the host
   *  persists to AgentConfig.model_name so the dropdown restores on
   *  next launch. */
  modelChanged?: (model: string) => void;
  /** User picked a different permission mode. */
  permChanged?: (perm: PermMode) => void;
}

export interface AskOption {
  /** Stable id sent back to the engine on submit. */
  value: string;
  /** Bold row title. */
  label: string;
  /** Lighter row description. Optional. */
  description?: string;
  /** Marks the row as "Recommended" with the purple pill. Only one option
   *  should normally carry this. */
  recommended?: boolean;
}

export interface YoAgentRendererOptions {
  /** DOM root containing the agent chrome (defaults to document). */
  root?: Document | HTMLElement;
  callbacks: YoAgentCallbacks;
  /** Initial permission + model state. */
  initialPerm?: PermMode;
  initialModel?: string;
  /** Show the drip button on the controls row? Right-rail = true. */
  dripEnabled?: boolean;
}

// Inline SVG icons — replacements for the previous emoji glyphs so the icon
// set stays consistent across themes and platforms. Sized by CSS.
const PERM_ICONS: Record<PermMode, string> = {
  default: `<svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
  plan: `<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="12" y2="17"/></svg>`,
  acceptEdits: `<svg viewBox="0 0 24 24"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
  bypassPermissions: `<svg viewBox="0 0 24 24"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
};
const PERM_LABELS: Record<PermMode, string> = {
  default: "ask",
  plan: "plan",
  acceptEdits: "auto",
  bypassPermissions: "bypass",
};
const PERM_COLORS: Record<PermMode, string> = {
  default: "#25C75E",
  plan: "#8B5CF6",
  acceptEdits: "#FF8C00",
  bypassPermissions: "#FF2D55",
};

export type AgentKind = "standard" | "spec" | "vibe";
const TYPE_ICONS: Record<AgentKind, string> = {
  standard: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9 12l2 2 4-4"/></svg>`,
  spec: `<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>`,
  vibe: `<svg viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
};
const TYPE_LABELS: Record<AgentKind, string> = { standard: "standard", spec: "spec", vibe: "vibe" };

const MODEL_PRETTY: Record<string, string> = {
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-opus-4-7": "Opus 4.7",
  "claude-opus-4-8": "Opus 4.8",
  "claude-haiku-4-5": "Haiku 4.5",
  "gpt-5-codex": "GPT-5 Codex",
};

const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"];
const PHRASES = ["thinking", "cooking", "vibing", "brewing", "conjuring"];

function isFileTool(name: string): boolean {
  return /(read|edit|write|create|notebook)/i.test(name) && !name.startsWith("delegate_");
}
function toolBasename(p: string): string {
  const clean = p.split(/[?#]/)[0].replace(/[/\\]+$/, "");
  return clean.split(/[/\\]/).pop() || clean || p;
}
function toolInputSummary(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  if (name === "Bash" || name === "run_command") return String(obj.command ?? "");
  const first = Object.values(obj).find((v) => typeof v === "string");
  return typeof first === "string" ? first : "";
}
function computeToolStat(name: string, input: unknown, detail: string): string {
  const obj = (input && typeof input === "object") ? (input as Record<string, unknown>) : {};
  const lc = (s: unknown) => (typeof s === "string" && s.length) ? s.split("\n").length : 0;
  const n = name.toLowerCase();
  const lines = detail.trim() ? detail.trim().split("\n").length : 0;
  if (/edit/.test(n)) {
    const add = lc(obj.new_string); const del = lc(obj.old_string);
    if (add || del) return `+${add} −${del}`;
  }
  if (/write|create/.test(n)) {
    const add = lc(obj.content) || lc(obj.text);
    if (add) return `+${add}`;
  }
  if (/read|notebook/.test(n) && lines) return `${lines} line${lines === 1 ? "" : "s"}`;
  if (/command|bash|shell/.test(n)) return lines ? `${lines} line${lines === 1 ? "" : "s"} output` : "done";
  return lines > 1 ? `${lines} lines` : "";
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

export class YoAgentRenderer {
  private root: ParentNode;
  private callbacks: YoAgentCallbacks;
  private dripEnabled: boolean;

  // DOM refs
  private messages!: HTMLElement;
  private input!: HTMLTextAreaElement;
  private sendBtn!: HTMLElement;
  private scrollBtn!: HTMLElement;
  private historyToggle!: HTMLElement;
  private historyPanel!: HTMLElement;
  private historyList!: HTMLElement;
  private historySearch!: HTMLInputElement;
  private chatNewBtn!: HTMLElement;
  private permTrigger!: HTMLElement;
  private permMenu!: HTMLElement;
  private permIcon!: HTMLElement;
  private permLabel!: HTMLElement;
  private typeTrigger: HTMLElement | null = null;
  private typeMenu: HTMLElement | null = null;
  private typeIcon: HTMLElement | null = null;
  private typeLabel: HTMLElement | null = null;
  private agentKind: AgentKind = "standard";
  private modelTrigger!: HTMLElement;
  private modelMenu!: HTMLElement;
  private modelLabel!: HTMLElement;
  private brandLogo: HTMLImageElement | null = null;
  private brandName: HTMLElement | null = null;
  private dripBtn: HTMLElement | null = null;
  private micBtn: HTMLButtonElement | null = null;
  /** When set, paintBrand() uses this in place of the auto-derived brand
   *  display name (e.g. right-rail wants the user's firstName). */
  private brandNameOverride: string | null = null;

  // State
  private perm: PermMode;
  private model: string;
  private thinking = false;
  private responseEl: HTMLElement | null = null;
  private streamingText = "";
  private timelineEl: HTMLElement | null = null;
  private todoEl: HTMLElement | null = null;
  private toolRows = new Map<string, HTMLElement>();
  private toolMeta = new Map<string, { name: string; input: unknown }>();
  private spinnerInterval: ReturnType<typeof setInterval> | null = null;
  private spinnerFrame = 0;
  private spinnerEl: HTMLElement | null = null;
  private mdTimer: ReturnType<typeof setTimeout> | null = null;
  private allChats: ChatSummary[] = [];
  private historyQuery = "";

  constructor(opts: YoAgentRendererOptions) {
    this.root = (opts.root as ParentNode) ?? document;
    this.callbacks = opts.callbacks;
    this.dripEnabled = !!opts.dripEnabled;
    this.perm = opts.initialPerm || "default";
    this.model = opts.initialModel || "";
    this.queryDom();
    this.wireEvents();
    this.applyPerm(this.perm);
    this.applyModel(this.model);
    if (!this.dripEnabled && this.dripBtn) this.dripBtn.style.display = "none";
  }

  // ── DOM ──

  private $<T extends HTMLElement = HTMLElement>(sel: string): T {
    const el = this.root.querySelector(sel) as T | null;
    if (!el) throw new Error(`YoAgentRenderer: missing required element ${sel}`);
    return el;
  }
  private $opt<T extends HTMLElement = HTMLElement>(sel: string): T | null {
    return this.root.querySelector(sel) as T | null;
  }

  private queryDom(): void {
    this.messages = this.$("#yo-panel-messages");
    this.input = this.$<HTMLTextAreaElement>("#yo-panel-input");
    this.sendBtn = this.$("#yo-panel-send");
    this.scrollBtn = this.$("#yo-scroll-btn");
    this.historyToggle = this.$("#yo-history-toggle");
    this.historyPanel = this.$("#yo-history");
    this.historyList = this.$("#yo-history-list");
    this.historySearch = this.$<HTMLInputElement>("#yo-history-search");
    this.chatNewBtn = this.$("#yo-chat-new");
    this.permTrigger = this.$("#yo-perm-trigger");
    this.permMenu = this.$("#yo-perm-menu");
    this.permIcon = this.permTrigger.querySelector(".yo-perm-icon") as HTMLElement;
    this.permLabel = this.permTrigger.querySelector(".yo-perm-label") as HTMLElement;
    // Type dropdown is optional — the agent app has it, the right-rail
    // panel might not (yet). Skip wiring if its DOM isn't present.
    this.typeTrigger = this.root.querySelector("#yo-type-trigger") as HTMLElement | null;
    this.typeMenu = this.root.querySelector("#yo-type-menu") as HTMLElement | null;
    this.typeIcon = this.typeTrigger?.querySelector(".yo-type-icon") as HTMLElement | null;
    this.typeLabel = this.typeTrigger?.querySelector(".yo-type-label") as HTMLElement | null;
    this.modelTrigger = this.$("#yo-model-trigger");
    this.modelMenu = this.$("#yo-model-menu");
    this.modelLabel = this.modelTrigger.querySelector(".yo-model-label") as HTMLElement;
    this.dripBtn = this.$opt("#yo-panel-drip");
    this.micBtn = this.$opt<HTMLButtonElement>("#yo-panel-mic");
    this.brandLogo = this.$opt<HTMLImageElement>("#yo-brand-logo");
    this.brandName = this.$opt("#yo-brand-name");
    void this.micBtn; // referenced for future voice wiring
  }

  /** Paint the brand chrome in the panel title: <logo> .Sup <name>. The
   *  logo comes from logoUrlFor(brandForModel(model)); the name is the
   *  brand display name (Claude / Gpt / …) UNLESS a name override has
   *  been set (right-rail uses the user's first name). Called from
   *  applyModel — but also re-callable from outside via setBrandNameOverride. */
  private paintBrand(): void {
    if (!this.brandLogo && !this.brandName) return;
    const brand = brandForModel(this.model);
    if (this.brandLogo) {
      const url = logoUrlFor(brand);
      if (url) {
        this.brandLogo.src = url;
        this.brandLogo.alt = brand;
        this.brandLogo.style.display = "";
      } else {
        this.brandLogo.removeAttribute("src");
        this.brandLogo.style.display = "none";
      }
    }
    if (this.brandName) {
      const name = this.brandNameOverride ?? brandDisplayFor(brand);
      this.brandName.textContent = name;
    }
  }

  /** Hosts call this when the displayed name should NOT be the brand
   *  display (e.g. the right-rail wants the user's first name instead).
   *  Pass null to revert to brand-display behavior. */
  setBrandNameOverride(name: string | null): void {
    this.brandNameOverride = name;
    this.paintBrand();
  }

  private wireEvents(): void {
    this.sendBtn.addEventListener("click", () => this.onSendClick());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.onSendClick();
      }
    });
    this.input.addEventListener("input", () => this.autoGrow());

    this.historyToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      const isHidden = this.historyPanel.classList.contains("hidden");
      if (isHidden) {
        void this.loadHistory();
        this.historyPanel.classList.remove("hidden");
        this.historySearch.value = "";
        this.applyHistoryFilter("");
        this.historySearch.focus();
      } else {
        this.historyPanel.classList.add("hidden");
      }
    });
    document.addEventListener("click", (e) => {
      if (this.historyPanel.classList.contains("hidden")) return;
      const target = e.target as Node;
      if (!this.historyPanel.contains(target) && !this.historyToggle.contains(target)) {
        this.historyPanel.classList.add("hidden");
      }
    });
    this.historySearch.addEventListener("input", () => {
      this.historyQuery = this.historySearch.value;
      this.applyHistoryFilter(this.historyQuery);
    });

    this.chatNewBtn.addEventListener("click", () => { void this.callbacks.newChat(); });

    this.permTrigger.addEventListener("click", (e) => {
      e.stopPropagation();
      this.permMenu.classList.toggle("hidden");
      this.modelMenu.classList.add("hidden");
      this.typeMenu?.classList.add("hidden");
    });
    this.permMenu.querySelectorAll<HTMLElement>(".yo-perm-option").forEach((opt) => {
      opt.addEventListener("click", () => {
        const v = (opt.dataset.value || "default") as PermMode;
        this.applyPerm(v);
        this.permMenu.classList.add("hidden");
      });
    });

    // Type dropdown (only if mounted in this surface)
    if (this.typeTrigger && this.typeMenu) {
      const typeTrigger = this.typeTrigger;
      const typeMenu = this.typeMenu;
      typeTrigger.addEventListener("click", (e) => {
        e.stopPropagation();
        typeMenu.classList.toggle("hidden");
        this.permMenu.classList.add("hidden");
        this.modelMenu.classList.add("hidden");
      });
      typeMenu.querySelectorAll<HTMLElement>(".yo-type-option").forEach((opt) => {
        opt.addEventListener("click", () => {
          const v = (opt.dataset.value || "standard") as AgentKind;
          this.applyType(v);
          typeMenu.classList.add("hidden");
        });
      });
    }

    this.modelTrigger.addEventListener("click", (e) => {
      e.stopPropagation();
      this.modelMenu.classList.toggle("hidden");
      this.permMenu.classList.add("hidden");
    });
    this.modelMenu.querySelectorAll<HTMLElement>(".yo-model-option").forEach((opt) => {
      opt.addEventListener("click", () => {
        if (opt.classList.contains("disabled")) return;
        const v = opt.dataset.value || "";
        this.applyModel(v);
        this.modelMenu.classList.add("hidden");
      });
    });

    document.addEventListener("click", (e) => {
      const t = e.target as Node;
      if (!this.permTrigger.contains(t) && !this.permMenu.contains(t)) this.permMenu.classList.add("hidden");
      if (!this.modelTrigger.contains(t) && !this.modelMenu.contains(t)) this.modelMenu.classList.add("hidden");
      if (this.typeTrigger && this.typeMenu &&
          !this.typeTrigger.contains(t) && !this.typeMenu.contains(t)) {
        this.typeMenu.classList.add("hidden");
      }
    });

    this.messages.addEventListener("scroll", () => this.updateScrollBtn());
    this.scrollBtn.addEventListener("click", () => this.scrollToBottom());
  }

  private onSendClick(): void {
    if (this.thinking) {
      this.callbacks.stop();
      return;
    }
    const text = this.input.value.trim();
    if (!text) return;
    this.input.value = "";
    this.autoGrow();
    this.addUserMessage(text);
    this.startThinking();
    this.callbacks.send(text, this.model, this.perm);
  }

  // ── Public renderer API ──

  appendToken(delta: string): void {
    if (!delta) return;
    if (!this.responseEl) {
      this.clearStatus();
      this.responseEl = document.createElement("div");
      this.responseEl.className = "yo-msg yo-msg-assistant yo-msg-streaming";
      this.messages.appendChild(this.responseEl);
    }
    this.streamingText += delta;
    if (!this.mdTimer) {
      this.mdTimer = setTimeout(() => {
        this.mdTimer = null;
        if (this.responseEl) {
          this.responseEl.innerHTML = formatMarkdown(this.streamingText);
          this.scrollToBottom();
        }
      }, 80);
    }
  }

  showToolUse(id: string, name: string, input: unknown): void {
    if (!this.spinnerEl) this.showStatus();
    this.closeOpenTextBlock();
    if (name === "TodoWrite") {
      this.renderTodoChecklist(input);
      return;
    }
    this.startToolRow(id, name, input);
  }

  showToolResult(id: string, detail: unknown): void {
    const text = typeof detail === "string" ? detail
      : Array.isArray(detail) ? detail.map((c: { text?: string } | unknown) => (c as { text?: string })?.text || "").join("")
      : "";
    this.finishToolRow(id, text);
  }

  finalizeMessage(fullText?: string): void {
    this.stopThinking();
    if (this.mdTimer) { clearTimeout(this.mdTimer); this.mdTimer = null; }
    if (!this.responseEl && fullText && fullText.trim()) {
      this.responseEl = document.createElement("div");
      this.responseEl.className = "yo-msg yo-msg-assistant";
      this.messages.appendChild(this.responseEl);
      this.streamingText = fullText;
    }
    if (this.responseEl) {
      this.responseEl.classList.remove("yo-msg-streaming");
      this.responseEl.innerHTML = formatMarkdown(this.streamingText || fullText || "");
    }
    this.responseEl = null;
    this.streamingText = "";
    this.timelineEl = null;
    this.todoEl = null;
    this.scrollToBottom();
  }

  showError(msg: string): void {
    this.stopThinking();
    const el = document.createElement("div");
    el.className = "yo-msg yo-msg-error";
    el.textContent = msg || "Error.";
    this.messages.appendChild(el);
    this.scrollToBottom();
  }

  /** Multi-choice ask card — the purple "Input required" component the
   *  spec workflow uses between phase approvals. Also reusable for any
   *  other multi-choice question the agent emits. The card replaces the
   *  spinner if one is showing (since the agent is now blocked on the
   *  user) and re-emerges below when the next turn starts. */
  showAsk(askId: string, question: string, options: AskOption[]): void {
    this.clearStatus(); // agent is blocked on user — drop the spinner
    const card = document.createElement("div");
    card.className = "yo-ask-card";
    card.dataset.askId = askId;

    // Pre-select the recommended option (or the first one) so the user
    // can just hit Submit. Tracked in a closure so the click handlers
    // can read + update.
    const recommendedIdx = options.findIndex((o) => o.recommended);
    let pickedIdx = recommendedIdx >= 0 ? recommendedIdx : 0;

    card.innerHTML = `
      <div class="yo-ask-header">
        <svg class="yo-ask-header-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <span>Input required</span>
      </div>
      <div class="yo-ask-question"></div>
      <div class="yo-ask-options"></div>
      <div class="yo-ask-actions">
        <button type="button" class="yo-ask-btn yo-ask-cancel">Cancel</button>
        <button type="button" class="yo-ask-btn yo-ask-submit">Submit answer</button>
      </div>
    `;
    (card.querySelector(".yo-ask-question") as HTMLElement).textContent = question || "";
    const optsEl = card.querySelector(".yo-ask-options") as HTMLElement;
    options.forEach((opt, i) => {
      const row = document.createElement("div");
      row.className = "yo-ask-option" + (i === pickedIdx ? " selected" : "");
      row.dataset.idx = String(i);
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
      });
      optsEl.appendChild(row);
    });

    const resolve = (value: string | null) => {
      // Disable everything + visually fade so the user can't double-resolve.
      card.classList.add("yo-ask-resolved");
      card.querySelectorAll<HTMLButtonElement>("button").forEach((b) => (b.disabled = true));
      this.callbacks.respondAsk?.(askId, value);
    };
    card.querySelector(".yo-ask-cancel")!.addEventListener("click", () => resolve(null));
    card.querySelector(".yo-ask-submit")!.addEventListener("click", () => {
      const picked = options[pickedIdx];
      resolve(picked ? picked.value : null);
    });

    this.messages.appendChild(card);
    this.scrollToBottom();
  }

  showApprovalPrompt(id: string, toolName: string, toolLabel: string, _input: unknown): void {
    const el = document.createElement("div");
    el.className = "yo-msg yo-approval-msg";
    el.innerHTML = `
      <span class="yo-approval-title">${escapeHtml(toolLabel || toolName)}</span>
      <div class="yo-approval-actions">
        <button class="yo-approval-btn yo-approval-allow">Allow</button>
        <button class="yo-approval-btn yo-approval-deny">Deny</button>
      </div>
    `;
    el.querySelector(".yo-approval-allow")?.addEventListener("click", () => {
      el.classList.add("yo-approval-resolved");
      this.callbacks.respondApproval(id, true);
    });
    el.querySelector(".yo-approval-deny")?.addEventListener("click", () => {
      el.classList.add("yo-approval-resolved");
      this.callbacks.respondApproval(id, false);
    });
    this.messages.appendChild(el);
    this.scrollToBottom();
  }

  addUserMessage(text: string): void {
    const el = document.createElement("div");
    el.className = "yo-msg yo-msg-user";
    el.textContent = text;
    this.messages.appendChild(el);
    this.scrollToBottom();
  }

  clearChat(): void {
    this.messages.innerHTML = "";
    this.responseEl = null;
    this.streamingText = "";
    this.timelineEl = null;
    this.todoEl = null;
    this.toolRows.clear();
    this.toolMeta.clear();
    this.stopThinking();
  }

  loadMessages(msgs: Array<{ role: "user" | "assistant"; content: string }>): void {
    this.clearChat();
    for (const m of msgs) {
      const el = document.createElement("div");
      el.className = m.role === "user" ? "yo-msg yo-msg-user" : "yo-msg yo-msg-assistant";
      if (m.role === "assistant") el.innerHTML = formatMarkdown(m.content);
      else el.textContent = m.content;
      this.messages.appendChild(el);
    }
    this.scrollToBottom();
  }

  // ── Thinking + status ──

  private startThinking(): void {
    this.thinking = true;
    this.sendBtn.textContent = "■";
    this.sendBtn.classList.add("yo-stop");
    this.showStatus();
  }
  private stopThinking(): void {
    this.thinking = false;
    this.sendBtn.textContent = "↑";
    this.sendBtn.classList.remove("yo-stop");
    this.clearStatus();
  }
  private showStatus(): void {
    if (this.spinnerEl) return;
    const el = document.createElement("div");
    el.className = "yo-msg yo-msg-status";
    const phrase = PHRASES[Math.floor(Math.random() * PHRASES.length)];
    el.innerHTML = `<span class="yo-ag-spinner">⠋</span><span class="yo-ag-phrase">${phrase}...</span>`;
    this.messages.appendChild(el);
    this.spinnerEl = el;
    this.startSpinner();
  }
  private clearStatus(): void {
    this.stopSpinner();
    if (this.spinnerEl) { this.spinnerEl.remove(); this.spinnerEl = null; }
  }
  private startSpinner(): void {
    if (this.spinnerInterval) return;
    this.spinnerInterval = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % BRAILLE.length;
      const dot = this.spinnerEl?.querySelector(".yo-ag-spinner") as HTMLElement | null;
      if (dot) dot.textContent = BRAILLE[this.spinnerFrame];
    }, 80);
  }
  private stopSpinner(): void {
    if (this.spinnerInterval) { clearInterval(this.spinnerInterval); this.spinnerInterval = null; }
  }

  // ── Timeline / tool rows ──

  private ensureTimeline(): void {
    if (this.timelineEl && this.timelineEl.parentElement) return;
    const el = document.createElement("div");
    el.className = "yo-timeline";
    // Tool rows belong ABOVE the spinner — the spinner indicates ongoing
    // work, so it should remain the last item in the message column as
    // tools accumulate. If the spinner is already mounted, insert the
    // timeline before it so future appendChilds into the timeline stack
    // above the spinner naturally.
    if (this.spinnerEl && this.spinnerEl.parentElement === this.messages) {
      this.messages.insertBefore(el, this.spinnerEl);
    } else {
      this.messages.appendChild(el);
    }
    this.timelineEl = el;
  }

  private startToolRow(id: string, name: string, input: unknown): void {
    this.ensureTimeline();
    this.toolMeta.set(id, { name, input });
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
    const titleLine = document.createElement("div");
    titleLine.className = "yo-result-titleline";
    const nameEl = document.createElement("span");
    nameEl.className = "yo-result-name";
    nameEl.textContent = name;
    titleLine.appendChild(nameEl);
    headings.appendChild(titleLine);

    const subtitleText = toolInputSummary(name, input);
    if (subtitleText) {
      const sub = document.createElement("span");
      sub.className = "yo-result-file";
      if (isFileTool(name)) {
        sub.textContent = toolBasename(subtitleText);
        sub.title = subtitleText;
      } else {
        sub.textContent = subtitleText;
        sub.title = subtitleText;
      }
      titleLine.appendChild(sub);
    }
    header.appendChild(headings);
    block.appendChild(header);

    this.timelineEl!.appendChild(block);
    this.toolRows.set(id, block);
    this.scrollToBottom();
  }

  private finishToolRow(id: string, detail: string): void {
    const block = this.toolRows.get(id);
    const meta = this.toolMeta.get(id);
    this.toolRows.delete(id);
    this.toolMeta.delete(id);
    if (!block) return;
    block.classList.remove("yo-active");
    block.classList.add("yo-done");

    const trimmed = (detail || "").trim();
    const stat = meta ? computeToolStat(meta.name, meta.input, detail) : "";
    if (stat || trimmed) {
      const statLine = document.createElement("div");
      statLine.className = "yo-tool-stat";
      const statText = document.createElement("span");
      statText.className = "yo-tool-stat-text";
      statText.textContent = stat || "output";
      statLine.appendChild(statText);
      if (trimmed) {
        const chev = document.createElement("span");
        chev.className = "yo-tool-stat-chevron";
        chev.textContent = "▸";
        statLine.appendChild(chev);
      }
      block.appendChild(statLine);
      if (trimmed) {
        const content = document.createElement("div");
        content.className = "yo-result-content";
        content.textContent = trimmed;
        block.appendChild(content);
        block.classList.add("yo-has-detail");
        statLine.addEventListener("click", (e) => {
          e.stopPropagation();
          block.classList.toggle("yo-expanded");
        });
      }
    }
    this.scrollToBottom();
  }

  private closeOpenTextBlock(): void {
    if (this.mdTimer) { clearTimeout(this.mdTimer); this.mdTimer = null; }
    if (this.responseEl && this.streamingText.trim()) {
      this.responseEl.classList.remove("yo-msg-streaming");
      this.responseEl.innerHTML = formatMarkdown(this.streamingText);
    } else if (this.responseEl && !this.streamingText.trim()) {
      this.responseEl.remove();
    }
    this.responseEl = null;
    this.streamingText = "";
  }

  // ── Todo checklist ──

  private renderTodoChecklist(input: unknown): void {
    const todos = (input as { todos?: Array<{ content: string; status: string }> } | null)?.todos;
    if (!Array.isArray(todos)) return;
    this.ensureTimeline();
    if (!this.todoEl) {
      this.todoEl = document.createElement("div");
      this.todoEl.className = "yo-todo-checklist";
      this.timelineEl!.appendChild(this.todoEl);
    }
    this.todoEl.innerHTML = "";
    for (const t of todos) {
      const row = document.createElement("div");
      row.className = "yo-todo-item";
      const icon = document.createElement("span");
      icon.className = "yo-todo-icon";
      icon.textContent = t.status === "completed" ? "✓" : "○";
      if (t.status === "completed") icon.classList.add("yo-todo-done");
      else if (t.status === "in_progress") icon.classList.add("yo-todo-active");
      const label = document.createElement("span");
      label.className = "yo-todo-label";
      if (t.status === "completed") label.classList.add("yo-todo-label-done");
      label.textContent = t.content || "";
      row.append(icon, label);
      this.todoEl.appendChild(row);
    }
    this.scrollToBottom();
  }

  // ── Perm + model dropdowns ──

  /** Silent perm init — used by the host to seed the dropdown from a
   *  persisted AgentConfig.perm_mode without firing the change callback. */
  initPerm(p: PermMode): void { this.applyPerm(p, /*silent=*/ true); }
  /** Silent model init — used by the host to seed the dropdown from a
   *  persisted AgentConfig.model_name. */
  initModel(m: string): void { this.applyModel(m, /*silent=*/ true); }
  private applyPerm(p: PermMode, silent = false): void {
    const changed = this.perm !== p;
    this.perm = p;
    this.permIcon.innerHTML = PERM_ICONS[p] || PERM_ICONS.default;
    this.permLabel.textContent = PERM_LABELS[p] || "ask";
    const color = PERM_COLORS[p] || PERM_COLORS.default;
    this.permTrigger.style.color = color;
    this.permTrigger.style.borderColor = color;
    this.permMenu.querySelectorAll<HTMLElement>(".yo-perm-option").forEach((o) => {
      o.classList.toggle("active", o.dataset.value === p);
    });
    if (changed && !silent) this.callbacks.permChanged?.(p);
  }

  /** Initialize the kind from a persisted config without firing the change
   *  callback — used on mount to reflect the saved AgentConfig.kind. */
  initAgentKind(k: AgentKind): void { this.applyType(k, /*silent=*/ true); }
  /** User-initiated kind change. Fires the callback so the host can persist. */
  setAgentKind(k: AgentKind): void { this.applyType(k); }
  getAgentKind(): AgentKind { return this.agentKind; }
  private applyType(k: AgentKind, silent = false): void {
    const changed = this.agentKind !== k;
    this.agentKind = k;
    if (this.typeIcon) this.typeIcon.innerHTML = TYPE_ICONS[k] || TYPE_ICONS.standard;
    if (this.typeLabel) this.typeLabel.textContent = TYPE_LABELS[k] || "standard";
    this.typeMenu?.querySelectorAll<HTMLElement>(".yo-type-option").forEach((o) => {
      o.classList.toggle("active", o.dataset.value === k);
    });
    if (changed && !silent) this.callbacks.kindChanged?.(k);
  }

  private applyModel(m: string, silent = false): void {
    const changed = this.model !== m;
    this.model = m;
    this.modelLabel.textContent = MODEL_PRETTY[m] || (m || "Default");
    this.modelMenu.querySelectorAll<HTMLElement>(".yo-model-option").forEach((o) => {
      o.classList.toggle("active", o.dataset.value === m);
    });
    this.paintBrand();
    if (changed && !silent) this.callbacks.modelChanged?.(m);
  }

  // ── History dropdown ──

  private async loadHistory(): Promise<void> {
    try {
      this.allChats = await this.callbacks.listChats();
    } catch {
      this.allChats = [];
    }
    this.renderHistory();
  }

  private renderHistory(): void {
    this.historyList.innerHTML = "";
    if (this.allChats.length === 0) {
      const empty = document.createElement("div");
      empty.className = "yo-history-empty";
      empty.textContent = "no conversations yet";
      this.historyList.appendChild(empty);
      return;
    }
    const recHeader = document.createElement("div");
    recHeader.className = "yo-history-section-header";
    recHeader.textContent = "Recents";
    this.historyList.appendChild(recHeader);
    for (const chat of this.allChats) {
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
        date.textContent = d.toDateString() === now.toDateString()
          ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          : d.toLocaleDateString([], { month: "short", day: "numeric" });
      }
      const del = document.createElement("button");
      del.className = "yo-history-delete";
      del.textContent = "×";
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        await this.callbacks.deleteChat(chat.id);
        void this.loadHistory();
      });
      item.append(title, date, del);
      item.addEventListener("click", () => {
        this.historyPanel.classList.add("hidden");
        void this.callbacks.loadChat(chat.id);
      });
      this.historyList.appendChild(item);
    }
    this.applyHistoryFilter(this.historyQuery);
  }

  private applyHistoryFilter(q: string): void {
    const query = q.trim().toLowerCase();
    const children = Array.from(this.historyList.children) as HTMLElement[];
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
        el.style.display = query ? "none" : "";
      }
    }
    if (currentHeader) currentHeader.style.display = currentMatched > 0 ? "" : "none";
  }

  // ── Misc ──

  private autoGrow(): void {
    this.input.style.height = "auto";
    this.input.style.height = Math.min(this.input.scrollHeight, 200) + "px";
  }
  private scrollToBottom(): void {
    this.messages.scrollTop = this.messages.scrollHeight;
    this.updateScrollBtn();
  }
  private updateScrollBtn(): void {
    const atBottom = (this.messages.scrollHeight - this.messages.scrollTop - this.messages.clientHeight) < 40;
    this.scrollBtn.classList.toggle("hidden", atBottom);
  }

  /** Compat shim — callers expected this hook before the streaming
   *  bubble was created lazily inside appendToken. */
  startAssistantMessage(): void { /* no-op */ }
  /** Compat shim. */
  setThinking(thinking: boolean): void { thinking ? this.startThinking() : this.stopThinking(); }
  /** Compat: set the bound folder in any chrome bar — agent.ts owns the
   *  folder bar in agent.html so this is a no-op in the renderer itself. */
  setCwd(_cwd: string): void { /* no-op; folder bar is outside the renderer */ }
}

/** Factory for callers expecting the prior createYoAgentRenderer shape. */
export function createYoAgentRenderer(opts: YoAgentRendererOptions): YoAgentRenderer {
  return new YoAgentRenderer(opts);
}
