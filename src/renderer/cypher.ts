/**
 * cypher.ts — the local swarm panel.
 *
 * Renders a running swarm: agent cards (left), the live bus feed (top-right),
 * and the agent roster (bottom-right). Everything is driven locally — the
 * SwarmManifest is pushed by main, the feed comes off the in-process bus.
 */
import { CypherCards, type CardsJammer } from "./cypher-cards";
import { badgeImgFor } from "./model-badges";

interface SwarmAgent {
  id: string;
  position: string;
  parentAgentId: string | null;
  area?: string;
  role?: string;
  provider?: string;
  model?: string;
}
interface SwarmManifest {
  id: string;
  title: string;
  goal: string;
  agents: SwarmAgent[];
}
interface SwarmActivity {
  from: string;
  to?: string;
  kind: string;
  body: string;
  tags?: string[];
  ts: number;
  meta?: Record<string, unknown>;
}
interface SwarmAPI {
  getSwarmManifest: () => Promise<SwarmManifest | null>;
  onSwarmManifest: (cb: (m: SwarmManifest) => void) => () => void;
  onActivity: (cb: (e: SwarmActivity) => void) => () => void;
  onAgentStatus: (cb: (agentName: string, status: string) => void) => () => void;
  onLeaderDone: (cb: (info: { agentId: string; agentName: string; body: string }) => void) => () => void;
  agentStart: (agentName: string) => void;
  agentStop: (agentName: string) => void;
  getTheme: () => Promise<string>;
  onThemeChanged: (cb: (theme: string) => void) => () => void;
  openExternal: (url: string) => void;
}

const api = (window as unknown as { swarm: SwarmAPI }).swarm;

// ── State ──────────────────────────────────────────────────
let manifest: SwarmManifest | null = null;
const agentStatus = new Map<string, string>(); // agentId → status
const agentById = new Map<string, SwarmAgent>();
let cards: CypherCards | null = null;
const MAX_FEED = 200;
let feedCount = 0;

// ── Helpers ────────────────────────────────────────────────
function $(id: string): HTMLElement { return document.getElementById(id)!; }
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

const KIND_META: Record<string, { label: string; color: string }> = {
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
  preview_url:    { label: "preview",  color: "#5599ff" },
};
function kindMeta(kind: string): { label: string; color: string } {
  return KIND_META[kind] || { label: kind.replace(/^agent_/, ""), color: "#8a8a92" };
}

/** Provider-logo badge for a feed/agent row, keyed by the agent's id. */
function badgeFor(agentId: string): string {
  const a = agentById.get(agentId);
  if (a?.provider) return badgeImgFor(a.provider, a.model || "");
  const letter = (agentId || "?").charAt(0).toUpperCase();
  return `<span class="member-badge-initial">${esc(letter)}</span>`;
}

// ── Roster / cards ─────────────────────────────────────────
function renderRoster(): void {
  const list = $("agent-list");
  list.innerHTML = "";
  const agents = manifest?.agents ?? [];
  $("agent-count").textContent = String(agents.length);
  for (const a of agents) {
    const status = agentStatus.get(a.id) || "idle";
    const isLeader = a.position === "leader";
    const row = document.createElement("div");
    row.className = "agent-row";
    row.innerHTML =
      `<span class="agent-badge">${badgeFor(a.id)}</span>` +
      `<div class="agent-info">` +
        `<div class="agent-name">${esc(a.id)}</div>` +
        `<div class="agent-sub">${esc(a.role || a.model || a.provider || "")}` +
          `${a.area ? ` · ${esc(a.area)}` : ""}</div>` +
      `</div>` +
      `<span class="agent-role-pill ${isLeader ? "leader" : "worker"}">${isLeader ? "lead" : "worker"}</span>` +
      `<span class="agent-status ${esc(status)}" title="${esc(status)}"></span>`;
    list.appendChild(row);
  }
}

