import { identiconSvg } from "./identicon";

export interface CardsJammer {
  id: string;
  name: string;
  position: string;
  status: string;
  avatarUrl?: string | null;
}

interface AgentFeedEntry {
  kind: string;
  body: string;
  ts: number;
  toolName?: string;
}

const IDLE_TIMEOUT = 6000;
const MAX_FEED = 30;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function relTime(ts: number): string {
  const d = Math.floor((Date.now() - ts) / 1000);
  if (d < 5) return "now";
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  return `${Math.floor(d / 3600)}h`;
}

function kindColor(kind: string): string {
  switch (kind) {
    case "agent_tool_use": return "#ffb400";
    case "agent_result": case "status": return "#4caf50";
    case "agent_thinking": return "#64b5f6";
    case "agent_error": return "#f44";
    case "preview_url": return "#5599ff";
    case "show_output": return "#c084fc";
    default: return "#4caf50";
  }
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "agent_tool_use": return "tool";
    case "agent_result": return "done";
    case "agent_thinking": return "thinking";
    case "agent_error": return "error";
    case "preview_url": return "preview";
    case "show_output": return "output";
    case "status": return "status";
    default: return kind.replace(/^agent_/, "");
  }
}

export class CypherCards {
  private container: HTMLElement | null = null;
  private bgGrid: HTMLElement | null = null;
  private fgGrid: HTMLElement | null = null;
  private jammers: CardsJammer[] = [];
  private activeAgents = new Set<string>();
  private idleTimers = new Map<string, number>();
  private agentFeeds = new Map<string, AgentFeedEntry[]>();
  private pinnedAgents = new Set<string>();
  private bgCards = new Map<string, HTMLElement>();
  private fgCards = new Map<string, HTMLElement>();

  init(container: HTMLElement): void {
    this.container = container;
    container.innerHTML = "";

    this.bgGrid = document.createElement("div");
    this.bgGrid.className = "cards-bg";
    container.appendChild(this.bgGrid);

    this.fgGrid = document.createElement("div");
    this.fgGrid.className = "cards-fg";
    container.appendChild(this.fgGrid);
  }

  setJammers(jammers: CardsJammer[]): void {
    this.jammers = jammers;
    this.rebuildBg();
    this.refreshFgAvatars();
  }

  updateStatus(id: string, status: string): void {
    const j = this.jammers.find((x) => x.id === id);
    if (j) j.status = status;

    const bgDot = this.bgCards.get(id)?.querySelector(".cards-agent-dot");
    if (bgDot) {
      bgDot.className = `cards-agent-dot ${status}`;
      const label = bgDot.nextElementSibling;
      if (label) label.textContent = status;
    }

    const fgDot = this.fgCards.get(id)?.querySelector(".cards-active-dot") as HTMLElement | null;
    if (fgDot) {
      const on = status === "running" || status === "starting";
      fgDot.style.background = on ? "#ffb400" : status === "error" ? "#f44" : "#4caf50";
      fgDot.style.boxShadow = on ? "0 0 8px rgba(255,180,0,0.4)" : "none";
      fgDot.style.animation = on ? "pulse-anim 2s ease-in-out infinite" : "none";
    }
  }

  onFeedEvent(from: string, kind: string, body: string, meta?: Record<string, unknown>): void {
    if (!this.container) return;

    let feed = this.agentFeeds.get(from);
    if (!feed) { feed = []; this.agentFeeds.set(from, feed); }
    const toolName = meta?.tool_name ? String(meta.tool_name) : undefined;
    const entry: AgentFeedEntry = { kind, body, ts: Date.now(), toolName };
    feed.unshift(entry);
    if (feed.length > MAX_FEED) feed.length = MAX_FEED;

    this.promote(from);
    this.appendFeedRow(from, entry);
    this.resetIdle(from);
  }

  dispose(): void {
    for (const t of this.idleTimers.values()) clearTimeout(t);
    this.idleTimers.clear();
    this.activeAgents.clear();
    this.pinnedAgents.clear();
    this.agentFeeds.clear();
    this.bgCards.clear();
    this.fgCards.clear();
    if (this.container) this.container.innerHTML = "";
  }

  // ── promote / demote ────────────────────────────────────

  private promote(id: string): void {
    if (this.activeAgents.has(id)) return;
    this.activeAgents.add(id);
    this.bgGrid?.classList.add("has-active");
    this.buildFgCard(id);
  }

  private demote(id: string): void {
    if (!this.activeAgents.has(id)) return;
    this.activeAgents.delete(id);
    this.idleTimers.delete(id);

    const el = this.fgCards.get(id);
    if (el) {
      el.classList.remove("entering");
      el.classList.add("leaving");
      el.addEventListener("animationend", () => el.remove(), { once: true });
      this.fgCards.delete(id);
    }

    if (this.activeAgents.size === 0) {
      this.bgGrid?.classList.remove("has-active");
    }
  }

  private resetIdle(id: string): void {
    if (this.pinnedAgents.has(id)) return;
    const prev = this.idleTimers.get(id);
    if (prev) clearTimeout(prev);
    this.idleTimers.set(id, window.setTimeout(() => this.demote(id), IDLE_TIMEOUT));
  }

