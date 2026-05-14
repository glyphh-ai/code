/**
 * The Drop — discovery surface for cyphers + your agent roster.
 *
 * Two views:
 *   - browse: hero + live cyphers + top agents + your cyphers (server-side data)
 *   - agents: your agent roster (CRUD via IPC bridge)
 *
 * Edit overlay handles agent create/edit. All data flows from the bridged
 * `drop.*` IPC; no direct net calls from the renderer.
 */

import { identiconSvg } from "./identicon";

// ── Types ──────────────────────────────────────────────
interface DropAPI {
  cyphersDiscover: (opts?: { status?: string; type?: string; limit?: number; offset?: number }) => Promise<unknown>;
  cyphersMine: () => Promise<unknown>;
  cypherCreate: (input: Record<string, unknown>) => Promise<unknown>;
  cypherPublish: (id: string, opts?: Record<string, unknown>) => Promise<unknown>;
  cypherStart: (id: string) => Promise<unknown>;
  cypherCancel: (id: string) => Promise<unknown>;
  cypherDelete: (id: string) => Promise<unknown>;
  cypherUpdateMeta: (id: string, patch: { title?: string; goal?: string; description?: string; max_jammers?: number | null }) => Promise<unknown>;
  cypherDraftGet: (id: string) => Promise<unknown>;
  cypherRedraft: (id: string, opts?: { ratio?: number }) => Promise<unknown>;
  cypherDecline: (id: string, agent_local_id: string) => Promise<unknown>;
  cypherWrap: (id: string) => Promise<unknown>;
  cypherEventsList: (id: string, opts?: { since?: number; jam_id?: string; limit?: number }) => Promise<unknown>;
  cypherSetCurrent: (id: string | null) => Promise<unknown>;
  cypherSpawnJammers: (id: string) => Promise<unknown>;
  authMe: () => Promise<unknown>;
  devFlags: () => Promise<{ cyphersEnabled: boolean; enableGhAuth?: boolean }>;
  onCypherEvent: (cb: (cypherId: string, kind: string, payload: Record<string, unknown>) => void) => () => void;

  // GH-bound session (Phase 1)
  ghStatus: () => Promise<{ signedIn: boolean; github: { gh_login: string; gh_avatar: string } | null; expiresAt: number | null }>;
  signInWithGitHub: () => Promise<{ ok: true; status: { signedIn: boolean; github: { gh_login: string; gh_avatar: string } | null } } | { ok: false; error: string; status?: number }>;
  signOutGitHub: () => Promise<{ ok: true }>;
  cypherGet: (id: string) => Promise<unknown>;
  cypherJammers: (id: string) => Promise<unknown>;
  cypherJoin: (id: string, agent_local_id: string, role?: string, invite_token?: string) => Promise<unknown>;
  cypherLeave: (id: string, agent_local_id: string) => Promise<unknown>;
  agentsLeaderboard: (opts?: { skills?: string; days?: number; limit?: number }) => Promise<unknown>;
  leaderboardTopCyphers: (limit?: number) => Promise<unknown>;
  leaderboardTopJammers: (limit?: number) => Promise<unknown>;
  agentsList: () => Promise<unknown>;
  agentsGet: (id: string) => Promise<unknown>;
  agentsSave: (cfg: unknown) => Promise<unknown>;
  agentsRemove: (id: string) => Promise<unknown>;
  agentsIdAvailable: (id: string) => Promise<unknown>;
  cypherCoverGenerate: (opts: { title: string; goal?: string; vibe?: string; customPrompt?: string }) =>
    Promise<{ ok: true; data_base64: string; content_type: string; prompt_used: string } | { ok: false; error: string }>;
  cypherCoverGet: (id: string) => Promise<{ ok: boolean; data_base64?: string; content_type?: string }>;
  cypherCoverUpload: (id: string, dataBase64: string, contentType?: string) => Promise<unknown>;
  cypherCoverDelete: (id: string) => Promise<unknown>;
  appsList: () => Promise<Array<{
    id: string; name: string; url?: string; connected: boolean;
    commands: Record<string, { description: string }>;
    connection?: { pipedreamSlug: string; accountId?: string; healthy?: boolean };
    mcp?: { enabled: boolean };
    meta?: { description: string; capabilities: string[] };
  }>>;
  mcpToolsList: () => Promise<Array<{
    serverId: string; serverName: string;
    name: string; qualifiedName: string; description: string;
  }>>;
  agentAvatarGenerate: (opts: { name: string; role?: string; bio?: string }) =>
    Promise<{ ok: true; data_base64: string; content_type: string } | { ok: false; error: string }>;
  skillsList: () => Promise<string[]>;
  skillsListDetailed: () => Promise<Array<{
    name: string; description?: string;
    requires?: string[]; allowedTools?: string[];
  }>>;
  getApiBase: () => string;
  cypherPanelActivate: (cypherId: string, isOwner: boolean, title?: string) => Promise<unknown>;
  execCommand: (cmd: string) => Promise<unknown>;
  ghAppInstall: () => Promise<{ ok: boolean; installed?: boolean; error?: string }>;
  installationsList: () => Promise<unknown>;
  reposForInstallation: (owner: string) => Promise<unknown>;
}
const drop = (window as unknown as { drop: DropAPI }).drop;

interface Cypher {
  id: string; slug: string; title: string; status: string; type?: string;
  kitty?: number; jammers?: number; jammer_count?: number; description?: string; goal?: string;
  owner_user_id?: string; max_jammers?: number | null;
  lobby_started_at?: string | null;
  lobby_duration_seconds?: number | null;
  cover_image_sha256?: string | null;
  total_input_tokens?: number;
  total_output_tokens?: number;
}
interface Jammer {
  agent_local_id: string;
  user_id: string;
  name?: string;
  avatar_url?: string | null;
  role?: string | null;
  joined_at?: string;
  input_tokens?: number;
  output_tokens?: number;
  turns?: number;
}

type DraftPosition = "leader" | "lieutenant" | "sub-lead" | "worker";

interface AssignmentRow {
  id: string;
  cypher_id: string;
  user_id: string;
  agent_local_id: string;
  position: DraftPosition;
  parent_id: string | null;
  area: string | null;
  contract: string | null;
  score: number;
  draft_round: number;
  declined: boolean;
  created_at: string;
}

interface DraftResult {
  cypher_id: string;
  draft_round: number;
  assignments: AssignmentRow[];
}
interface LeaderboardEntry {
  agent_local_id: string; name: string;
  avatar_url: string | null; bio: string | null; skills: string[];
  cyphers_count: number; tasks_completed: number; success_rate: number; score: number;
}
interface Guardrails {
  max_input_tokens_per_turn?: number;
  max_output_tokens_per_turn?: number;
  max_tokens_per_session?: number;
  max_turns?: number;
  rate_limit_rpm?: number;
  auto_stop_idle_seconds?: number;
}
type ToolPerm = "full" | "read" | "disabled";
interface ToolPermissions {
  shell?: ToolPerm;
  file_system?: ToolPerm;
  git?: ToolPerm;
  browser?: ToolPerm;
  mcp?: ToolPerm;
}
interface AppToolConfig {
  allowAll?: boolean;
  panelTools?: string[];
  mcpTools?: string[];
}
interface Agent {
  id: string; name: string; type: "local" | "remote";
  role?: string; systemPrompt?: string;
  apps?: string[]; skills?: string[];
  appConfigs?: Record<string, AppToolConfig>;
  model_provider?: string; model_name?: string;
  joinable?: boolean; avatar_url?: string; bio?: string;
  guardrails?: Guardrails;
  tool_permissions?: ToolPermissions;
}
interface SkillEntry { name: string; description?: string; requires?: string[]; allowedTools?: string[]; }


// ── DOM helpers ────────────────────────────────────────
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const $i = (id: string) => document.getElementById(id) as HTMLInputElement;
const $t = (id: string) => document.getElementById(id) as HTMLTextAreaElement;
const $s = (id: string) => document.getElementById(id) as HTMLSelectElement;
const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
const fmtNum = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

interface McpTool { serverId: string; serverName: string; name: string; qualifiedName: string; description: string; }
interface AppInfo {
  id: string; name: string; url?: string; iconUrl: string;
  commandKeys: string[];
  commandDescs: Record<string, string>;
  hasMcp: boolean;
}

// ── State ──────────────────────────────────────────────
let agentsCache: Agent[] = [];
let appsCache: AppInfo[] = [];
let mcpToolsCache: McpTool[] = [];
let skillsCache: SkillEntry[] = [];
let editingAgent: Agent | null = null;
let editingIsNew = false;
let currentUserId: string | null = null;

async function ensureCurrentUser(): Promise<void> {
  if (currentUserId) return;
  const r = await drop.authMe() as { id?: string; email?: string; error?: string };
  if (r && "id" in r && r.id) currentUserId = r.id;
}

function isHostOf(c: Cypher | null): boolean {
  if (!c || !c.owner_user_id || !currentUserId) return false;
  return c.owner_user_id === currentUserId;
}

// ─────────────────────────────────────────────────────
// Confirm modal
// ─────────────────────────────────────────────────────

let confirmResolve: ((v: boolean) => void) | null = null;

function showConfirm(opts: { title: string; subtitle?: string; message: string; actionLabel?: string }): Promise<boolean> {
  $("confirm-title").textContent = opts.title;
  $("confirm-subtitle").textContent = opts.subtitle || "";
  $("confirm-message").textContent = opts.message;
  $("confirm-action").textContent = opts.actionLabel || "Confirm";
  $("confirm-overlay").classList.remove("hidden");
  return new Promise((resolve) => { confirmResolve = resolve; });
}

function closeConfirm(result: boolean): void {
  $("confirm-overlay").classList.add("hidden");
  if (confirmResolve) { confirmResolve(result); confirmResolve = null; }
}

function showToast(msg: string, kind: "error" | "info" = "error"): void {
  let container = document.getElementById("drop-toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "drop-toast-container";
    container.style.cssText = "position:fixed;bottom:16px;right:16px;z-index:400;display:flex;flex-direction:column;gap:8px;pointer-events:none;";
    document.body.appendChild(container);
  }
  const el = document.createElement("div");
  el.style.cssText = `background:var(--toast-bg);border:1px solid ${kind === "error" ? "var(--red, #e53935)" : "var(--accent)"};border-radius:10px;padding:10px 14px;min-width:240px;max-width:380px;box-shadow:0 4px 20px var(--shadow);animation:toast-in 0.25s ease-out;pointer-events:auto;cursor:pointer;font-size:13px;color:var(--text);`;
  el.textContent = msg;
  el.addEventListener("click", () => el.remove());
  container.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.remove(); }, 4000);
}

// ─────────────────────────────────────────────────────
// View router
// ─────────────────────────────────────────────────────

type View = "browse" | "agents" | "mine" | "lobby" | "workspace";

function setView(view: View): void {
  document.querySelectorAll<HTMLElement>(".view").forEach((el) => {
    el.classList.toggle("hidden", el.id !== `view-${view}`);
  });
  document.querySelectorAll<HTMLElement>(".view-tab").forEach((el) => {
    el.classList.toggle("active", el.dataset.view === view);
  });
  document.querySelectorAll<HTMLElement>("[data-view-only]").forEach((el) => {
    el.classList.toggle("hidden", el.dataset.viewOnly !== view);
  });
  if (view === "agents") void loadAgents();
  if (view === "mine") void loadMine();
}

// ─────────────────────────────────────────────────────
// Browse view: cyphers + leaderboard
// ─────────────────────────────────────────────────────


const coverCache = new Map<string, string>();

function coverUrl(c: Cypher): string | null {
  if (!c.cover_image_sha256) return null;
  return coverCache.get(c.id) ?? null;
}

async function fetchCovers(cyphers: Cypher[]): Promise<void> {
  const need = cyphers.filter((c) => c.cover_image_sha256 && !coverCache.has(c.id));
  if (need.length === 0) return;
  await Promise.all(need.map(async (c) => {
    try {
      const r = await drop.cypherCoverGet(c.id) as { ok: boolean; data_base64?: string; content_type?: string };
      if (r.ok && r.data_base64) {
        coverCache.set(c.id, `data:${r.content_type || "image/png"};base64,${r.data_base64}`);
      }
    } catch { /* cover fetch failed silently */ }
  }));
}

function cssCoverGradient(title: string): string {
  const h = hashStr(title);
  const h1 = h % 360;
  const h2 = (h * 7 + 137) % 360;
  return `linear-gradient(135deg, hsl(${h1},80%,40%) 0%, hsl(${h2},70%,25%) 100%)`;
}

function cypherCard(c: Cypher): HTMLElement {
  const el = document.createElement("div");
  el.className = "cypher-card reveal";
  const jammers = c.jammer_count ?? c.jammers ?? 0;
  const isLive = c.status === "open" || c.status === "live" || c.status === "running";
  const isTerminal = c.status === "wrapped" || c.status === "cancelled";
  const isOwner = c.owner_user_id === currentUserId;
  const url = coverUrl(c);
  const posterStyle = url
    ? `background:url('${url}') center/cover no-repeat;`
    : `background:${cssCoverGradient(c.title || c.slug || "untitled")};`;
  const initial = (c.title || c.slug || "?").trim().charAt(0).toUpperCase();
  el.innerHTML = `
    <div class="cypher-poster" style="${posterStyle}">
      <span class="cypher-status-badge ${c.status || ""}">
        <span class="pulse"></span>${escapeHtml(c.status || "")}
      </span>
      ${isOwner && !isTerminal ? `<button class="cypher-cancel-btn" title="Cancel cypher"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></button>` : ""}
      ${isOwner && isTerminal ? `<button class="cypher-cancel-btn cypher-delete-btn" title="Delete cypher"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></button>` : ""}
      ${url ? "" : `<span class="glyph">${escapeHtml(initial)}</span>`}
    </div>
    <div class="cypher-meta">
      <div class="cypher-title">${escapeHtml(c.title || c.slug || "untitled")}</div>
      ${c.goal || c.description ? `<div class="cypher-desc">${escapeHtml(c.goal || c.description || "")}</div>` : ""}
      <div class="cypher-stats">
        <span>${escapeHtml(c.type || "open")}</span>
        <span><strong>${jammers}</strong> jammer${jammers === 1 ? "" : "s"}</span>
        <span class="cypher-stats-right">${(c.total_input_tokens || c.total_output_tokens) ? `<span class="cypher-tokens-stat">↓${fmtNum(c.total_input_tokens ?? 0)} ↑${fmtNum(c.total_output_tokens ?? 0)}</span>` : ""}</span>
      </div>
    </div>
  `;
  const cancelBtn = el.querySelector(".cypher-cancel-btn:not(.cypher-delete-btn)");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const confirmed = await showConfirm({
        title: "Cancel cypher",
        subtitle: c.title || c.slug || "",
        message: "This will cancel the cypher and remove all jammers. This cannot be undone.",
        actionLabel: "Cancel cypher",
      });
      if (!confirmed) return;
      const r = await drop.cypherCancel(c.id) as { ok?: boolean; error?: string };
      if (!r.ok) { showToast(r.error || "Cancel failed"); return; }
      void loadMine();
      void loadFeatured();
      void loadDirectory();
    });
  }
  const deleteBtn = el.querySelector(".cypher-delete-btn");
  if (deleteBtn) {
    deleteBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const confirmed = await showConfirm({
        title: "Delete cypher",
        subtitle: c.title || c.slug || "",
        message: "This will permanently delete this cypher and all its data. This cannot be undone.",
        actionLabel: "Delete",
      });
      if (!confirmed) return;
      const r = await drop.cypherDelete(c.id) as { ok?: boolean; error?: string };
      if (!r.ok) { showToast(r.error || "Delete failed"); return; }
      void loadMine();
      void loadFeatured();
      void loadDirectory();
    });
  }
  el.addEventListener("click", () => { enterLobby(c); });
  return el;
}