function syncCards(): void {
  if (!manifest) return;
  if (!cards) {
    $("cards-empty")?.remove();
    cards = new CypherCards();
    cards.init($("cards-container"));
  }
  const jammers: CardsJammer[] = manifest.agents.map((a) => ({
    id: a.id,
    name: a.id,
    position: a.position,
    status: agentStatus.get(a.id) || "idle",
  }));
  cards.setJammers(jammers);
}

// ── Feed ───────────────────────────────────────────────────
function addFeedRow(e: SwarmActivity): void {
  if (!e.from || !e.body?.trim()) return;
  if (e.from === "orchestrator" || e.from === "unknown") return;
  const empty = document.getElementById("feed-empty");
  if (empty) empty.remove();

  const list = $("feed-list");
  const meta = kindMeta(e.kind);
  const row = document.createElement("div");
  row.className = "feed-row";
  row.innerHTML =
    `<span class="feed-badge">${badgeFor(e.from)}</span>` +
    `<div class="feed-body">` +
      `<div class="feed-meta">` +
        `<span class="feed-from">${esc(e.from)}</span>` +
        `${e.to ? `<span class="feed-to">→ ${esc(e.to)}</span>` : ""}` +
        `<span class="feed-kind" style="background:${meta.color}22;color:${meta.color}">${esc(meta.label)}</span>` +
        `<span class="feed-time">${relTime(e.ts)}</span>` +
      `</div>` +
      `<div class="feed-text">${esc(e.body.slice(0, 800))}</div>` +
    `</div>`;
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  list.appendChild(row);
  while (list.children.length > MAX_FEED) list.removeChild(list.firstChild!);
  if (atBottom) list.scrollTop = list.scrollHeight;
  feedCount++;
  $("feed-count").textContent = String(feedCount);
}

// ── Controls ───────────────────────────────────────────────
function updateControls(): void {
  const has = !!manifest && manifest.agents.length > 0;
  ($("btn-start-all") as HTMLButtonElement).disabled = !has;
  ($("btn-stop-all") as HTMLButtonElement).disabled = !has;
}

// ── Manifest ───────────────────────────────────────────────
function applyManifest(m: SwarmManifest | null): void {
  manifest = m;
  agentById.clear();
  if (m) for (const a of m.agents) agentById.set(a.id, a);
  $("swarm-title").textContent = m?.title || "No swarm running";
  $("swarm-goal").textContent = m?.goal || "";
  renderRoster();
  syncCards();
  updateControls();
}

// ── Boot ───────────────────────────────────────────────────
async function boot(): Promise<void> {
  try {
    const theme = await api.getTheme();
    document.documentElement.setAttribute("data-theme", theme);
    api.onThemeChanged((t) => document.documentElement.setAttribute("data-theme", t));
  } catch { /* theme IPC not ready */ }

  $("btn-start-all").addEventListener("click", () => {
    for (const a of manifest?.agents ?? []) {
      const s = agentStatus.get(a.id);
      if (s !== "running" && s !== "starting") api.agentStart(a.id);
    }
  });
  $("btn-stop-all").addEventListener("click", () => {
    for (const a of manifest?.agents ?? []) {
      api.agentStop(a.id);
      agentStatus.set(a.id, "idle");
    }
    renderRoster();
    syncCards();
  });

  api.onSwarmManifest((m) => applyManifest(m));

  api.onActivity((e) => {
    addFeedRow(e);
    cards?.onFeedEvent(e.from, e.kind, e.body, e.meta);
  });

  api.onAgentStatus((agentId, status) => {
    agentStatus.set(agentId, status);
    cards?.updateStatus(agentId, status);
    renderRoster();
  });

  api.onLeaderDone((info) => {
    addFeedRow({
      from: info.agentId || info.agentName,
      kind: "complete_task",
      body: info.body || "Leader reported the swarm is done.",
      ts: Date.now(),
    });
  });

  try {
    const m = await api.getSwarmManifest();
    if (m) applyManifest(m);
  } catch { /* no swarm yet */ }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void boot());
} else {
  void boot();
}
