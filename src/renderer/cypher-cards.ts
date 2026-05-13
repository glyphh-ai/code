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
}

const IDLE_TIMEOUT = 6000;
const MAX_AGENT_FEED = 40;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function relTime(ts: number): string {
  const d = Math.floor((Date.now() - ts) / 1000);
  if (d < 5) return "now";
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  return `${Math.floor(d / 3600)}h`;
}

export class CypherCards {
  private container: HTMLElement | null = null;
  private bgGrid: HTMLElement | null = null;
  private fgGrid: HTMLElement | null = null;
  private jammers: CardsJammer[] = [];
  private activeAgents = new Set<string>();
  private idleTimers = new Map<string, number>();
  private agentFeeds = new Map<string, AgentFeedEntry[]>();
  private cardElements = new Map<string, HTMLElement>();
  private activeElements = new Map<string, HTMLElement>();

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
    this.rebuildBackground();
  }

  updateStatus(id: string, status: string): void {
    const j = this.jammers.find((x) => x.id === id);
    if (j) j.status = status;
    this.updateCardStatus(id, status);
    if (this.activeElements.has(id)) {
      this.updateActiveDot(id, status);
    }
  }

  onFeedEvent(from: string, kind: string, body: string): void {
    if (!this.container) return;

    const entry: AgentFeedEntry = { kind, body, ts: Date.now() };
    let feed = this.agentFeeds.get(from);
    if (!feed) {
      feed = [];
      this.agentFeeds.set(from, feed);
    }
    feed.unshift(entry);
    if (feed.length > MAX_AGENT_FEED) feed.length = MAX_AGENT_FEED;

    this.promote(from);
    this.appendToActiveFeed(from, entry);
    this.resetIdleTimer(from);
  }

  dispose(): void {
    for (const t of this.idleTimers.values()) clearTimeout(t);
    this.idleTimers.clear();
    this.activeAgents.clear();
    this.agentFeeds.clear();
    this.cardElements.clear();
    this.activeElements.clear();
    if (this.container) this.container.innerHTML = "";
  }

  private promote(agentId: string): void {
    if (this.activeAgents.has(agentId)) return;
    this.activeAgents.add(agentId);
    this.updateLayers();
    this.createActiveCard(agentId);
  }

  private demote(agentId: string): void {
    if (!this.activeAgents.has(agentId)) return;
    this.activeAgents.delete(agentId);
    this.idleTimers.delete(agentId);

    const el = this.activeElements.get(agentId);
    if (el) {
      el.style.transition = "opacity 0.35s ease, transform 0.35s ease";
      el.style.opacity = "0";
      el.style.transform = "scale(0.92)";
      setTimeout(() => el.remove(), 350);
      this.activeElements.delete(agentId);
    }

    this.updateLayers();
  }

  private resetIdleTimer(agentId: string): void {
    const prev = this.idleTimers.get(agentId);
    if (prev) clearTimeout(prev);
    this.idleTimers.set(
      agentId,
      window.setTimeout(() => this.demote(agentId), IDLE_TIMEOUT),
    );
  }

  private updateLayers(): void {
    const hasActive = this.activeAgents.size > 0;
    this.bgGrid?.classList.toggle("has-active", hasActive);
    this.fgGrid?.classList.toggle("multi", this.activeAgents.size > 1);
  }

  private rebuildBackground(): void {
    if (!this.bgGrid) return;
    this.bgGrid.innerHTML = "";
    this.cardElements.clear();

    for (const j of this.jammers) {
      const card = document.createElement("div");
      card.className = "cards-agent";
      card.dataset.agentId = j.id;

      const avatarHtml = j.avatarUrl
        ? `<img src="${escapeHtml(j.avatarUrl)}" alt="" />`
        : identiconSvg(j.id, 32);

      card.innerHTML = `
        <div class="cards-agent-head">
          <div class="cards-agent-avatar">${avatarHtml}</div>
          <div>
            <div class="cards-agent-name">${escapeHtml(j.name || j.id)}</div>
            <div class="cards-agent-role">${escapeHtml(j.position)}</div>
          </div>
        </div>
        <div class="cards-agent-status">
          <div class="cards-agent-dot ${j.status}"></div>
          <span>${j.status}</span>
        </div>
      `;

      this.bgGrid.appendChild(card);
      this.cardElements.set(j.id, card);
    }
  }

  private updateCardStatus(id: string, status: string): void {
    const card = this.cardElements.get(id);
    if (!card) return;
    const dot = card.querySelector(".cards-agent-dot");
    if (dot) {
      dot.className = `cards-agent-dot ${status}`;
      const label = dot.nextElementSibling;
      if (label) label.textContent = status;
    }
  }

  private updateActiveDot(id: string, status: string): void {
    const el = this.activeElements.get(id);
    if (!el) return;
    const dot = el.querySelector(".cards-active-dot") as HTMLElement;
    if (!dot) return;
    const isRunning = status === "running" || status === "starting";
    dot.style.background = isRunning ? "#ffb400" : status === "error" ? "#f44" : "#4caf50";
    dot.style.boxShadow = isRunning ? "0 0 10px rgba(255,180,0,0.5)" : "none";
    dot.style.animation = isRunning ? "pulse-anim 2s ease-in-out infinite" : "none";
  }

  private createActiveCard(agentId: string): void {
    if (!this.fgGrid) return;

    const existing = this.activeElements.get(agentId);
    if (existing) return;

    const j = this.jammers.find((x) => x.id === agentId);
    const name = j?.name || agentId;
    const position = j?.position || "agent";
    const avatarUrl = j?.avatarUrl;

    const avatarHtml = avatarUrl
      ? `<img src="${escapeHtml(avatarUrl)}" alt="" />`
      : identiconSvg(agentId, 28);

    const el = document.createElement("div");
    el.className = "cards-active";
    el.dataset.agentId = agentId;

    el.innerHTML = `
      <div class="cards-active-head">
        <div class="cards-active-avatar">${avatarHtml}</div>
        <div>
          <div class="cards-active-name">${escapeHtml(name)}</div>
          <div class="cards-active-role">${escapeHtml(position)}</div>
        </div>
        <div class="cards-active-dot"></div>
      </div>
      <div class="cards-active-feed" data-agent="${escapeHtml(agentId)}"></div>
    `;

    this.fgGrid.appendChild(el);
    this.activeElements.set(agentId, el);

    const feed = this.agentFeeds.get(agentId);
    if (feed && feed.length > 0) {
      const feedEl = el.querySelector(".cards-active-feed")!;
      const recent = feed.slice(0, 10).reverse();
      for (const entry of recent) {
        feedEl.appendChild(this.createFeedRow(entry));
      }
      feedEl.scrollTop = feedEl.scrollHeight;
    }
  }

  private appendToActiveFeed(agentId: string, entry: AgentFeedEntry): void {
    const el = this.activeElements.get(agentId);
    if (!el) return;
    const feedEl = el.querySelector(".cards-active-feed");
    if (!feedEl) return;

    feedEl.appendChild(this.createFeedRow(entry));

    while (feedEl.children.length > MAX_AGENT_FEED) {
      feedEl.removeChild(feedEl.firstChild!);
    }

    feedEl.scrollTop = feedEl.scrollHeight;
  }

  private createFeedRow(entry: AgentFeedEntry): HTMLElement {
    const row = document.createElement("div");
    row.className = "cards-feed-entry";
    const truncBody = entry.body.length > 300 ? entry.body.slice(0, 300) + "..." : entry.body;
    row.innerHTML = `
      <span class="cards-feed-time">${relTime(entry.ts)}</span>
      <span class="cards-feed-kind">${escapeHtml(entry.kind)}</span>
      ${escapeHtml(truncBody)}
    `;
    return row;
  }
}