function leaderboardCard(e: LeaderboardEntry, rank: number): HTMLElement {
  const el = document.createElement("div");
  el.className = "agent-card reveal";
  const rankClass = rank === 1 ? "top-1" : rank === 2 ? "top-2" : rank === 3 ? "top-3" : "";
  const avatarHtml = e.avatar_url
    ? `<img src="${escapeHtml(e.avatar_url)}" alt="" />`
    : identiconSvg(e.agent_local_id, 64);
  const successPct = (e.success_rate * 100).toFixed(0);
  el.innerHTML = `
    <div class="agent-rank ${rankClass}">#${rank}</div>
    <div class="agent-avatar">${avatarHtml}</div>
    <div class="agent-name">${escapeHtml(e.name)}</div>
    <div class="agent-bio">${e.bio ? escapeHtml(e.bio) : (e.skills || []).slice(0, 3).join(" · ")}</div>
    <div class="agent-score">${e.score.toFixed(1)}</div>
    <div class="agent-substat">${e.tasks_completed} done · ${successPct}% success</div>
  `;
  return el;
}

// ── Carousel ──────────────────────────────────────────

let carouselIdx = 0;
let carouselCyphers: Cypher[] = [];

function renderCarousel(cyphers: Cypher[]): void {
  carouselCyphers = cyphers;
  carouselIdx = 0;
  const track = $("carousel-track");
  const dots = $("carousel-dots");
  track.innerHTML = "";
  dots.innerHTML = "";

  if (cyphers.length === 0) {
    $("carousel-wrap").classList.add("hidden");
    return;
  }
  $("carousel-wrap").classList.remove("hidden");

  for (const c of cyphers) {
    const slide = document.createElement("div");
    slide.className = "carousel-slide";
    const url = coverUrl(c);
    const bg = url ? `url('${url}')` : cssCoverGradient(c.title || "untitled");
    const jammers = c.jammer_count ?? c.jammers ?? 0;
    slide.innerHTML = `
      <div class="carousel-slide-bg" style="background:${bg};background-size:cover;background-position:center;"></div>
      <div class="carousel-slide-overlay"></div>
      <div class="carousel-slide-content">
        <span class="carousel-slide-tag"><span class="pulse"></span> ${escapeHtml(c.status || "live")}</span>
        <h2>${escapeHtml(c.title || c.slug || "Untitled")}</h2>
        <p>${escapeHtml((c.goal || c.description || "").slice(0, 160))}</p>
        <div class="carousel-slide-stats">
          <span>${escapeHtml(c.type || "open")}</span>
          <span><strong>${jammers}</strong> jammer${jammers === 1 ? "" : "s"}</span>
        </div>
      </div>
    `;
    slide.addEventListener("click", () => enterLobby(c));
    track.appendChild(slide);
  }

  for (let i = 0; i < cyphers.length; i++) {
    const dot = document.createElement("button");
    dot.className = "carousel-dot" + (i === 0 ? " active" : "");
    dot.addEventListener("click", () => goToSlide(i));
    dots.appendChild(dot);
  }

  updateCarouselPosition();
}

function goToSlide(idx: number): void {
  carouselIdx = Math.max(0, Math.min(idx, carouselCyphers.length - 1));
  updateCarouselPosition();
}

function updateCarouselPosition(): void {
  const track = $("carousel-track");
  track.style.transform = `translateX(-${carouselIdx * 100}%)`;
  document.querySelectorAll(".carousel-dot").forEach((dot, i) => {
    dot.classList.toggle("active", i === carouselIdx);
  });
}

// ── Directory (card/table view with search + filters) ─

const DIR_PAGE_SIZE = 24;
let dirPage = 0;
let dirTotalCount = 0;
let dirViewMode: "card" | "table" = "card";
let dirSearchTimer: ReturnType<typeof setTimeout> | null = null;

function dirFilters(): { status?: string; type?: string; q?: string } {
  const status = ($("dir-filter-status") as HTMLSelectElement).value || undefined;
  const type = ($("dir-filter-type") as HTMLSelectElement).value || undefined;
  const q = ($("dir-search") as HTMLInputElement).value.trim() || undefined;
  return { status, type, q };
}

async function loadDirectory(): Promise<void> {
  const filters = dirFilters();
  const r = await drop.cyphersDiscover({
    status: filters.status,
    type: filters.type,
    limit: DIR_PAGE_SIZE,
    offset: dirPage * DIR_PAGE_SIZE,
  }) as { cyphers?: Cypher[]; entries?: Cypher[]; count?: number; error?: string };

  let entries = (r?.cyphers ?? r?.entries ?? []);
  dirTotalCount = r?.count ?? entries.length;

  // Client-side text search (server may not support q yet)
  if (filters.q) {
    const q = filters.q.toLowerCase();
    entries = entries.filter((c) =>
      (c.title || "").toLowerCase().includes(q) ||
      (c.goal || "").toLowerCase().includes(q) ||
      (c.description || "").toLowerCase().includes(q) ||
      (c.slug || "").toLowerCase().includes(q)
    );
  }

  // Client-side sort
  const sort = ($("dir-sort") as HTMLSelectElement).value;
  if (sort === "jammers") entries.sort((a, b) => (b.jammers ?? 0) - (a.jammers ?? 0));
  else if (sort === "title") entries.sort((a, b) => (a.title || "").localeCompare(b.title || ""));

  renderDirectoryCards(entries);
  renderDirectoryTable(entries);
  renderDirPagination();

  const empty = $("dir-empty");
  const hasContent = entries.length > 0;
  empty.classList.toggle("hidden", hasContent);
  $("dir-cards").classList.toggle("hidden", !hasContent || dirViewMode !== "card");
  $("dir-table").classList.toggle("hidden", !hasContent || dirViewMode !== "table");

  // Fetch covers then re-render cards with images
  void fetchCovers(entries).then(() => { renderDirectoryCards(entries); renderDirectoryTable(entries); });
}

function renderDirectoryCards(entries: Cypher[]): void {
  const container = $("dir-cards");
  container.innerHTML = "";
  for (const c of entries) {
    container.appendChild(cypherCard(c));
  }
}

function renderDirectoryTable(entries: Cypher[]): void {
  const tbody = $("dir-table-body");
  tbody.innerHTML = "";
  for (const c of entries) {
    const tr = document.createElement("tr");
    const url = coverUrl(c);
    const bg = url ? `url('${url}')` : cssCoverGradient(c.title || "untitled");
    const statusClass = c.status === "live" || c.status === "open" ? "live" : c.status === "lobby" ? "lobby" : "wrapped";
    tr.innerHTML = `
      <td><div class="dir-table-cover" style="background:${bg};background-size:cover;background-position:center;"></div></td>
      <td style="font-weight:600;">${escapeHtml(c.title || c.slug || "untitled")}</td>
      <td><span style="font-family:var(--font-mono);font-size:11px;color:var(--text-3);">${escapeHtml(c.type || "open")}</span></td>
      <td><span class="dir-table-status ${statusClass}">${escapeHtml(c.status || "")}</span></td>
      <td style="font-family:var(--font-mono);">${c.jammer_count ?? c.jammers ?? 0}</td>
      <td style="font-family:var(--font-mono);font-size:11px;color:var(--text-3);">${c.lobby_started_at ? new Date(c.lobby_started_at).toLocaleDateString() : "—"}</td>
    `;
    tr.addEventListener("click", () => enterLobby(c));
    tbody.appendChild(tr);
  }
}

function renderDirPagination(): void {
  const totalPages = Math.max(1, Math.ceil(dirTotalCount / DIR_PAGE_SIZE));
  $("dir-page-info").textContent = `Page ${dirPage + 1} of ${totalPages}`;
  ($("dir-prev-page") as HTMLButtonElement).disabled = dirPage === 0;
  ($("dir-next-page") as HTMLButtonElement).disabled = dirPage >= totalPages - 1;
}

function setDirView(mode: "card" | "table"): void {
  dirViewMode = mode;
  $("dir-view-card").classList.toggle("active", mode === "card");
  $("dir-view-table").classList.toggle("active", mode === "table");
  // Re-render visibility
  const hasCards = $("dir-cards").children.length > 0;
  $("dir-cards").classList.toggle("hidden", !hasCards || mode !== "card");
  $("dir-table").classList.toggle("hidden", !hasCards || mode !== "table");
}

function fillRow(rowId: string, emptyId: string, items: HTMLElement[]): void {
  const row = $(rowId);
  const empty = $(emptyId);
  row.innerHTML = "";
  if (items.length === 0) {
    empty.classList.remove("hidden");
    row.style.display = "none";
  } else {
    empty.classList.add("hidden");
    row.style.display = "";
    items.forEach((el, i) => {
      el.style.animationDelay = `${Math.min(i, 12) * 0.04}s`;
      row.appendChild(el);
    });
  }
}

async function loadFeatured(): Promise<void> {
  const [discR, mineR] = await Promise.all([
    drop.cyphersDiscover({ status: "open", limit: 8 }) as Promise<{ cyphers?: Cypher[]; entries?: Cypher[]; error?: string }>,
    drop.cyphersMine() as Promise<{ cyphers?: Cypher[]; error?: string }>,
  ]);
  const disc = discR?.cyphers ?? discR?.entries ?? [];
  const mine = (mineR?.cyphers ?? [])
    .filter((c) => c.status === "lobby" || c.status === "live");
  const seen = new Set<string>();
  const merged: Cypher[] = [];
  for (const c of [...disc, ...mine]) {
    if (!seen.has(c.id)) { seen.add(c.id); merged.push(c); }
  }
  const featured = merged.sort((a, b) => (b.jammer_count ?? b.jammers ?? 0) - (a.jammer_count ?? a.jammers ?? 0)).slice(0, 5);
  renderCarousel(featured);
  // Fetch covers async then re-render carousel with images
  void fetchCovers(featured).then(() => renderCarousel(featured));
}

async function loadSidebar(): Promise<void> {
  try {
    const [cyphersR, jammersR] = await Promise.all([
      drop.leaderboardTopCyphers(10) as Promise<{ data?: { id: string; title: string; total_input_tokens: number; total_output_tokens: number }[]; error?: string }>,
      drop.leaderboardTopJammers(10) as Promise<{ data?: { user_id: string; agent_local_id: string; input_tokens: number; output_tokens: number }[]; error?: string }>,
    ]);
    const cyphers = cyphersR?.data ?? [];
    const jammers = jammersR?.data ?? [];

    const cEl = $("sidebar-top-cyphers");
    if (cyphers.length === 0) {
      cEl.innerHTML = `<span style="font-size:12px;color:var(--text-3);">No data yet</span>`;
    } else {
      cEl.innerHTML = cyphers.map((c, i) => `
        <div class="sidebar-item">
          <span class="sidebar-rank">${i + 1}</span>
          <span class="sidebar-name">${escapeHtml(c.title)}</span>
          <span class="sidebar-tokens">${fmtNum(c.total_input_tokens + c.total_output_tokens)}</span>
        </div>`).join("");
    }

    const jEl = $("sidebar-top-jammers");
    if (jammers.length === 0) {
      jEl.innerHTML = `<span style="font-size:12px;color:var(--text-3);">No data yet</span>`;
    } else {
      jEl.innerHTML = jammers.map((j, i) => `
        <div class="sidebar-item">
          <span class="sidebar-rank">${i + 1}</span>
          <span class="sidebar-name">${escapeHtml(j.agent_local_id)}</span>
          <span class="sidebar-tokens">${fmtNum(j.input_tokens + j.output_tokens)}</span>
        </div>`).join("");
    }
  } catch { /* sidebar is non-critical */ }
}

async function loadMine(): Promise<void> {
  const r = await drop.cyphersMine() as { cyphers?: Cypher[]; error?: string };
  const entries = (r && "cyphers" in r ? r.cyphers : []) ?? [];
  const grid = $("mine-grid");
  const empty = $("mine-empty");
  grid.innerHTML = "";
  if (entries.length === 0) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  for (const c of entries) {
    grid.appendChild(cypherCard(c));
  }
  // Fetch covers then re-render
  void fetchCovers(entries).then(() => {
    grid.innerHTML = "";
    for (const c of entries) grid.appendChild(cypherCard(c));
  });
}

// ─────────────────────────────────────────────────────
// Your Agents view
// ─────────────────────────────────────────────────────

async function ensureAppsLoaded(): Promise<void> {
  if (appsCache.length > 0) return;
  try {
    const [raw, mcpTools] = await Promise.all([drop.appsList(), drop.mcpToolsList()]);
    mcpToolsCache = mcpTools;
    appsCache = raw.map((a) => {
      const cmds = a.commands ?? {};
      return {
        id: a.id,
        name: a.name,
        url: a.url,
        iconUrl: a.url
          ? `https://www.google.com/s2/favicons?domain=${new URL(a.url).hostname}&sz=32`
          : "",
        commandKeys: Object.keys(cmds),
        commandDescs: Object.fromEntries(Object.entries(cmds).map(([k, v]) => [k, v.description])),
        hasMcp: !!(a.mcp?.enabled),
      };
    });
  } catch { appsCache = []; mcpToolsCache = []; }
}

function rosterCard(a: Agent): HTMLElement {
  const el = document.createElement("div");
  el.className = "roster-card reveal";
  const avatarHtml = a.avatar_url
    ? `<img src="${escapeHtml(a.avatar_url)}" alt="" />`
    : identiconSvg(a.id, 48);
  const skills = (a.skills ?? []).slice(0, 4);
  const tagsHtml = [
    a.joinable ? `<span class="roster-tag live">joinable</span>` : "",
    ...skills.map((s) => `<span class="roster-tag">${escapeHtml(s)}</span>`),
  ].filter(Boolean).join("");

  const agentApps = (a.apps ?? []).slice(0, 6);
  const appIconsHtml = agentApps.map((appId) => {
    const app = appsCache.find((c) => c.id === appId);
    if (!app?.iconUrl) return `<span class="roster-app-icon" title="${escapeHtml(appId)}">${escapeHtml(appId.charAt(0).toUpperCase())}</span>`;
    return `<img class="roster-app-icon" src="${escapeHtml(app.iconUrl)}" alt="${escapeHtml(app.name)}" title="${escapeHtml(app.name)}" onerror="this.outerHTML='<span class=\\'roster-app-icon\\'>${escapeHtml(app.name.charAt(0).toUpperCase())}</span>'" />`;
  }).join("");

  el.innerHTML = `
    <div class="roster-head">
      <div class="roster-avatar">${avatarHtml}</div>
      <div class="roster-meta">
        <div class="roster-name">${escapeHtml(a.name || a.id)}</div>
        <div class="roster-id">${escapeHtml(a.id)}${a.role ? ` · ${escapeHtml(a.role)}` : ""}</div>
      </div>
    </div>
    <div class="roster-bio">${a.bio ? escapeHtml(a.bio) : `<span style="color:var(--text-3);">No bio</span>`}</div>
    ${appIconsHtml ? `<div class="roster-apps">${appIconsHtml}</div>` : ""}
    <div class="roster-tags">${tagsHtml}</div>
  `;
  el.addEventListener("click", () => openEdit(a));
  return el;
}

