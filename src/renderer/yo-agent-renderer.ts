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
const PERM_COLORS: Record<PermMode, string> = {
  default: "#25C75E",
  plan: "#4A9EFF",
  acceptEdits: "#FF8C00",
  bypassPermissions: "#FF2D55",
};

const MODEL_PRETTY: Record<string, string> = {
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-opus-4-7": "Opus 4.7",
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
  private modelTrigger!: HTMLElement;
  private modelMenu!: HTMLElement;
  private modelLabel!: HTMLElement;
  private dripBtn: HTMLElement | null = null;
  private micBtn: HTMLButtonElement | null = null;

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
    this.modelTrigger = this.$("#yo-model-trigger");
    this.modelMenu = this.$("#yo-model-menu");
    this.modelLabel = this.modelTrigger.querySelector(".yo-model-label") as HTMLElement;
    this.dripBtn = this.$opt("#yo-panel-drip");
    this.micBtn = this.$opt<HTMLButtonElement>("#yo-panel-mic");
    void this.micBtn; // referenced for future voice wiring
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
    });
    this.permMenu.querySelectorAll<HTMLElement>(".yo-perm-option").forEach((opt) => {
      opt.addEventListener("click", () => {
        const v = (opt.dataset.value || "default") as PermMode;
        this.applyPerm(v);
        this.permMenu.classList.add("hidden");
      });
    });

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
    this.messages.appendChild(el);
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

  private applyPerm(p: PermMode): void {
    this.perm = p;
    this.permIcon.textContent = PERM_ICONS[p] || "🔒";
    this.permLabel.textContent = PERM_LABELS[p] || "ask";
    const color = PERM_COLORS[p] || PERM_COLORS.default;
    this.permTrigger.style.color = color;
    this.permTrigger.style.borderColor = color;
    this.permMenu.querySelectorAll<HTMLElement>(".yo-perm-option").forEach((o) => {
      o.classList.toggle("active", o.dataset.value === p);
    });
  }

  private applyModel(m: string): void {
    this.model = m;
    this.modelLabel.textContent = MODEL_PRETTY[m] || (m || "Default");
    this.modelMenu.querySelectorAll<HTMLElement>(".yo-model-option").forEach((o) => {
      o.classList.toggle("active", o.dataset.value === m);
    });
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