  // ── background grid ─────────────────────────────────────

  private rebuildBg(): void {
    if (!this.bgGrid) return;
    this.bgGrid.innerHTML = "";
    this.bgCards.clear();

    for (const j of this.jammers) {
      const card = document.createElement("div");
      card.className = "cards-agent";

      const avatar = j.avatarUrl
        ? `<img src="${esc(j.avatarUrl)}" alt="" />`
        : identiconSvg(j.id, 26);

      card.innerHTML = `
        <div class="cards-agent-head">
          <div class="cards-agent-avatar">${avatar}</div>
          <div style="min-width:0;flex:1">
            <div class="cards-agent-name">${esc(j.name || j.id)}</div>
            <div class="cards-agent-role">${esc(j.position)}</div>
          </div>
          <div class="cards-agent-dot ${j.status}"></div>
        </div>
        <div class="cards-agent-status">
          <span>${j.status}</span>
        </div>
      `;

      this.bgGrid.appendChild(card);
      this.bgCards.set(j.id, card);
    }
  }

  private refreshFgAvatars(): void {
    for (const [id, el] of this.fgCards) {
      const j = this.jammers.find((x) => x.id === id);
      if (!j?.avatarUrl) continue;
      const avatarEl = el.querySelector(".cards-active-avatar");
      if (!avatarEl) continue;
      if (avatarEl.querySelector("img")) continue;
      avatarEl.innerHTML = `<img src="${esc(j.avatarUrl)}" alt="" />`;
    }
  }

  // ── foreground active card ──────────────────────────────

  private buildFgCard(id: string): void {
    if (!this.fgGrid || this.fgCards.has(id)) return;

    const j = this.jammers.find((x) => x.id === id);
    const name = j?.name || id;
    const position = j?.position || "agent";
    const avatarUrl = j?.avatarUrl;

    const avatar = avatarUrl
      ? `<img src="${esc(avatarUrl)}" alt="" />`
      : identiconSvg(id, 26);

    const el = document.createElement("div");
    el.className = "cards-active entering";

    el.innerHTML = `
      <div class="cards-active-head">
        <div class="cards-active-avatar">${avatar}</div>
        <div style="min-width:0;flex:1">
          <div class="cards-active-name">${esc(name)}</div>
          <div class="cards-active-role">${esc(position)}</div>
        </div>
        <div class="cards-active-dot"></div>
      </div>
      <div class="cards-active-feed"></div>
    `;

    this.fgGrid.appendChild(el);
    this.fgCards.set(id, el);

    // Backfill recent feed entries
    const feed = this.agentFeeds.get(id);
    if (feed && feed.length > 0) {
      const feedEl = el.querySelector(".cards-active-feed")!;
      for (const entry of feed.slice(0, 8).reverse()) {
        feedEl.appendChild(this.makeFeedRow(entry));
      }
      feedEl.scrollTop = feedEl.scrollHeight;
    }

    // Click to pin/unpin
    el.addEventListener("click", () => {
      if (this.pinnedAgents.has(id)) {
        this.pinnedAgents.delete(id);
        el.classList.remove("pinned");
        this.resetIdle(id);
      } else {
        this.pinnedAgents.add(id);
        el.classList.add("pinned");
        const timer = this.idleTimers.get(id);
        if (timer) { clearTimeout(timer); this.idleTimers.delete(id); }
      }
    });

    // Remove entering class after animation
    el.addEventListener("animationend", () => el.classList.remove("entering"), { once: true });
  }

  private appendFeedRow(id: string, entry: AgentFeedEntry): void {
    const el = this.fgCards.get(id);
    if (!el) return;
    const feedEl = el.querySelector(".cards-active-feed");
    if (!feedEl) return;

    feedEl.appendChild(this.makeFeedRow(entry));
    while (feedEl.children.length > MAX_FEED) feedEl.removeChild(feedEl.firstChild!);
    feedEl.scrollTop = feedEl.scrollHeight;
  }

  private makeFeedRow(entry: AgentFeedEntry): HTMLElement {
    const row = document.createElement("div");
    row.className = "cards-feed-entry";
    row.dataset.kind = entry.kind;
    const color = kindColor(entry.kind);
    const label = kindLabel(entry.kind);
    const toolSuffix = entry.toolName ? ` - <span class="cards-feed-toolname">${esc(entry.toolName)}</span>` : "";
    const body = entry.body.length > 250 ? entry.body.slice(0, 250) + "..." : entry.body;
    row.innerHTML = `
      <div class="cards-feed-dot" style="background:${color}"></div>
      <div class="cards-feed-content">
        <div class="cards-feed-head">
          <span class="cards-feed-label" style="color:${color}">${esc(label)}${toolSuffix}</span>
          <span class="cards-feed-time">${relTime(entry.ts)}</span>
        </div>
        <div class="cards-feed-body">${esc(body)}</div>
      </div>
    `;
    const bodyEl = row.querySelector(".cards-feed-body");
    if (bodyEl) {
      bodyEl.addEventListener("click", (e) => {
        e.stopPropagation();
        bodyEl.classList.toggle("expanded");
      });
    }
    return row;
  }
}