async function loadAgents(): Promise<void> {
  const [r] = await Promise.all([
    drop.agentsList() as Promise<Agent[] | { error?: string }>,
    ensureAppsLoaded(),
  ]);
  agentsCache = Array.isArray(r) ? r : [];
  const grid = $("agents-grid");
  const empty = $("agents-empty");
  grid.innerHTML = "";
  if (agentsCache.length === 0) {
    empty.classList.remove("hidden");
    grid.style.display = "none";
  } else {
    empty.classList.add("hidden");
    grid.style.display = "";
    agentsCache.forEach((a, i) => {
      const card = rosterCard(a);
      card.style.animationDelay = `${Math.min(i, 12) * 0.03}s`;
      grid.appendChild(card);
    });
  }
}

// ─────────────────────────────────────────────────────
// Edit overlay
// ─────────────────────────────────────────────────────

function renderEditAvatar(id: string, url?: string): void {
  const el = $("ae-avatar");
  if (url) {
    el.innerHTML = `<img src="${escapeHtml(url)}" alt="" />`;
  } else {
    el.innerHTML = identiconSvg(id || "new-agent", 56);
  }
}

const SDK_MODELS: { value: string; label: string; hint: string }[] = [
  { value: "anthropic::claude-sonnet-4-20250514", label: "Claude Code — Sonnet", hint: "Balanced speed + capability" },
  { value: "anthropic::claude-opus-4-20250514", label: "Claude Code — Opus", hint: "Strongest reasoning" },
  { value: "anthropic::claude-haiku-4-20250514", label: "Claude Code — Haiku", hint: "Fast + lightweight" },
];

function ensureModelsLoaded(): void { /* static list, nothing to load */ }

function populateModelSelector(provider?: string, model?: string): void {
  const sel = $s("ae-model");
  sel.innerHTML = "";
  for (const m of SDK_MODELS) {
    const opt = document.createElement("option");
    opt.value = m.value;
    opt.textContent = m.label;
    sel.appendChild(opt);
  }
  const cur = provider && model ? `${provider}::${model}` : "";
  sel.value = cur || SDK_MODELS[0].value;
  updateModelCostHint();
  sel.onchange = () => updateModelCostHint();
}

function updateModelCostHint(): void {
  const sel = $s("ae-model");
  const hint = $("ae-model-cost");
  const m = SDK_MODELS.find((x) => x.value === sel.value);
  hint.textContent = m ? m.hint : "";
}

// ── Avatar generation ────────────────────────────────────

async function generateAvatar(): Promise<void> {
  if (!editingAgent) return;
  const btn = $("ae-avatar-gen") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Generating…";

  try {
    const r = await drop.agentAvatarGenerate({
      name: $i("ae-name").value.trim() || editingAgent.id || "Agent",
      role: $i("ae-role").value.trim() || undefined,
      bio: $t("ae-bio").value.trim() || undefined,
    });
    if (!r.ok) {
      showError(r.error);
      return;
    }
    const dataUrl = `data:${r.content_type};base64,${r.data_base64}`;
    $i("ae-avatar-url").value = dataUrl;
    editingAgent.avatar_url = dataUrl;
    renderEditAvatar(editingAgent.id, dataUrl);
  } catch (e) {
    showError(e instanceof Error ? e.message : "Generation failed");
  } finally {
    btn.disabled = false;
    btn.textContent = "Generate";
  }
}

// ── Apps tab for jammer editor ──────────────────────────

function getMcpToolsForApp(appId: string): McpTool[] {
  return mcpToolsCache.filter((t) => t.serverId === appId);
}

function getAppConfig(appId: string): AppToolConfig {
  return editingAgent?.appConfigs?.[appId] ?? {};
}

function setAppConfig(appId: string, cfg: AppToolConfig): void {
  if (!editingAgent) return;
  if (!editingAgent.appConfigs) editingAgent.appConfigs = {};
  editingAgent.appConfigs[appId] = cfg;
  // keep flat apps list in sync
  editingAgent.apps = Object.keys(editingAgent.appConfigs);
}

function removeAppConfig(appId: string): void {
  if (!editingAgent) return;
  if (editingAgent.appConfigs) delete editingAgent.appConfigs[appId];
  editingAgent.apps = (editingAgent.apps || []).filter((a) => a !== appId);
}

function renderAppsTab(filter?: string): void {
  if (!editingAgent) return;
  const list = $("ae-apps-list");
  list.innerHTML = "";
  const enabled = new Set(editingAgent.apps || []);

  if (appsCache.length === 0) {
    list.innerHTML = `<span style="font-size:12px;color:var(--text-3);">No apps configured. Add apps in Home → Apps.</span>`;
    return;
  }

  const lowerFilter = (filter || "").toLowerCase();
  const filtered = lowerFilter
    ? appsCache.filter((a) => a.name.toLowerCase().includes(lowerFilter) || a.id.toLowerCase().includes(lowerFilter))
    : appsCache;

  for (const app of filtered) {
    const isEnabled = enabled.has(app.id);
    const cfg = getAppConfig(app.id);
    const mcpTools = getMcpToolsForApp(app.id);
    const card = document.createElement("div");
    card.className = `ae-app-card${isEnabled ? " enabled" : ""}`;

    const iconHtml = app.iconUrl
      ? `<img src="${escapeHtml(app.iconUrl)}" class="ae-app-icon" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" /><span class="ae-app-icon ae-app-initial" style="display:none">${escapeHtml(app.name.charAt(0).toUpperCase())}</span>`
      : `<span class="ae-app-icon ae-app-initial">${escapeHtml(app.name.charAt(0).toUpperCase())}</span>`;

    const toolCount = app.commandKeys.length + mcpTools.length;

    card.innerHTML = `
      <div class="ae-app-card-head">
        <input type="checkbox" ${isEnabled ? "checked" : ""} style="accent-color:var(--accent);flex-shrink:0;" />
        ${iconHtml}
        <span class="ae-app-card-name">${escapeHtml(app.name)}</span>
        <span class="ae-app-card-id">${escapeHtml(app.id)}</span>
        <span class="ae-app-card-chevron">▸</span>
      </div>
      <div class="ae-app-card-body"></div>
    `;

    const checkbox = card.querySelector("input")!;
    const head = card.querySelector(".ae-app-card-head")!;
    const body = card.querySelector(".ae-app-card-body")!;

    checkbox.addEventListener("change", (e) => {
      e.stopPropagation();
      if (checkbox.checked) {
        setAppConfig(app.id, { allowAll: true });
        card.classList.add("enabled");
      } else {
        removeAppConfig(app.id);
        card.classList.remove("enabled");
      }
      renderAppCardBody(body as HTMLElement, app, mcpTools);
    });

    head.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      card.classList.toggle("expanded");
      if (card.classList.contains("expanded")) {
        renderAppCardBody(body as HTMLElement, app, mcpTools);
      }
    });

    list.appendChild(card);
  }
}

function renderAppCardBody(body: HTMLElement, app: AppInfo, mcpTools: McpTool[]): void {
  if (!editingAgent) return;
  const cfg = getAppConfig(app.id);
  const isEnabled = (editingAgent.apps || []).includes(app.id);
  body.innerHTML = "";

  if (!isEnabled) {
    body.innerHTML = `<p style="font-size:11px;color:var(--text-3);padding:8px 0;">Enable this app to configure tools.</p>`;
    return;
  }

  const allowAll = cfg.allowAll !== false;

  // Allow all toggle
  const allowAllLabel = document.createElement("label");
  allowAllLabel.className = "ae-app-allow-all";
  allowAllLabel.innerHTML = `
    <input type="checkbox" ${allowAll ? "checked" : ""} style="accent-color:var(--accent);flex-shrink:0;" />
    <span>Allow all tools</span>
  `;
  const allowAllCb = allowAllLabel.querySelector("input")!;
  allowAllCb.addEventListener("change", () => {
    const c = getAppConfig(app.id);
    if (allowAllCb.checked) {
      setAppConfig(app.id, { allowAll: true });
    } else {
      setAppConfig(app.id, { allowAll: false, panelTools: [...app.commandKeys], mcpTools: mcpTools.map((t) => t.name) });
    }
    renderAppCardBody(body, app, mcpTools);
  });
  body.appendChild(allowAllLabel);

  // Panel tools section
  if (app.commandKeys.length > 0) {
    const section = document.createElement("div");
    section.className = "ae-app-tool-section";
    section.innerHTML = `<div class="ae-app-tool-heading">Panel tools</div>`;
    const toolList = document.createElement("div");
    toolList.className = "ae-app-tool-list";

    const selectedPanelTools = new Set(allowAll ? app.commandKeys : (cfg.panelTools ?? []));
    for (const key of app.commandKeys) {
      const row = document.createElement("label");
      row.className = "ae-app-tool-row";
      row.innerHTML = `
        <input type="checkbox" ${selectedPanelTools.has(key) ? "checked" : ""} ${allowAll ? "disabled" : ""} style="accent-color:var(--accent);flex-shrink:0;" />
        <span class="ae-app-tool-name">${escapeHtml(key)}</span>
        <span class="ae-app-tool-desc">${escapeHtml(app.commandDescs[key] || "")}</span>
      `;
      if (!allowAll) {
        const cb = row.querySelector("input")!;
        cb.addEventListener("change", () => {
          const c = getAppConfig(app.id);
          const set = new Set(c.panelTools ?? []);
          if (cb.checked) set.add(key); else set.delete(key);
          setAppConfig(app.id, { ...c, panelTools: [...set] });
        });
      }
      toolList.appendChild(row);
    }
    section.appendChild(toolList);
    body.appendChild(section);
  }

  // MCP tools section
  if (mcpTools.length > 0) {
    const section = document.createElement("div");
    section.className = "ae-app-tool-section";
    section.innerHTML = `<div class="ae-app-tool-heading">MCP tools</div>`;
    const toolList = document.createElement("div");
    toolList.className = "ae-app-tool-list";

    const selectedMcpTools = new Set(allowAll ? mcpTools.map((t) => t.name) : (cfg.mcpTools ?? []));
    for (const tool of mcpTools) {
      const row = document.createElement("label");
      row.className = "ae-app-tool-row";
      row.innerHTML = `
        <input type="checkbox" ${selectedMcpTools.has(tool.name) ? "checked" : ""} ${allowAll ? "disabled" : ""} style="accent-color:var(--accent);flex-shrink:0;" />
        <span class="ae-app-tool-name">${escapeHtml(tool.name)}</span>
        <span class="ae-app-tool-desc">${escapeHtml(tool.description)}</span>
      `;
      if (!allowAll) {
        const cb = row.querySelector("input")!;
        cb.addEventListener("change", () => {
          const c = getAppConfig(app.id);
          const set = new Set(c.mcpTools ?? []);
          if (cb.checked) set.add(tool.name); else set.delete(tool.name);
          setAppConfig(app.id, { ...c, mcpTools: [...set] });
        });
      }
      toolList.appendChild(row);
    }
    section.appendChild(toolList);
    body.appendChild(section);
  }

  if (app.commandKeys.length === 0 && mcpTools.length === 0) {
    body.innerHTML += `<p style="font-size:11px;color:var(--text-3);padding:4px 0;">No tools configured for this app.</p>`;
  }
}

// ── Skills picker for jammer editor ───────────────────────

async function ensureSkillsLoaded(): Promise<void> {
  if (skillsCache.length > 0) return;
  try {
    const detailed = await drop.skillsListDetailed();
    skillsCache = (detailed ?? []).map((s) => ({
      name: s.name,
      description: s.description,
      requires: s.requires,
      allowedTools: s.allowedTools,
    }));
  } catch { skillsCache = []; }
}

function renderSkillzTab(): void {
  if (!editingAgent) return;
  const list = $("ae-skills-list");
  list.innerHTML = "";
  const enabled = new Set(editingAgent.skills || []);
  const enabledApps = new Set(editingAgent.apps || []);

  if (skillsCache.length === 0) {
    list.innerHTML = `<span style="font-size:12px;color:var(--text-3);">No skills available</span>`;
    return;
  }

  for (const sk of skillsCache) {
    const checked = enabled.has(sk.name);
    const card = document.createElement("label");
    card.className = `ae-skill-card${checked ? " enabled" : ""}`;

    const deps = sk.requires || [];
    const depsHtml = deps.length > 0
      ? `<div class="ae-skill-deps">
          <span style="font-size:10px;color:var(--text-3);">needs:</span>
          ${deps.map((d) => {
            const missing = !enabledApps.has(d);
            return `<span class="ae-skill-dep${missing ? " missing" : ""}" title="${missing ? "Not enabled in Apps tab" : "Enabled"}">${escapeHtml(d)}</span>`;
          }).join("")}
        </div>`
      : "";

    card.innerHTML = `
      <input type="checkbox" ${checked ? "checked" : ""} style="accent-color:var(--accent);flex-shrink:0;margin-top:2px;" />
      <div class="ae-skill-meta">
        <div class="ae-skill-name">${escapeHtml(sk.name)}</div>
        ${sk.description ? `<div class="ae-skill-desc">${escapeHtml(sk.description)}</div>` : ""}
        ${depsHtml}
      </div>
    `;
    const checkbox = card.querySelector("input")!;
    checkbox.addEventListener("change", () => {
      const cur = new Set(editingAgent!.skills || []);
      if (checkbox.checked) cur.add(sk.name); else cur.delete(sk.name);
      editingAgent!.skills = [...cur];
      card.classList.toggle("enabled", checkbox.checked);
    });
    list.appendChild(card);
  }
}

async function showSkillsAddPicker(): Promise<void> {
  skillsCache = [];
  await ensureSkillsLoaded();
  renderSkillzTab();
}

function fmtGrVal(id: string, val: number): string {
  if (val === 0) return "off";
  if (id === "ae-gr-idle") {
    if (val >= 60) return `${Math.round(val / 60)}m`;
    return `${val}s`;
  }
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`;
  if (val >= 1_000) return `${Math.round(val / 1_000)}k`;
  return String(val);
}

function updateGrDisplay(id: string): void {
  const slider = $i(id);
  const val = parseInt(slider.value, 10);
  const display = $(`${id}-val`);
  if (display) display.textContent = fmtGrVal(id, val);
}

type EditTab = "profile" | "apps" | "skillz" | "behavior" | "guardrails";
function setEditTab(tab: EditTab): void {
  document.querySelectorAll<HTMLElement>(".overlay-tab").forEach((el) => {
    el.classList.toggle("active", el.dataset.aeTab === tab);
  });
  document.querySelectorAll<HTMLElement>(".overlay-pane").forEach((el) => {
    el.classList.toggle("hidden", el.dataset.aePane !== tab);
  });
}

function clearError(): void {
  const e = $("ae-error");
  e.classList.add("hidden");
  e.textContent = "";
}
function showError(msg: string): void {
  const e = $("ae-error");
  e.textContent = msg;
  e.classList.remove("hidden");
}

async function openEdit(a: Agent | null): Promise<void> {
  ensureModelsLoaded();
  await Promise.all([ensureSkillsLoaded(), ensureAppsLoaded()]);
  editingIsNew = !a;
  editingAgent = a ? { ...a, appConfigs: a.appConfigs ? JSON.parse(JSON.stringify(a.appConfigs)) : undefined } : { id: "", name: "", type: "local" };

  $i("ae-id").value = editingAgent.id;
  $i("ae-apps-search").value = "";
  $i("ae-id").readOnly = !editingIsNew;
  $i("ae-name").value = editingAgent.name;
  $i("ae-avatar-url").value = editingAgent.avatar_url ?? "";
  $t("ae-bio").value = editingAgent.bio ?? "";
  $i("ae-joinable").checked = !!editingAgent.joinable;
  $i("ae-role").value = editingAgent.role ?? "";
  $t("ae-prompt").value = editingAgent.systemPrompt ?? "";

  $("ae-heading-name").textContent = editingAgent.name || "New jammer";
  $("ae-heading-id").textContent = editingAgent.id || "";
  renderEditAvatar(editingAgent.id, editingAgent.avatar_url);
  populateModelSelector(editingAgent.model_provider, editingAgent.model_name);
  renderAppsTab();
  renderSkillzTab();

  // Tool permissions
  const tp = editingAgent.tool_permissions ?? {};
  $s("ae-tp-shell").value = tp.shell ?? "full";
  $s("ae-tp-file_system").value = tp.file_system ?? "full";
  $s("ae-tp-git").value = tp.git ?? "full";
  $s("ae-tp-browser").value = tp.browser ?? "full";
  $s("ae-tp-mcp").value = tp.mcp ?? "full";

  // Guardrails tab — sliders (0 = unlimited/off)
  const gr = editingAgent.guardrails ?? {};
  $i("ae-gr-input-per-turn").value = String(gr.max_input_tokens_per_turn ?? 0);
  $i("ae-gr-output-per-turn").value = String(gr.max_output_tokens_per_turn ?? 0);
  $i("ae-gr-tokens-session").value = String(gr.max_tokens_per_session ?? 0);
  $i("ae-gr-max-turns").value = String(gr.max_turns ?? 0);
  $i("ae-gr-rpm").value = String(gr.rate_limit_rpm ?? 0);
  $i("ae-gr-idle").value = String(gr.auto_stop_idle_seconds ?? 0);
  ["ae-gr-input-per-turn","ae-gr-output-per-turn","ae-gr-tokens-session","ae-gr-max-turns","ae-gr-rpm","ae-gr-idle"].forEach(updateGrDisplay);

  $("ae-delete").classList.toggle("hidden", editingIsNew);
  setEditTab("profile");
  clearError();

  $("agent-overlay").classList.remove("hidden");
}

function closeEdit(): void {
  $("agent-overlay").classList.add("hidden");
  editingAgent = null;
  editingIsNew = false;
}

async function saveEdit(): Promise<void> {
  if (!editingAgent) return;
  clearError();

  const id = $i("ae-id").value.trim();
  const name = $i("ae-name").value.trim();
  if (!id) { showError("ID is required"); setEditTab("profile"); return; }
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) {
    showError("ID: letters, digits, _ or - (must start with letter/digit)");
    setEditTab("profile"); return;
  }
  if (editingIsNew) {
    const avail = await drop.agentsIdAvailable(id) as boolean;
    if (!avail) { showError(`ID "${id}" is already in use`); setEditTab("profile"); return; }
  }

  const modelVal = $s("ae-model").value;
  const [modelProvider, modelName] = modelVal ? modelVal.split("::") : [undefined, undefined];

  const grN = (id: string) => { const v = parseInt($i(id).value, 10); return v > 0 ? v : undefined; };
  const guardrails: Guardrails = {};
  const grInput = grN("ae-gr-input-per-turn"); if (grInput) guardrails.max_input_tokens_per_turn = grInput;
  const grOutput = grN("ae-gr-output-per-turn"); if (grOutput) guardrails.max_output_tokens_per_turn = grOutput;
  const grSession = grN("ae-gr-tokens-session"); if (grSession) guardrails.max_tokens_per_session = grSession;
  const grTurns = grN("ae-gr-max-turns"); if (grTurns) guardrails.max_turns = grTurns;
  const grRpm = grN("ae-gr-rpm"); if (grRpm) guardrails.rate_limit_rpm = grRpm;
  const grIdle = grN("ae-gr-idle"); if (grIdle) guardrails.auto_stop_idle_seconds = grIdle;

  const tool_permissions: ToolPermissions = {
    shell: $s("ae-tp-shell").value as ToolPerm,
    file_system: $s("ae-tp-file_system").value as ToolPerm,
    git: $s("ae-tp-git").value as ToolPerm,
    browser: $s("ae-tp-browser").value as ToolPerm,
    mcp: $s("ae-tp-mcp").value as ToolPerm,
  };
  const allFull = Object.values(tool_permissions).every((v) => v === "full");

  const cfg: Agent = {
    ...editingAgent,
    id,
    name: name || id,
    role: $i("ae-role").value.trim() || undefined,
    systemPrompt: $t("ae-prompt").value || undefined,
    avatar_url: $i("ae-avatar-url").value.trim() || undefined,
    bio: $t("ae-bio").value.trim() || undefined,
    joinable: $i("ae-joinable").checked,
    model_provider: modelProvider,
    model_name: modelName,
    apps: editingAgent.apps || [],
    appConfigs: editingAgent.appConfigs && Object.keys(editingAgent.appConfigs).length > 0
      ? editingAgent.appConfigs : undefined,
    skills: editingAgent.skills || [],
    guardrails: Object.keys(guardrails).length > 0 ? guardrails : undefined,
    tool_permissions: allFull ? undefined : tool_permissions,
  };

  try {
    await drop.agentsSave(cfg);
    closeEdit();
    void loadAgents();
  } catch (err) {
    showError(err instanceof Error ? err.message : "save failed");
  }
}

async function deleteEdit(): Promise<void> {
  if (!editingAgent || editingIsNew) return;
  const ok = await showConfirm({
    title: "Delete jammer",
    subtitle: editingAgent.name || editingAgent.id,
    message: "This will permanently remove this jammer from your roster.",
    actionLabel: "Delete",
  });
  if (!ok) return;
  try {
    await drop.agentsRemove(editingAgent.id);
    closeEdit();
    void loadAgents();
  } catch (err) {
    showError(err instanceof Error ? err.message : "delete failed");
  }
}

// ─────────────────────────────────────────────────────
// Cypher creation wizard
// ─────────────────────────────────────────────────────

type WizardStep = 1 | 2 | 3 | 4 | 5 | 6;
const wizard = {
  step: 1 as WizardStep,
  vibe: "open" as "open" | "coop" | "bounty" | "sponsored",
  visibility: "public" as "public" | "unlisted" | "invite",
  wpMode: "blank" as "blank" | "git",
  seedAgentIds: new Set<string>(),
  coverMode: "css" as "css" | "generate" | "upload",
  coverDataB64: null as string | null,
  coverContentType: "image/png" as string,
  coverPrompt: "",
  // Repo step state
  selectedOwner: null as string | null,
  selectedOwnerKind: "user" as "user" | "organization",
  installationId: null as number | null,
  selectedRepoFullName: null as string | null,
  autoCreateRepo: false,
  newRepoName: "",
  repoPrivate: true,
};

function setWizardStep(n: WizardStep): void {
  wizard.step = n;
  document.querySelectorAll<HTMLElement>("[data-cw-step]").forEach((el) => {
    el.classList.toggle("hidden", el.dataset.cwStep !== String(n));
  });
  const labels = ["Goal", "Cover Art", "Work Package", "Project Board", "Seed Roster", "Lobby"];
  $("cw-step-label").textContent = `Step ${n} of 6 — ${labels[n - 1]}`;
  $("cw-back").classList.toggle("hidden", n === 1);
  const nextBtn = $("cw-next") as HTMLButtonElement;
  nextBtn.classList.toggle("hidden", n === 6);
  nextBtn.textContent = "Next";
  nextBtn.disabled = false;
  $("cw-publish").classList.toggle("hidden", n !== 6);
  if (n === 5) renderSeedList();
  if (n === 2) initCoverStep();
  if (n === 4) void loadRepoStep();
}

function setWpMode(mode: "blank" | "git"): void {
  wizard.wpMode = mode;
  setChip("cw-wp-mode", mode);
  $("cw-wp-git-fields").classList.toggle("hidden", mode !== "git");
}

interface SetupStepWire {
  kind: "git_clone" | "git_branch" | "r2_download" | "unzip" | "read";
  [k: string]: unknown;
}

function buildSetupSteps(): SetupStepWire[] {
  if (wizard.wpMode === "blank") return [];
  const steps: SetupStepWire[] = [];
  const url = $i("cw-wp-git-url").value.trim();
  if (!url) return [];
  const branch = $i("cw-wp-git-branch").value.trim() || undefined;
  steps.push({ kind: "git_clone", url, branch, into: "." });
  if ($i("cw-wp-create-branch").checked) {
    const rawName = $i("cw-wp-branch-name").value.trim() || "cypher-{{short_id}}";
    steps.push({ kind: "git_branch", name: rawName });
  }
  const readPath = $i("cw-wp-read-path").value.trim();
  if (readPath) {
    steps.push({ kind: "read", path: readPath, into_prompt: true });
  }
  return steps;
}

// ── Cover Art step helpers ─────────────────────────────

function initCoverStep(): void {
  setCoverMode(wizard.coverMode);
  updateCoverPreview();
}

function setCoverMode(mode: "css" | "generate" | "upload"): void {
  wizard.coverMode = mode;
  setChip("cw-cover-mode", mode);
  $("cw-cover-generate-fields").classList.toggle("hidden", mode !== "generate");
  $("cw-cover-upload-fields").classList.toggle("hidden", mode !== "upload");
  $("cw-cover-css-fields").classList.toggle("hidden", mode !== "css");
}

function updateCoverPreview(): void {
  const preview = $("cw-cover-preview") as HTMLDivElement;
  if (wizard.coverDataB64) {
    preview.innerHTML = `<img src="data:${wizard.coverContentType};base64,${wizard.coverDataB64}" alt="Cover preview" style="width:100%;height:100%;object-fit:cover;border-radius:10px;" />`;
  } else {
    const title = $i("cw-title").value.trim() || "Untitled";
    const hash = hashStr(title);
    const hue1 = hash % 360;
    const hue2 = (hash * 7 + 137) % 360;
    preview.innerHTML = `<div style="width:100%;height:100%;border-radius:10px;background:linear-gradient(135deg, hsl(${hue1},70%,25%) 0%, hsl(${hue2},60%,15%) 100%);display:flex;align-items:center;justify-content:center;font-family:var(--font-mono);font-size:28px;font-weight:800;color:rgba(255,255,255,0.15);letter-spacing:-0.02em;">${escapeHtml(title)}</div>`;
  }
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

async function generateCoverImage(): Promise<void> {
  const btn = $("cw-cover-gen-btn") as HTMLButtonElement;
  const err = $("cw-cover-gen-error") as HTMLDivElement;
  err.classList.add("hidden");
  btn.disabled = true;
  btn.textContent = "Generating…";

  try {
    const title = $i("cw-title").value.trim() || "Untitled Cypher";
    const goal = $t("cw-goal").value.trim() || undefined;
    const customPrompt = $t("cw-cover-prompt").value.trim() || undefined;

    const r = await drop.cypherCoverGenerate({
      title,
      goal,
      vibe: wizard.vibe,
      customPrompt,
    });

    if (!r.ok) {
      err.textContent = r.error;
      err.classList.remove("hidden");
      return;
    }

    wizard.coverDataB64 = r.data_base64;
    wizard.coverContentType = r.content_type;
    wizard.coverPrompt = r.prompt_used;
    $t("cw-cover-prompt").value = r.prompt_used;
    updateCoverPreview();
  } catch (e) {
    err.textContent = e instanceof Error ? e.message : "Generation failed";
    err.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = "Generate";
  }
}

function handleCoverUpload(file: File): void {
  if (!file.type.startsWith("image/")) return;
  if (file.size > 10 * 1024 * 1024) {
    ($("cw-cover-upload-error") as HTMLDivElement).textContent = "Max 10MB";
    ($("cw-cover-upload-error") as HTMLDivElement).classList.remove("hidden");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const b64 = (reader.result as string).split(",")[1];
    wizard.coverDataB64 = b64;
    wizard.coverContentType = file.type;
    updateCoverPreview();
  };
  reader.readAsDataURL(file);
}

function setChip(groupId: string, value: string): void {
  document.querySelectorAll<HTMLElement>(`#${groupId} .chip`).forEach((el) => {
    el.classList.toggle("active", el.dataset.chip === value);
  });
}

function renderSeedList(filter?: string): void {
  const list = $("cw-seed-list");
  const empty = $("cw-seed-empty");
  list.innerHTML = "";
  if (agentsCache.length === 0) {
    empty.classList.remove("hidden");
    list.style.display = "none";
    return;
  }

  let agents = agentsCache;
  if (filter) {
    const q = filter.toLowerCase();
    agents = agents.filter((a) =>
      a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q) || (a.role || "").toLowerCase().includes(q)
    );
  }

  if (agents.length === 0) {
    empty.classList.remove("hidden");
    empty.textContent = "No matching agents.";
    list.style.display = "none";
    return;
  }

  empty.classList.add("hidden");
  list.style.display = "";
  for (const a of agents) {
    const card = document.createElement("div");
    card.className = "seed-card" + (wizard.seedAgentIds.has(a.id) ? " selected" : "");
    const avatarHtml = a.avatar_url
      ? `<img src="${escapeHtml(a.avatar_url)}" alt="" />`
      : identiconSvg(a.id, 36);
    card.innerHTML = `
      <div class="seed-avatar">${avatarHtml}</div>
      <div class="seed-meta">
        <div class="seed-name">${escapeHtml(a.name || a.id)}</div>
        <div class="seed-id">${escapeHtml(a.id)}${a.role ? ` · ${escapeHtml(a.role)}` : ""}</div>
      </div>
      <div class="seed-check">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      </div>
    `;
    card.addEventListener("click", () => {
      if (wizard.seedAgentIds.has(a.id)) wizard.seedAgentIds.delete(a.id);
      else wizard.seedAgentIds.add(a.id);
      card.classList.toggle("selected", wizard.seedAgentIds.has(a.id));
    });
    list.appendChild(card);
  }
}

// ── Repo step ────────────────────────────────────────────────────────
interface InstallationInfo { id: number; account: { login: string; type: string } }
interface RepoInfo { name: string; full_name: string }

let repoStepEventsWired = false;

function wireRepoStepEvents(): void {
  if (repoStepEventsWired) return;
  repoStepEventsWired = true;

  const ownerSelect = $("cw-repo-owner") as HTMLSelectElement;
  ownerSelect.addEventListener("change", () => void loadReposForOwner());

  $("cw-repo-create-new").addEventListener("change", () => {
    const checked = ($("cw-repo-create-new") as HTMLInputElement).checked;
    wizard.autoCreateRepo = checked;
    $("cw-repo-new-fields").classList.toggle("hidden", !checked);
    ($("cw-repo-select") as HTMLSelectElement).disabled = checked;
  });

  ($("cw-repo-new-name") as HTMLInputElement).addEventListener("input", () => {
    wizard.newRepoName = ($("cw-repo-new-name") as HTMLInputElement).value.trim();
  });

  ($("cw-repo-private") as HTMLInputElement).addEventListener("change", () => {
    wizard.repoPrivate = ($("cw-repo-private") as HTMLInputElement).checked;
  });

  ($("cw-repo-select") as HTMLSelectElement).addEventListener("change", () => {
    wizard.selectedRepoFullName = ($("cw-repo-select") as HTMLSelectElement).value || null;
  });

  $("cw-repo-install-btn").addEventListener("click", async () => {
    const btn = $("cw-repo-install-btn") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "Installing...";
    await drop.ghAppInstall();
    btn.disabled = false;
    btn.textContent = "Install yo-cypher on GitHub";
    void loadRepoStep();
  });
}

async function loadRepoStep(): Promise<void> {
  const noInstall = $("cw-repo-no-install");
  const fields = $("cw-repo-fields");
  const ownerSelect = $("cw-repo-owner") as HTMLSelectElement;
  const nextBtn = $("cw-next") as HTMLButtonElement;

  wireRepoStepEvents();

  try {
    const installations = (await drop.installationsList()) as InstallationInfo[];
    if (!installations || installations.length === 0) {
      noInstall.classList.remove("hidden");
      fields.classList.add("hidden");
      nextBtn.disabled = true;
      wizard.installationId = null;
      return;
    }

    noInstall.classList.add("hidden");
    fields.classList.remove("hidden");
    nextBtn.disabled = false;

    ownerSelect.innerHTML = "";
    for (const inst of installations) {
      const opt = document.createElement("option");
      opt.value = JSON.stringify({ id: inst.id, login: inst.account.login, type: inst.account.type });
      opt.textContent = inst.account.login;
      ownerSelect.appendChild(opt);
    }

    void loadReposForOwner();
  } catch (err) {
    noInstall.classList.remove("hidden");
    fields.classList.add("hidden");
    nextBtn.disabled = true;
    wizard.installationId = null;
  }
}

async function loadReposForOwner(): Promise<void> {
  const ownerSelect = $("cw-repo-owner") as HTMLSelectElement;
  const repoSelect = $("cw-repo-select") as HTMLSelectElement;
  const val = ownerSelect.value;
  if (!val) return;

  const parsed = JSON.parse(val) as { id: number; login: string; type: string };
  wizard.installationId = parsed.id;
  wizard.selectedOwner = parsed.login;
  wizard.selectedOwnerKind = parsed.type === "Organization" ? "organization" : "user";

  repoSelect.innerHTML = `<option value="">— loading... —</option>`;
  repoSelect.disabled = true;

  try {
    const repos = (await drop.reposForInstallation(parsed.login)) as RepoInfo[];
    repoSelect.innerHTML = `<option value="">— select or create new —</option>`;
    for (const r of repos) {
      const opt = document.createElement("option");
      opt.value = r.full_name;
      opt.textContent = r.full_name;
      repoSelect.appendChild(opt);
    }
  } catch {
    repoSelect.innerHTML = `<option value="">— failed to load repos —</option>`;
  }

  repoSelect.disabled = ($("cw-repo-create-new") as HTMLInputElement).checked;
}

function clearWizardError(): void {
  const e = $("cw-error");
  e.classList.add("hidden");
  e.textContent = "";
}
function showWizardError(msg: string): void {
  const e = $("cw-error");
  e.textContent = msg;
  e.classList.remove("hidden");
}

async function openWizard(): Promise<void> {
  // Make sure we have agents loaded for step 2
  if (agentsCache.length === 0) {
    const r = await drop.agentsList() as Agent[] | { error?: string };
    agentsCache = Array.isArray(r) ? r : [];
  }
  wizard.step = 1;
  wizard.vibe = "open";
  wizard.visibility = "public";
  wizard.wpMode = "blank";
  wizard.seedAgentIds.clear();
  wizard.coverMode = "css";
  wizard.coverDataB64 = null;
  wizard.coverContentType = "image/png";
  wizard.coverPrompt = "";
  wizard.selectedOwner = null;
  wizard.selectedOwnerKind = "user";
  wizard.installationId = null;
  wizard.selectedRepoFullName = null;
  wizard.autoCreateRepo = false;
  wizard.newRepoName = "";
  $i("cw-title").value = "";
  $t("cw-goal").value = "";
  $i("cw-max-jammers").value = "";
  $s("cw-lobby-duration").value = "300";
  $i("cw-wp-git-url").value = "";
  $i("cw-wp-git-branch").value = "main";
  $i("cw-wp-create-branch").checked = false;
  $i("cw-wp-branch-name").value = "";
  $i("cw-wp-read-path").value = "";
  setChip("cw-vibe", "open");
  setChip("cw-visibility", "public");
  setWpMode("blank");
  clearWizardError();
  setWizardStep(1);
  $("cypher-overlay").classList.remove("hidden");
}

function closeWizard(): void {
  $("cypher-overlay").classList.add("hidden");
}

async function publishCypherFromWizard(): Promise<void> {
  clearWizardError();
  const btn = $("cw-publish") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Dropping...";
  const resetBtn = () => { btn.disabled = false; btn.textContent = "Drop it"; };
  const title = $i("cw-title").value.trim();
  if (!title) { showWizardError("Title is required"); setWizardStep(1); resetBtn(); return; }
  const goal = $t("cw-goal").value.trim() || undefined;
  const maxJammersRaw = $i("cw-max-jammers").value.trim();
  const max_jammers = maxJammersRaw ? Math.max(1, Number(maxJammersRaw)) : undefined;
  const lobbyDurRaw = $s("cw-lobby-duration").value;
  const lobby_duration_seconds = lobbyDurRaw === "" ? null : Number(lobbyDurRaw);

  if (!wizard.installationId) {
    showWizardError("A GitHub repo is required — connect GitHub on the Project Board step");
    setWizardStep(4);
    resetBtn();
    return;
  }
  if (!wizard.autoCreateRepo && !wizard.selectedRepoFullName) {
    showWizardError("Select a repo or choose to create a new one");
    setWizardStep(4);
    resetBtn();
    return;
  }

  const setup_steps = buildSetupSteps();

  // 1. Create draft
  const cr = await drop.cypherCreate({
    title,
    goal,
    type: wizard.vibe,
    visibility: wizard.visibility,
    max_jammers,
    setup_steps,
  }) as { ok?: boolean; cypher?: Cypher; error?: string };
  if (!cr.ok || !cr.cypher) {
    showWizardError(cr.error || "Create failed");
    resetBtn();
    return;
  }
  const cypherId = cr.cypher.id;

  // 2. Upload cover image if user generated or uploaded one
  if (wizard.coverDataB64 && wizard.coverMode !== "css") {
    const upR = await drop.cypherCoverUpload(cypherId, wizard.coverDataB64, wizard.coverContentType) as { ok?: boolean; error?: string; cover?: { sha256: string } };
    if (!upR?.ok) {
      console.error("[drop] cover upload failed:", upR?.error || upR);
      showWizardError(`Cover upload failed: ${upR?.error || "unknown error"}`);
      resetBtn();
      return;
    }
  }

  // 3. Publish → lobby (must happen before joining agents — join requires lobby/live status)
  // Include GitHub config so the server auto-creates the project board.
  const publishOpts: Record<string, unknown> = {
    initial_kitty_deposit: 0,
    lobby_duration_seconds,
  };
  if (wizard.installationId) {
    publishOpts.github = {
      installation_id: wizard.installationId,
      owner_login: wizard.selectedOwner,
      owner_kind: wizard.selectedOwnerKind,
      repo_full_name: wizard.autoCreateRepo ? null : wizard.selectedRepoFullName,
      auto_create_repo: wizard.autoCreateRepo,
      repo_name: wizard.autoCreateRepo ? wizard.newRepoName : undefined,
      repo_private: wizard.autoCreateRepo ? wizard.repoPrivate : undefined,
    };
  }
  const pub = await drop.cypherPublish(cypherId, publishOpts) as { ok?: boolean; cypher?: Cypher; error?: string };
  if (!pub.ok || !pub.cypher) {
    showWizardError(pub.error || "Publish failed");
    resetBtn();
    return;
  }

  // 4. Seed roster — join the host's agents into the lobby
  for (const agentId of wizard.seedAgentIds) {
    await drop.cypherJoin(cypherId, agentId).catch(() => { /* best-effort */ });
  }

  closeWizard();
  void loadMine();
  enterLobby(pub.cypher);
}

// ─────────────────────────────────────────────────────
// Lobby view
// ─────────────────────────────────────────────────────

let lobbyState = {
  cypherId: null as string | null,
  cypher: null as Cypher | null,
  jammers: [] as Jammer[],
  draft: null as DraftResult | null,
  pollHandle: null as ReturnType<typeof setInterval> | null,
  timerHandle: null as ReturnType<typeof setInterval> | null,
  unsubscribeEvents: null as (() => void) | null,
  autoStartFired: false,
};

async function enterLobby(c: Cypher): Promise<void> {
  await ensureCurrentUser();
  lobbyState.cypherId = c.id;
  lobbyState.cypher = c;
  lobbyState.autoStartFired = false;

  // Live and wrapped cyphers go straight to the cypher panel
  if (c.status === "live" || c.status === "wrapped") {
    void activateCypherPanel(c.id, isHostOf(c), c.title);
    return;
  }

  setView("lobby");
  if (agentsCache.length === 0) {
    const r = await drop.agentsList() as Agent[] | { error?: string };
    agentsCache = Array.isArray(r) ? r : [];
  }
  renderLobby();
  // Fetch cover for lobby banner
  if (c.cover_image_sha256 && !coverCache.has(c.id)) {
    void fetchCovers([c]).then(() => renderLobby());
  }
  startLobbyPolling();
  startLobbyTimer();
}

function exitLobby(): void {
  if (lobbyState.pollHandle) clearInterval(lobbyState.pollHandle);
  if (lobbyState.timerHandle) clearInterval(lobbyState.timerHandle);
  if (lobbyState.unsubscribeEvents) lobbyState.unsubscribeEvents();
  lobbyState.pollHandle = null;
  lobbyState.timerHandle = null;
  lobbyState.unsubscribeEvents = null;
  lobbyState.cypherId = null;
  lobbyState.cypher = null;
  lobbyState.jammers = [];
  lobbyState.draft = null;
  setView("browse");
  void loadFeatured(); void loadDirectory();
  void loadMine();
}

function renderDraft(): void {
  const c = lobbyState.cypher;
  const draft = lobbyState.draft;
  const section = $("lobby-draft-section");
  const grid = $("lobby-draft-grid");
  const empty = $("lobby-draft-empty");
  const sub = $("lobby-draft-sub");
  const redraftBtn = $("lobby-redraft");

  // Hide entire draft section while still in lobby (no draft yet)
  if (!c || c.status === "lobby") {
    section.classList.add("hidden");
    return;
  }
  section.classList.remove("hidden");
  redraftBtn.classList.toggle("hidden", c.status !== "live" || !isHostOf(c));

  if (!draft || draft.assignments.length === 0) {
    empty.classList.remove("hidden");
    grid.style.display = "none";
    sub.textContent = "no assignments yet";
    return;
  }

  empty.classList.add("hidden");
  grid.style.display = "";
  sub.textContent = `round ${draft.draft_round} · ${draft.assignments.length} positions`;

  // Build a lookup of jammer details by agent_local_id for display
  const jammerByAgent = new Map<string, Jammer>();
  for (const j of lobbyState.jammers) jammerByAgent.set(j.agent_local_id, j);

  // Sort: leader first, then by score desc
  const sorted = draft.assignments.slice().sort((a, b) => {
    if (a.position === "leader" && b.position !== "leader") return -1;
    if (b.position === "leader" && a.position !== "leader") return 1;
    return b.score - a.score;
  });

  grid.innerHTML = "";
  sorted.forEach((a, i) => {
    const j = jammerByAgent.get(a.agent_local_id);
    const card = document.createElement("div");
    card.className = `draft-card reveal position-${a.position}`;
    card.style.animationDelay = `${Math.min(i, 12) * 0.04}s`;
    const avatarHtml = j?.avatar_url
      ? `<img src="${escapeHtml(j.avatar_url)}" alt="" />`
      : identiconSvg(a.agent_local_id, 40);
    card.innerHTML = `
      <div class="draft-row">
        <div class="draft-avatar">${avatarHtml}</div>
        <div class="draft-meta">
          <div class="draft-name">${escapeHtml(j?.name || a.agent_local_id)}</div>
          <div class="draft-id">${escapeHtml(a.agent_local_id)}</div>
        </div>
        <div class="draft-position-badge position-${a.position}">${a.position}</div>
      </div>
      ${a.area ? `<div class="draft-area">${escapeHtml(a.area)}</div>` : ""}
      ${a.contract ? `<div class="draft-contract">${escapeHtml(a.contract)}</div>` : ""}
    `;
    grid.appendChild(card);
  });
}

function renderLobby(): void {
  const c = lobbyState.cypher;
  if (!c) return;

  const banner = $("lobby-banner");
  const url = coverUrl(c);
  if (url) {
    banner.style.backgroundImage = `url(${url})`;
    banner.innerHTML = "&nbsp;";
  } else {
    banner.style.backgroundImage = cssCoverGradient(c.title || c.slug || "");
    banner.innerHTML = "&nbsp;";
  }

  $("lobby-title").textContent = c.title || c.slug || "Untitled cypher";
  $("lobby-goal").textContent = c.goal || c.description || "";

  const tagText =
    c.status === "lobby" ? "Lobby" :
    c.status === "live" ? "Live" :
    c.status === "wrapped" ? "Wrapped" :
    c.status;
  const tag = $("lobby-status-tag");
  tag.innerHTML = `<span class="pulse"></span> ${escapeHtml(tagText)}`;

  $("lobby-jammer-count").textContent =
    `${lobbyState.jammers.length} jammer${lobbyState.jammers.length === 1 ? "" : "s"}`;

  const list = $("lobby-roster");
  const empty = $("lobby-roster-empty");
  list.innerHTML = "";
  if (lobbyState.jammers.length === 0) {
    empty.classList.remove("hidden");
    list.style.display = "none";
  } else {
    empty.classList.add("hidden");
    list.style.display = "";
    const isHost = isHostOf(c);
    const canRemove = isHost && (c.status === "lobby" || c.status === "live");
    for (const j of lobbyState.jammers) {
      const card = document.createElement("div");
      card.className = "roster-card reveal";
      const avatarHtml = j.avatar_url
        ? `<img src="${escapeHtml(j.avatar_url)}" alt="" />`
        : identiconSvg(j.agent_local_id, 48);
      const totalTok = (j.input_tokens ?? 0) + (j.output_tokens ?? 0);
      card.innerHTML = `
        <div class="roster-head">
          <div class="roster-avatar">${avatarHtml}</div>
          <div class="roster-meta">
            <div class="roster-name">${escapeHtml(j.name || j.agent_local_id)}</div>
            <div class="roster-id">${escapeHtml(j.agent_local_id)}${j.role ? ` · ${escapeHtml(j.role)}` : ""}</div>
          </div>
          ${totalTok > 0 ? `<span class="roster-token-badge">${fmtNum(totalTok)} tok</span>` : ""}
          ${canRemove ? `<button class="jammer-remove-btn" title="Remove jammer">×</button>` : ""}
        </div>
      `;
      if (canRemove) {
        card.querySelector(".jammer-remove-btn")!.addEventListener("click", async (e) => {
          e.stopPropagation();
          const r = await drop.cypherLeave(lobbyState.cypherId!, j.agent_local_id) as { ok?: boolean; error?: string };
          if (!r.ok) { showToast(r.error || "Remove failed"); return; }
          const jR = await drop.cypherJammers(lobbyState.cypherId!) as { jammers?: Jammer[]; error?: string };
          if (jR && Array.isArray(jR.jammers)) lobbyState.jammers = jR.jammers;
          renderLobby();
        });
      }
      list.appendChild(card);
    }
  }

  // Show timer panel only while lobby
  $("lobby-timer").classList.toggle("hidden", c.status !== "lobby");

  // Action buttons — show/hide based on status + membership + ownership
  const isJammed = isUserJammed();
  const isHost = isHostOf(c);
  const terminal = c.status === "wrapped" || c.status === "cancelled";
  // Host-only: Start + Cancel
  $("lobby-start").classList.toggle("hidden", !isHost || c.status !== "lobby");
  $("lobby-cancel").classList.toggle("hidden", !isHost || terminal);
  $("lobby-edit").classList.toggle("hidden", !isHost || terminal);
  // Enter Cypher — visible when live (for owner or participants)
  $("lobby-enter").classList.toggle("hidden", c.status !== "live");
  // Join visible in lobby or live, if user has agents not yet in the cypher
  $("lobby-join").classList.toggle("hidden", terminal || (c.status !== "lobby" && c.status !== "live") || allAgentsJammed());
  // Leave visible only if user IS a jammer (and not terminal)
  $("lobby-leave").classList.toggle("hidden", terminal || !isJammed);

  // Hide the lobby roster section once we're live — the draft cards take over
  $("lobby-roster-section").classList.toggle("hidden", c.status !== "lobby");

  renderDraft();
}

/**
 * Cross-reference my registry (agentsCache) with the cypher's jammers.
 * If any of my agent ids is on the jammer list, I'm in.
 */
function isUserJammed(): boolean {
  if (lobbyState.jammers.length === 0 || agentsCache.length === 0) return false;
  const mine = new Set(agentsCache.map((a) => a.id));
  return lobbyState.jammers.some((j) => mine.has(j.agent_local_id));
}

function allAgentsJammed(): boolean {
  if (agentsCache.length === 0) return false;
  const joined = new Set(lobbyState.jammers.map((j) => j.agent_local_id));
  return agentsCache.every((a) => joined.has(a.id));
}

// Kinds of SSE events that should trigger an immediate refresh.
const LOBBY_REFRESH_KINDS = new Set([
  "cypher_started", "cypher_wrapped", "jammer_join", "jammer_leave", "seat_open",
]);

function subscribeLobbyEvents(): void {
  if (lobbyState.unsubscribeEvents) lobbyState.unsubscribeEvents();
  lobbyState.unsubscribeEvents = drop.onCypherEvent((cypherId, kind) => {
    if (cypherId !== lobbyState.cypherId) return;
    if (LOBBY_REFRESH_KINDS.has(kind) && lobbyState.pollHandle) {
      // Trigger an out-of-band refresh; the existing tick reads cypher + jammers
      // + draft and re-renders. We simulate the tick by calling the same fetcher.
      void refreshLobbyOnce();
    }
  });
}

async function refreshLobbyOnce(): Promise<void> {
  if (!lobbyState.cypherId) return;
  const [cR, jR] = await Promise.all([
    drop.cypherGet(lobbyState.cypherId),
    drop.cypherJammers(lobbyState.cypherId),
  ]) as [{ cypher?: Cypher; error?: string }, { jammers?: Jammer[]; error?: string }];
  if (cR && "cypher" in cR && cR.cypher) {
    lobbyState.cypher = cR.cypher;
    if (cR.cypher.status === "live") {
      const dR = await drop.cypherDraftGet(lobbyState.cypherId) as { ok?: boolean; draft_round?: number; assignments?: AssignmentRow[]; cypher_id?: string; error?: string };
      if (dR && dR.ok && Array.isArray(dR.assignments)) {
        lobbyState.draft = {
          cypher_id: dR.cypher_id || lobbyState.cypherId,
          draft_round: dR.draft_round ?? 0,
          assignments: dR.assignments,
        };
      }
      enterWorkspace(lobbyState.cypher, lobbyState.jammers, lobbyState.draft);
      return;
    }
  }
  if (jR && "jammers" in jR && Array.isArray(jR.jammers)) lobbyState.jammers = jR.jammers;
  renderLobby();
}

function startLobbyPolling(): void {
  if (lobbyState.pollHandle) clearInterval(lobbyState.pollHandle);
  subscribeLobbyEvents();
  const tick = async () => {
    if (!lobbyState.cypherId) return;
    const [cR, jR] = await Promise.all([
      drop.cypherGet(lobbyState.cypherId),
      drop.cypherJammers(lobbyState.cypherId),
    ]) as [{ cypher?: Cypher; error?: string }, { jammers?: Jammer[]; error?: string }];
    if (cR && "cypher" in cR && cR.cypher) {
      lobbyState.cypher = cR.cypher;
      if (cR.cypher.status === "wrapped" || cR.cypher.status === "cancelled") {
        renderLobby();
        if (lobbyState.pollHandle) clearInterval(lobbyState.pollHandle);
        return;
      }
    }
    if (jR && "jammers" in jR && Array.isArray(jR.jammers)) {
      lobbyState.jammers = jR.jammers;
    }
    // Pull draft + auto-transition to Workspace once the cypher is live
    if (lobbyState.cypher && lobbyState.cypher.status === "live") {
      const dR = await drop.cypherDraftGet(lobbyState.cypherId) as { ok?: boolean; draft_round?: number; assignments?: AssignmentRow[]; cypher_id?: string; error?: string };
      if (dR && "ok" in dR && dR.ok && Array.isArray(dR.assignments)) {
        lobbyState.draft = {
          cypher_id: dR.cypher_id || lobbyState.cypherId,
          draft_round: dR.draft_round ?? 0,
          assignments: dR.assignments,
        };
      }
      // Hand off to Workspace view
      enterWorkspace(lobbyState.cypher, lobbyState.jammers, lobbyState.draft);
      return;
    }
    renderLobby();
  };
  void tick();
  // 10s heartbeat — SSE handles real-time signal; this is just a fallback
  // for when no cypher SSE is open (e.g. lobby phase, no jammers spawned yet).
  lobbyState.pollHandle = setInterval(tick, 10_000);
}

function startLobbyTimer(): void {
  if (lobbyState.timerHandle) clearInterval(lobbyState.timerHandle);
  const tick = () => {
    const c = lobbyState.cypher;
    const clock = $("lobby-timer-clock");
    const panel = $("lobby-timer");
    if (!c || c.status !== "lobby") {
      clock.textContent = "--:--";
      panel.classList.remove("urgent");
      return;
    }
    if (!c.lobby_started_at || c.lobby_duration_seconds == null) {
      clock.textContent = "open";
      panel.classList.remove("urgent");
      return;
    }
    const startedMs = new Date(c.lobby_started_at).getTime();
    const endsMs = startedMs + c.lobby_duration_seconds * 1000;
    const remainSec = Math.max(0, Math.floor((endsMs - Date.now()) / 1000));
    const m = Math.floor(remainSec / 60);
    const s = remainSec % 60;
    clock.textContent = `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    clock.classList.toggle("urgent", remainSec <= 10 && remainSec > 0);
    if (remainSec === 0 && !lobbyState.autoStartFired) {
      lobbyState.autoStartFired = true;
      void lobbyStartNow();
    }
  };
  tick();
  lobbyState.timerHandle = setInterval(tick, 500);
}

async function lobbyStartNow(): Promise<void> {
  if (!lobbyState.cypherId) return;
  const cypherId = lobbyState.cypherId;
  const title = lobbyState.cypher?.title;
  // Stop SSE + polling BEFORE the start call so the cypher_started event
  // doesn't race us into a duplicate enterWorkspace / activateCypherPanel.
  if (lobbyState.unsubscribeEvents) { lobbyState.unsubscribeEvents(); lobbyState.unsubscribeEvents = null; }
  if (lobbyState.pollHandle) { clearInterval(lobbyState.pollHandle); lobbyState.pollHandle = null; }
  if (lobbyState.timerHandle) { clearInterval(lobbyState.timerHandle); lobbyState.timerHandle = null; }
  const r = await drop.cypherStart(cypherId) as { ok?: boolean; cypher?: Cypher; error?: string };
  if (!r.ok) {
    showToast(r.error || "Start failed");
    startLobbyPolling();
    return;
  }
  exitLobby();
  void activateCypherPanel(cypherId, true, title);
}

async function activateCypherPanel(cypherId: string, isOwner: boolean, title?: string): Promise<void> {
  await drop.cypherPanelActivate(cypherId, isOwner, title);
}

async function lobbyCancel(): Promise<void> {
  if (!lobbyState.cypherId) return;
  const confirmed = await showConfirm({
    title: "Cancel cypher",
    subtitle: lobbyState.cypher?.title || "",
    message: "This will cancel the cypher and remove all jammers. This cannot be undone.",
    actionLabel: "Cancel cypher",
  });
  if (!confirmed) return;
  const r = await drop.cypherCancel(lobbyState.cypherId) as { ok?: boolean; error?: string };
  if (!r.ok) { showToast(r.error || "Cancel failed"); return; }
  exitLobby();
}

// ── Cypher edit (from lobby) ──────────────────────────

function openCypherEdit(): void {
  const c = lobbyState.cypher;
  if (!c) return;
  $i("ce-title").value = c.title || "";
  $t("ce-goal").value = c.goal || "";
  $t("ce-description").value = c.description || "";
  $i("ce-max-jammers").value = c.max_jammers != null ? String(c.max_jammers) : "";
  $("ce-error").classList.add("hidden");
  $("cypher-edit-overlay").classList.remove("hidden");
}

function closeCypherEdit(): void {
  $("cypher-edit-overlay").classList.add("hidden");
}

async function saveCypherEdit(): Promise<void> {
  if (!lobbyState.cypherId) return;
  const title = $i("ce-title").value.trim();
  if (!title) { $("ce-error").textContent = "Title is required"; $("ce-error").classList.remove("hidden"); return; }
  const patch: { title: string; goal?: string; description?: string; max_jammers?: number | null } = { title };
  const goal = $t("ce-goal").value.trim();
  if (goal) patch.goal = goal;
  const desc = $t("ce-description").value.trim();
  if (desc) patch.description = desc;
  const maxJ = $i("ce-max-jammers").value.trim();
  patch.max_jammers = maxJ ? Number(maxJ) : null;

  const r = await drop.cypherUpdateMeta(lobbyState.cypherId, patch) as { ok?: boolean; cypher?: Cypher; error?: string };
  if (!r.ok) { $("ce-error").textContent = r.error || "Save failed"; $("ce-error").classList.remove("hidden"); return; }
  if (r.cypher) lobbyState.cypher = r.cypher;
  closeCypherEdit();
  renderLobby();
}

/**
 * Leave: if I'm a jammer, call cypherLeave for each of my jammed agents
 * before exiting. If I'm just a viewer, exit without calling anything.
 */
async function lobbyLeave(): Promise<void> {
  if (!lobbyState.cypherId) { exitLobby(); return; }
  const mine = new Set(agentsCache.map((a) => a.id));
  const myJammers = lobbyState.jammers.filter((j) => mine.has(j.agent_local_id));
  for (const j of myJammers) {
    await drop.cypherLeave(lobbyState.cypherId, j.agent_local_id).catch(() => {});
  }
  exitLobby();
}

// ── Join flow ─────────────────────────────────────────

let joinSelectedIds = new Set<string>();

function openJoinPicker(): void {
  if (!lobbyState.cypher) return;
  $("join-cypher-title").textContent = lobbyState.cypher.title || lobbyState.cypher.slug || "";
  joinSelectedIds.clear();
  clearJoinError();
  $i("join-search").value = "";
  renderJoinList();
  updateJoinCount();
  $("join-overlay").classList.remove("hidden");
}

function closeJoinPicker(): void {
  $("join-overlay").classList.add("hidden");
}

function clearJoinError(): void {
  const e = $("join-error");
  e.classList.add("hidden");
  e.textContent = "";
}
function showJoinError(msg: string): void {
  const e = $("join-error");
  e.textContent = msg;
  e.classList.remove("hidden");
}

function updateJoinCount(): void {
  const el = $("join-selected-count");
  el.textContent = joinSelectedIds.size > 0 ? `${joinSelectedIds.size} selected` : "";
}

function renderJoinList(filter?: string): void {
  const list = $("join-pick-list");
  const empty = $("join-pick-empty");
  list.innerHTML = "";
  if (agentsCache.length === 0) {
    empty.classList.remove("hidden");
    list.style.display = "none";
    return;
  }
  empty.classList.add("hidden");
  list.style.display = "";

  const onCypher = new Set(lobbyState.jammers.map((j) => j.agent_local_id));
  let candidates = agentsCache
    .filter((a) => !onCypher.has(a.id))
    .sort((a, b) => Number(!!b.joinable) - Number(!!a.joinable));

  if (filter) {
    const q = filter.toLowerCase();
    candidates = candidates.filter((a) =>
      a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q) || (a.role || "").toLowerCase().includes(q)
    );
  }

  if (candidates.length === 0) {
    empty.classList.remove("hidden");
    empty.textContent = filter ? "No matching jammers." : "All your jammers are already on this cypher.";
    list.style.display = "none";
    return;
  }

  for (const a of candidates) {
    const card = document.createElement("div");
    card.className = "seed-card" + (joinSelectedIds.has(a.id) ? " selected" : "");
    const avatarHtml = a.avatar_url
      ? `<img src="${escapeHtml(a.avatar_url)}" alt="" />`
      : identiconSvg(a.id, 36);
    card.innerHTML = `
      <div class="seed-avatar">${avatarHtml}</div>
      <div class="seed-meta">
        <div class="seed-name">${escapeHtml(a.name || a.id)}${a.joinable ? "" : ' <span class="form-hint">(not joinable)</span>'}</div>
        <div class="seed-id">${escapeHtml(a.id)}${a.role ? ` · ${escapeHtml(a.role)}` : ""}</div>
      </div>
      <div class="seed-check">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      </div>
    `;
    card.addEventListener("click", () => {
      if (joinSelectedIds.has(a.id)) joinSelectedIds.delete(a.id);
      else joinSelectedIds.add(a.id);
      card.classList.toggle("selected", joinSelectedIds.has(a.id));
      updateJoinCount();
    });
    list.appendChild(card);
  }
}

async function joinSelectedJammers(): Promise<void> {
  if (!lobbyState.cypherId || joinSelectedIds.size === 0) return;
  clearJoinError();
  const errors: string[] = [];
  for (const agentId of joinSelectedIds) {
    const r = await drop.cypherJoin(lobbyState.cypherId, agentId) as { ok?: boolean; error?: string };
    if (!r.ok) errors.push(`${agentId}: ${r.error || "failed"}`);
  }
  if (errors.length > 0) {
    showJoinError(errors.join("; "));
  } else {
    closeJoinPicker();
  }
  if (lobbyState.cypherId) {
    const jR = await drop.cypherJammers(lobbyState.cypherId) as { jammers?: Jammer[]; error?: string };
    if (jR && Array.isArray(jR.jammers)) lobbyState.jammers = jR.jammers;
  }
  renderLobby();
}

// ─────────────────────────────────────────────────────
// Workspace view (live match)
// ─────────────────────────────────────────────────────

interface WorkspaceEvent {
  id: string;
  cypher_id: string;
  jam_id: string | null;
  seq: string;
  by_user_id: string | null;
  by_agent_id: string | null;
  kind: string;
  payload: Record<string, unknown>;
  created_at: string;
}

const wsState = {
  cypherId: null as string | null,
  cypher: null as Cypher | null,
  jammers: [] as Jammer[],
  draft: null as DraftResult | null,
  events: [] as WorkspaceEvent[],
  focusedAgent: null as string | null,
  lastSeq: "0",
  startedAt: 0,
  pollHandle: null as ReturnType<typeof setInterval> | null,
  clockHandle: null as ReturnType<typeof setInterval> | null,
  unsubscribeEvents: null as (() => void) | null,
};

function enterWorkspace(c: Cypher, jammers: Jammer[], draft: DraftResult | null): void {
  // Clear lobby polling first
  if (lobbyState.pollHandle) clearInterval(lobbyState.pollHandle);
  if (lobbyState.timerHandle) clearInterval(lobbyState.timerHandle);
  lobbyState.pollHandle = null;
  lobbyState.timerHandle = null;

  setView("workspace");
  wsState.cypherId = c.id;
  wsState.cypher = c;
  wsState.jammers = jammers;
  wsState.draft = draft;
  wsState.events = [];
  wsState.lastSeq = "0";
  wsState.startedAt = c.lobby_started_at
    ? new Date(c.lobby_started_at).getTime()
    : Date.now();
  // Auto-focus the leader if we have a draft
  if (draft && draft.assignments.length > 0) {
    const leader = draft.assignments.find((a) => a.position === "leader");
    wsState.focusedAgent = (leader || draft.assignments[0]).agent_local_id;
  } else if (jammers.length > 0) {
    wsState.focusedAgent = jammers[0].agent_local_id;
  }
  // The .yo is now piloting this cypher — substrate cypher tools light up.
  void drop.cypherSetCurrent(c.id);
  // Spawn my drafted jammers as sandboxed runtimes (idempotent server-side).
  void drop.cypherSpawnJammers(c.id);
  renderWorkspace();
  startWorkspacePolling();
  startWorkspaceClock();
  subscribeWorkspaceEvents();
}

function subscribeWorkspaceEvents(): void {
  if (wsState.unsubscribeEvents) wsState.unsubscribeEvents();
  wsState.unsubscribeEvents = drop.onCypherEvent((cypherId, kind, payload) => {
    if (cypherId !== wsState.cypherId) return;
    // Append the event to our buffer immediately (SSE feed) so the activity
    // panel updates without waiting for the poll.
    const seqRaw = (payload as { seq?: string | number } | undefined)?.seq;
    const synth: WorkspaceEvent = {
      id: String((payload as { id?: string } | undefined)?.id ?? `sse-${Date.now()}`),
      cypher_id: cypherId,
      jam_id: null,
      seq: String(seqRaw ?? wsState.lastSeq),
      by_user_id: (payload as { by_user_id?: string } | undefined)?.by_user_id ?? null,
      by_agent_id: (payload as { by_agent_id?: string } | undefined)?.by_agent_id ?? null,
      kind,
      payload: payload as Record<string, unknown>,
      created_at: new Date().toISOString(),
    };
    wsState.events.push(synth);
    if (wsState.events.length > 500) wsState.events = wsState.events.slice(-500);
    // Trigger a fresh poll on lifecycle kinds so we pick up authoritative state.
    if (kind === "cypher_wrapped" || kind === "jammer_join" || kind === "jammer_leave" || kind === "seat_open") {
      // Out-of-band poll
      void (async () => {
        if (!wsState.cypherId) return;
        const [cR, jR, dR] = await Promise.all([
          drop.cypherGet(wsState.cypherId),
          drop.cypherJammers(wsState.cypherId),
          drop.cypherDraftGet(wsState.cypherId),
        ]) as [
          { cypher?: Cypher; error?: string },
          { jammers?: Jammer[]; error?: string },
          { ok?: boolean; assignments?: AssignmentRow[]; draft_round?: number; cypher_id?: string; error?: string },
        ];
        if (cR && "cypher" in cR && cR.cypher) wsState.cypher = cR.cypher;
        if (jR && "jammers" in jR && Array.isArray(jR.jammers)) wsState.jammers = jR.jammers;
        if (dR && dR.ok && Array.isArray(dR.assignments)) {
          wsState.draft = {
            cypher_id: dR.cypher_id || (wsState.cypherId as string),
            draft_round: dR.draft_round ?? 0,
            assignments: dR.assignments,
          };
        }
        renderWorkspace();
      })();
      return;
    }
    renderWorkspace();
  });
}

async function leaveWorkspace(): Promise<void> {
  if (wsState.cypherId) {
    const mine = new Set(agentsCache.map((a) => a.id));
    const myJammers = wsState.jammers.filter((j) => mine.has(j.agent_local_id));
    for (const j of myJammers) {
      await drop.cypherLeave(wsState.cypherId, j.agent_local_id).catch(() => {});
    }
  }
  exitWorkspace();
}

function exitWorkspace(): void {
  if (wsState.pollHandle) clearInterval(wsState.pollHandle);
  if (wsState.clockHandle) clearInterval(wsState.clockHandle);
  if (wsState.unsubscribeEvents) wsState.unsubscribeEvents();
  wsState.pollHandle = null;
  wsState.clockHandle = null;
  wsState.unsubscribeEvents = null;
  void drop.cypherSetCurrent(null);
  wsState.cypherId = null;
  wsState.cypher = null;
  wsState.jammers = [];
  wsState.draft = null;
  wsState.events = [];
  wsState.focusedAgent = null;
  setView("browse");
  void loadFeatured(); void loadDirectory();
  void loadMine();
}

function fmtElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function startWorkspaceClock(): void {
  if (wsState.clockHandle) clearInterval(wsState.clockHandle);
  const tick = () => {
    if (!wsState.cypher) return;
    if (wsState.cypher.status === "wrapped" || wsState.cypher.status === "cancelled") {
      // Frozen
      return;
    }
    $("ws-clock").textContent = fmtElapsed(Date.now() - wsState.startedAt);
  };
  tick();
  wsState.clockHandle = setInterval(tick, 1000);
}

function renderWorkspace(): void {
  const c = wsState.cypher;
  if (!c) return;

  $("ws-title").textContent = c.title || c.slug || "Untitled cypher";
  const tag = $("ws-status-tag");
  const tagText =
    c.status === "live" ? "Live" :
    c.status === "wrapped" ? "Wrapped" :
    c.status === "cancelled" ? "Cancelled" :
    c.status;
  tag.innerHTML = `<span class="pulse"></span> ${escapeHtml(tagText)}`;
  $("ws-jammer-count").textContent =
    `${wsState.jammers.length} jammer${wsState.jammers.length === 1 ? "" : "s"}`;

  $("ws-wrap").classList.toggle("hidden", c.status !== "live" || !isHostOf(c));
  renderWsRoster();
  renderWsStage();
  renderWsActivity();
}

function renderWsRoster(): void {
  const roster = $("ws-roster");
  roster.innerHTML = "";
  // Use draft assignments if we have them; otherwise jammers
  const items = wsState.draft && wsState.draft.assignments.length > 0
    ? wsState.draft.assignments
    : wsState.jammers.map((j): AssignmentRow => ({
        id: "", cypher_id: wsState.cypherId || "", user_id: j.user_id,
        agent_local_id: j.agent_local_id, position: "worker",
        parent_id: null, area: null, contract: null, score: 0,
        draft_round: 0, declined: false, created_at: "",
      }));

  const sorted = items.slice().sort((a, b) => {
    if (a.position === "leader" && b.position !== "leader") return -1;
    if (b.position === "leader" && a.position !== "leader") return 1;
    return b.score - a.score;
  });

  // Activity per agent: derived from the most recent event's by_agent_id
  const recentByAgent = new Map<string, WorkspaceEvent>();
  for (const ev of wsState.events) {
    if (!ev.by_agent_id) continue;
    const prev = recentByAgent.get(ev.by_agent_id);
    if (!prev || ev.seq > prev.seq) recentByAgent.set(ev.by_agent_id, ev);
  }
  const ACTIVE_WINDOW_MS = 30_000;
  const now = Date.now();

  const jammerByAgent = new Map<string, Jammer>();
  for (const j of wsState.jammers) jammerByAgent.set(j.agent_local_id, j);

  for (const a of sorted) {
    const j = jammerByAgent.get(a.agent_local_id);
    const tile = document.createElement("div");
    tile.className = "ws-tile" + (a.agent_local_id === wsState.focusedAgent ? " active" : "");
    const avatarInner = j?.avatar_url
      ? `<img src="${escapeHtml(j.avatar_url)}" alt="" />`
      : identiconSvg(a.agent_local_id, 36);
    const recent = recentByAgent.get(a.agent_local_id);
    const isActive = recent && (now - new Date(recent.created_at).getTime() < ACTIVE_WINDOW_MS);
    const dotClass = isActive ? "active" : "";
    tile.innerHTML = `
      <div class="ws-tile-avatar">${avatarInner}<span class="dot ${dotClass}"></span></div>
      <div class="ws-tile-meta">
        <div class="ws-tile-name">${escapeHtml(j?.name || a.agent_local_id)}</div>
        <div class="ws-tile-sub">${escapeHtml(a.position)}${a.area ? ` · ${a.area.slice(0, 40)}${a.area.length > 40 ? "…" : ""}` : ""}</div>
      </div>
    `;
    tile.addEventListener("click", () => {
      wsState.focusedAgent = a.agent_local_id;
      renderWsRoster();
      renderWsStage();
    });
    roster.appendChild(tile);
  }
}

function renderWsStage(): void {
  const stream = $("ws-stage-stream");
  if (!wsState.focusedAgent) {
    stream.innerHTML = `<div class="ws-stage-empty">Focus a jammer to see its activity stream.</div>`;
    $("ws-stage-name").textContent = "Pick a jammer";
    $("ws-stage-sub").textContent = "Click a tile to focus";
    $("ws-stage-avatar").innerHTML = "";
    return;
  }
  const focused = wsState.focusedAgent;
  const j = wsState.jammers.find((x) => x.agent_local_id === focused);
  const a = wsState.draft?.assignments.find((x) => x.agent_local_id === focused);

  $("ws-stage-name").textContent = j?.name || focused;
  $("ws-stage-sub").textContent = a ? `${a.position}${a.area ? ` · ${a.area}` : ""}` : focused;
  $("ws-stage-avatar").innerHTML = j?.avatar_url
    ? `<img src="${escapeHtml(j.avatar_url)}" alt="" />`
    : identiconSvg(focused, 40);

  const evs = wsState.events.filter((ev) => ev.by_agent_id === focused).slice(-50);
  if (evs.length === 0) {
    stream.innerHTML = `<div class="ws-stage-empty">No activity yet from ${escapeHtml(j?.name || focused)}.</div>`;
    return;
  }
  stream.innerHTML = evs.map((ev) => {
    const time = new Date(ev.created_at).toLocaleTimeString();
    const body = renderEventBody(ev);
    return `<div class="ws-event"><span class="ws-event-kind">${escapeHtml(ev.kind)}</span><span class="ws-event-time">${time}</span><div class="ws-event-body">${body}</div></div>`;
  }).join("");
  stream.scrollTop = stream.scrollHeight;
}

function renderWsActivity(): void {
  const list = $("ws-activity-list");
  if (wsState.events.length === 0) {
    list.innerHTML = `<div class="ws-activity-empty">No events yet.</div>`;
    return;
  }
  const last = wsState.events.slice(-100).reverse();
  list.innerHTML = last.map((ev) => {
    const fromAgent = ev.by_agent_id || "system";
    const j = wsState.jammers.find((x) => x.agent_local_id === ev.by_agent_id);
    const fromName = j?.name || fromAgent;
    const summary = oneLine(renderEventSummary(ev));
    return `<div class="ws-activity-row" data-agent="${escapeHtml(fromAgent)}">
      <span class="from">${escapeHtml(fromName)}</span>
      <span class="kind">${escapeHtml(ev.kind)}</span>
      <span class="body">${escapeHtml(summary)}</span>
    </div>`;
  }).join("");
  // Click on a row → focus that agent
  list.querySelectorAll<HTMLElement>(".ws-activity-row").forEach((el) => {
    el.addEventListener("click", () => {
      const agent = el.dataset.agent;
      if (!agent || agent === "system") return;
      wsState.focusedAgent = agent;
      renderWsRoster();
      renderWsStage();
    });
  });
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 140);
}

function renderEventBody(ev: WorkspaceEvent): string {
  const p = ev.payload || {};
  if (typeof p.text === "string") return escapeHtml(p.text);
  if (typeof p.body === "string") return escapeHtml(p.body);
  if (ev.kind === "tool_call" && typeof p.tool === "string") {
    const args = p.args ? ` <span style="color:var(--text-3);">${escapeHtml(JSON.stringify(p.args).slice(0, 100))}</span>` : "";
    return `→ <strong>${escapeHtml(String(p.tool))}</strong>${args}`;
  }
  return `<span style="color:var(--text-3);">${escapeHtml(JSON.stringify(p).slice(0, 200))}</span>`;
}

function renderEventSummary(ev: WorkspaceEvent): string {
  const p = ev.payload || {};
  if (typeof p.text === "string") return p.text;
  if (typeof p.body === "string") return p.body;
  if (typeof p.tool === "string") return `→ ${p.tool}`;
  return JSON.stringify(p).slice(0, 140);
}

function startWorkspacePolling(): void {
  if (wsState.pollHandle) clearInterval(wsState.pollHandle);
  const tick = async () => {
    if (!wsState.cypherId) return;
    const [cR, jR, dR, eR] = await Promise.all([
      drop.cypherGet(wsState.cypherId),
      drop.cypherJammers(wsState.cypherId),
      drop.cypherDraftGet(wsState.cypherId),
      drop.cypherEventsList(wsState.cypherId, { since: Number(wsState.lastSeq) || 0, limit: 100 }),
    ]) as [
      { cypher?: Cypher; error?: string },
      { jammers?: Jammer[]; error?: string },
      { ok?: boolean; assignments?: AssignmentRow[]; draft_round?: number; cypher_id?: string; error?: string },
      { events?: WorkspaceEvent[]; error?: string },
    ];

    if (cR && "cypher" in cR && cR.cypher) wsState.cypher = cR.cypher;
    if (jR && "jammers" in jR && Array.isArray(jR.jammers)) wsState.jammers = jR.jammers;
    if (dR && dR.ok && Array.isArray(dR.assignments)) {
      wsState.draft = {
        cypher_id: dR.cypher_id || wsState.cypherId,
        draft_round: dR.draft_round ?? 0,
        assignments: dR.assignments,
      };
    }
    if (eR && "events" in eR && Array.isArray(eR.events) && eR.events.length > 0) {
      wsState.events.push(...eR.events);
      // Keep last 500 to bound memory
      if (wsState.events.length > 500) wsState.events = wsState.events.slice(-500);
      wsState.lastSeq = eR.events[eR.events.length - 1].seq;
    }
    renderWorkspace();
    if (wsState.cypher && (wsState.cypher.status === "wrapped" || wsState.cypher.status === "cancelled")) {
      if (wsState.pollHandle) clearInterval(wsState.pollHandle);
    }
  };
  void tick();
  // 10s heartbeat — SSE forwards real-time events; this is the safety net
  // that catches missed events on reconnect or if SSE isn't subscribed.
  wsState.pollHandle = setInterval(tick, 10_000);
}

async function workspaceWrap(): Promise<void> {
  if (!wsState.cypherId) return;
  const confirmed = await showConfirm({
    title: "Wrap up cypher",
    subtitle: wsState.cypher?.title || "",
    message: "This will end the match and record results. All jammers will be disconnected.",
    actionLabel: "Wrap up",
  });
  if (!confirmed) return;
  const r = await drop.cypherWrap(wsState.cypherId) as { ok?: boolean; error?: string };
  if (!r.ok) { showToast(r.error || "Wrap failed"); return; }
  exitWorkspace();
}

// ─────────────────────────────────────────────────────
// GH identity badge + landing gate (Phase 1)
// ─────────────────────────────────────────────────────

function updateGhBadge(github: { gh_login: string; gh_avatar: string } | null): void {
  const badge = document.getElementById("drop-gh-badge");
  const avatar = document.getElementById("drop-gh-avatar") as HTMLImageElement | null;
  const login = document.getElementById("drop-gh-login");
  if (!badge || !avatar || !login) return;

  if (!github) {
    badge.classList.add("hidden");
    return;
  }
  avatar.src = github.gh_avatar;
  avatar.alt = github.gh_login;
  login.textContent = `@${github.gh_login}`;
  badge.classList.remove("hidden");
}

function setupGhPopover(): void {
  const badge = document.getElementById("drop-gh-badge");
  const popover = document.getElementById("drop-gh-popover");
  const signoutBtn = document.getElementById("drop-gh-signout");
  if (!badge || !popover || !signoutBtn) return;

  badge.addEventListener("click", (e) => {
    e.stopPropagation();
    popover.classList.toggle("hidden");
  });
  document.addEventListener("click", () => { popover.classList.add("hidden"); });
  popover.addEventListener("click", (e) => { e.stopPropagation(); });

  signoutBtn.addEventListener("click", async () => {
    await drop.signOutGitHub();
    updateGhBadge(null);
    popover.classList.add("hidden");
    void initGhAuth();
  });
}

async function initGhAuth(): Promise<void> {
  setupGhPopover();

  const status = await drop.ghStatus();
  if (status.signedIn && status.github) {
    updateGhBadge(status.github);
    const emailEl = document.getElementById("drop-gh-popover-email");
    const loginEl = document.getElementById("drop-gh-popover-login");
    if (emailEl) emailEl.textContent = currentUserId ? `yo user` : "";
    if (loginEl) loginEl.textContent = `@${status.github.gh_login}`;
    return;
  }

  // Not signed in — show landing card, hide Drop UI
  try {
    const mod = await import("./drop-gh-landing.js");
    const host = document.getElementById("drop-gh-landing-host")
      || (() => {
        const el = document.createElement("div");
        el.id = "drop-gh-landing-host";
        document.body.appendChild(el);
        return el;
      })();
    const r = await mod.maybeRenderGhLanding(host);
    if (r.shown && !r.signedIn) {
      document.querySelectorAll<HTMLElement>(".view-tabs, .view-pane, #drop-topbar")
        .forEach((el) => { el.style.display = "none"; });
      window.addEventListener("drop-gh-signed-in", async () => {
        document.querySelectorAll<HTMLElement>(".view-tabs, .view-pane, #drop-topbar")
          .forEach((el) => { el.style.display = ""; });
        const fresh = await drop.ghStatus();
        if (fresh.signedIn && fresh.github) {
          updateGhBadge(fresh.github);
          const emailEl = document.getElementById("drop-gh-popover-email");
          const loginEl = document.getElementById("drop-gh-popover-login");
          if (loginEl) loginEl.textContent = `@${fresh.github.gh_login}`;
          if (emailEl) emailEl.textContent = "";
        }
      }, { once: true });
    }
  } catch (e) {
    console.warn("[drop] gh-landing init failed:", e);
  }
}

// ─────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────

function init(): void {
  // Cache the authenticated user up front so isHostOf() works on first render
  void ensureCurrentUser();

  // ── THE-PIVOT-GITHUB Phase 1: GH identity badge + landing gate ─────
  void initGhAuth();

  // Browse loaders fire on launch
  void loadFeatured();
  void loadDirectory();
  void loadSidebar();

  // View tabs
  document.querySelectorAll<HTMLElement>(".view-tab").forEach((el) => {
    el.addEventListener("click", () => setView(el.dataset.view as View));
  });

  // Top-bar actions
  $("drop-refresh").addEventListener("click", () => {
    void loadFeatured(); void loadDirectory();
    void loadAgents(); void loadMine();
  });
  $("drop-cta-browse").addEventListener("click", () => { void openWizard(); });
  $("drop-cta-agents").addEventListener("click", () => { void openEdit(null); });
  $("drop-cta-mine").addEventListener("click", () => { void openWizard(); });

  // ── Carousel navigation ─────────────────
  $("carousel-prev").addEventListener("click", () => goToSlide(carouselIdx - 1));
  $("carousel-next").addEventListener("click", () => goToSlide(carouselIdx + 1));

  // ── Directory: search, filters, sort, view toggle, pagination ──
  const dirSearch = $i("dir-search");
  dirSearch.addEventListener("input", () => {
    if (dirSearchTimer) clearTimeout(dirSearchTimer);
    dirSearchTimer = setTimeout(() => { dirPage = 0; void loadDirectory(); }, 250);
  });
  $("dir-filter-status").addEventListener("change", () => { dirPage = 0; void loadDirectory(); });
  $("dir-filter-type").addEventListener("change", () => { dirPage = 0; void loadDirectory(); });
  $("dir-sort").addEventListener("change", () => { void loadDirectory(); });
  $("dir-view-card").addEventListener("click", () => setDirView("card"));
  $("dir-view-table").addEventListener("click", () => setDirView("table"));
  $("dir-prev-page").addEventListener("click", () => { if (dirPage > 0) { dirPage--; void loadDirectory(); } });
  $("dir-next-page").addEventListener("click", () => { dirPage++; void loadDirectory(); });

  // Edit overlay wiring
  $("agent-overlay-scrim").addEventListener("click", closeEdit);
  $("ae-close").addEventListener("click", closeEdit);
  $("ae-cancel").addEventListener("click", closeEdit);
  $("ae-save").addEventListener("click", () => { void saveEdit(); });
  $("ae-delete").addEventListener("click", () => { void deleteEdit(); });
  document.querySelectorAll<HTMLElement>(".overlay-tab").forEach((el) => {
    el.addEventListener("click", () => setEditTab(el.dataset.aeTab as EditTab));
  });

  // Live identicon preview as id / avatar URL change
  $i("ae-id").addEventListener("input", () => {
    if (!editingIsNew) return;
    renderEditAvatar($i("ae-id").value, $i("ae-avatar-url").value || undefined);
    $("ae-heading-id").textContent = $i("ae-id").value;
  });
  $i("ae-avatar-url").addEventListener("input", () => {
    renderEditAvatar(editingAgent?.id ?? $i("ae-id").value, $i("ae-avatar-url").value || undefined);
  });
  $i("ae-name").addEventListener("input", () => {
    $("ae-heading-name").textContent = $i("ae-name").value || "New jammer";
  });
  $("ae-skills-add").addEventListener("click", () => { showSkillsAddPicker(); });
  $("ae-avatar-gen").addEventListener("click", () => { void generateAvatar(); });
  $i("ae-apps-search").addEventListener("input", () => { renderAppsTab($i("ae-apps-search").value); });

  // Guardrails sliders — live value display
  ["ae-gr-input-per-turn","ae-gr-output-per-turn","ae-gr-tokens-session","ae-gr-max-turns","ae-gr-rpm","ae-gr-idle"].forEach((id) => {
    $i(id).addEventListener("input", () => updateGrDisplay(id));
  });

  // ── Cypher creation wizard ─────────────────
  $("cypher-overlay-scrim").addEventListener("click", closeWizard);
  $("cw-close").addEventListener("click", closeWizard);
  $("cw-cancel").addEventListener("click", closeWizard);
  $("cw-back").addEventListener("click", () => {
    if (wizard.step > 1) setWizardStep((wizard.step - 1) as WizardStep);
  });
  $("cw-next").addEventListener("click", () => {
    if (wizard.step < 6) setWizardStep((wizard.step + 1) as WizardStep);
  });
  $("cw-publish").addEventListener("click", () => { void publishCypherFromWizard(); });
  $i("cw-seed-search").addEventListener("input", () => {
    renderSeedList($i("cw-seed-search").value.trim() || undefined);
  });
  document.querySelectorAll<HTMLElement>("#cw-vibe .chip").forEach((el) => {
    el.addEventListener("click", () => {
      wizard.vibe = el.dataset.chip as typeof wizard.vibe;
      setChip("cw-vibe", el.dataset.chip!);
    });
  });
  document.querySelectorAll<HTMLElement>("#cw-visibility .chip").forEach((el) => {
    el.addEventListener("click", () => {
      wizard.visibility = el.dataset.chip as typeof wizard.visibility;
      setChip("cw-visibility", el.dataset.chip!);
    });
  });
  document.querySelectorAll<HTMLElement>("#cw-wp-mode .chip").forEach((el) => {
    el.addEventListener("click", () => {
      setWpMode(el.dataset.chip as typeof wizard.wpMode);
    });
  });
  // Cover art step
  document.querySelectorAll<HTMLElement>("#cw-cover-mode .chip").forEach((el) => {
    el.addEventListener("click", () => {
      setCoverMode(el.dataset.chip as "css" | "generate" | "upload");
    });
  });
  $("cw-cover-gen-btn").addEventListener("click", () => { void generateCoverImage(); });
  $("cw-cover-clear-btn").addEventListener("click", () => {
    wizard.coverDataB64 = null;
    updateCoverPreview();
  });
  const coverFileInput = $("cw-cover-file") as HTMLInputElement;
  coverFileInput.addEventListener("change", () => {
    if (coverFileInput.files?.[0]) handleCoverUpload(coverFileInput.files[0]);
  });
  const coverDropZone = $("cw-cover-dropzone");
  coverDropZone.addEventListener("dragover", (e) => { e.preventDefault(); coverDropZone.classList.add("drag-over"); });
  coverDropZone.addEventListener("dragleave", () => { coverDropZone.classList.remove("drag-over"); });
  coverDropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    coverDropZone.classList.remove("drag-over");
    const file = (e as DragEvent).dataTransfer?.files[0];
    if (file) handleCoverUpload(file);
  });

  // ── Lobby ─────────────────────────────────
  $("lobby-back").addEventListener("click", exitLobby);
  $("lobby-leave").addEventListener("click", () => { void lobbyLeave(); });
  $("lobby-start").addEventListener("click", () => { void lobbyStartNow(); });
  $("lobby-cancel").addEventListener("click", () => { void lobbyCancel(); });
  $("lobby-edit").addEventListener("click", openCypherEdit);
  $("lobby-enter").addEventListener("click", () => {
    if (lobbyState.cypherId) void activateCypherPanel(lobbyState.cypherId, isHostOf(lobbyState.cypher), lobbyState.cypher?.title);
  });
  $("cypher-edit-scrim").addEventListener("click", closeCypherEdit);
  $("cypher-edit-close").addEventListener("click", closeCypherEdit);
  $("cypher-edit-save").addEventListener("click", () => { void saveCypherEdit(); });
  $("lobby-join").addEventListener("click", openJoinPicker);
  $("join-overlay-scrim").addEventListener("click", closeJoinPicker);
  $("join-close").addEventListener("click", closeJoinPicker);
  $("join-cancel").addEventListener("click", closeJoinPicker);
  $("join-confirm").addEventListener("click", () => { void joinSelectedJammers(); });
  $i("join-search").addEventListener("input", () => {
    renderJoinList($i("join-search").value.trim() || undefined);
  });
  $("lobby-redraft").addEventListener("click", async () => {
    if (!lobbyState.cypherId) return;
    const r = await drop.cypherRedraft(lobbyState.cypherId) as { ok?: boolean; draft_round?: number; assignments?: AssignmentRow[]; error?: string };
    if (!r.ok) { showToast(r.error || "Redraft failed"); return; }
    if (Array.isArray(r.assignments)) {
      lobbyState.draft = {
        cypher_id: lobbyState.cypherId,
        draft_round: r.draft_round ?? 0,
        assignments: r.assignments,
      };
    }
    renderLobby();
  });

  // ── Workspace ─────────────────────────────
  $("ws-back").addEventListener("click", exitWorkspace);
  $("ws-leave").addEventListener("click", () => { void leaveWorkspace(); });
  $("ws-wrap").addEventListener("click", () => { void workspaceWrap(); });

  // ── Confirm modal ─────────────────
  $("confirm-scrim").addEventListener("click", () => closeConfirm(false));
  $("confirm-cancel").addEventListener("click", () => closeConfirm(false));
  $("confirm-action").addEventListener("click", () => closeConfirm(true));
}

init();
