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
  cypherPublish: (id: string, opts?: { initial_kitty_deposit?: number; lobby_duration_seconds?: number | null }) => Promise<unknown>;
  cypherStart: (id: string) => Promise<unknown>;
  cypherCancel: (id: string) => Promise<unknown>;
  cypherDraftGet: (id: string) => Promise<unknown>;
  cypherRedraft: (id: string, opts?: { ratio?: number }) => Promise<unknown>;
  cypherDecline: (id: string, agent_local_id: string) => Promise<unknown>;
  cypherWrap: (id: string) => Promise<unknown>;
  cypherEventsList: (id: string, opts?: { since?: number; jam_id?: string; limit?: number }) => Promise<unknown>;
  cypherSetCurrent: (id: string | null) => Promise<unknown>;
  cypherSpawnJammers: (id: string) => Promise<unknown>;
  authMe: () => Promise<unknown>;
  devFlags: () => Promise<{ cyphersEnabled: boolean }>;
  onCypherEvent: (cb: (cypherId: string, kind: string, payload: Record<string, unknown>) => void) => () => void;
  cypherGet: (id: string) => Promise<unknown>;
  cypherJammers: (id: string) => Promise<unknown>;
  cypherJoin: (id: string, agent_local_id: string, role?: string, invite_token?: string) => Promise<unknown>;
  cypherLeave: (id: string, agent_local_id: string) => Promise<unknown>;
  agentsLeaderboard: (opts?: { skills?: string; days?: number; limit?: number }) => Promise<unknown>;
  agentsList: () => Promise<unknown>;
  agentsGet: (id: string) => Promise<unknown>;
  agentsSave: (cfg: unknown) => Promise<unknown>;
  agentsRemove: (id: string) => Promise<unknown>;
  agentsIdAvailable: (id: string) => Promise<unknown>;
  modelsList: () => Promise<unknown>;
  execCommand: (cmd: string) => Promise<unknown>;
}
const drop = (window as unknown as { drop: DropAPI }).drop;

interface Cypher {
  id: string; slug: string; title: string; status: string; type?: string;
  kitty?: number; jammers?: number; description?: string; goal?: string;
  owner_user_id?: string;
  lobby_started_at?: string | null;
  lobby_duration_seconds?: number | null;
}
interface Jammer {
  agent_local_id: string;
  user_id: string;
  name?: string;
  avatar_url?: string | null;
  role?: string | null;
  joined_at?: string;
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
interface Agent {
  id: string; name: string; type: "local" | "remote";
  role?: string; systemPrompt?: string;
  apps?: string[]; skills?: string[];
  model_provider?: string; model_name?: string;
  joinable?: boolean; avatar_url?: string; bio?: string;
}
interface Model {
  provider: string; model: string; display_name: string;
  yos_per_1k_input: number; yos_per_1k_output: number;
}

// ── DOM helpers ────────────────────────────────────────
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const $i = (id: string) => document.getElementById(id) as HTMLInputElement;
const $t = (id: string) => document.getElementById(id) as HTMLTextAreaElement;
const $s = (id: string) => document.getElementById(id) as HTMLSelectElement;
const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
const fmtNum = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

// ── State ──────────────────────────────────────────────
let agentsCache: Agent[] = [];
let modelsCache: Model[] = [];
let editingAgent: Agent | null = null;
let editingIsNew = false;
let currentUserId: string | null = null;
let cyphersEnabled: boolean = false;

async function ensureDevFlags(): Promise<void> {
  try {
    const flags = await drop.devFlags();
    cyphersEnabled = !!flags.cyphersEnabled;
  } catch {
    cyphersEnabled = false;
  }
  applyCyphersFlag();
}

/**
 * Hide cypher remote-work UI when the dev flag is off. Production users see:
 *   - Top jammers (read-only leaderboard)
 *   - Your jammers (registry CRUD)
 * Production users do NOT see cypher creation, lobby, workspace, or live rows.
 */
function applyCyphersFlag(): void {
  const hide = !cyphersEnabled;
  // Top-bar CTA — "+ Drop a Cypher" hidden in prod, "+ New Jammer" still toggles per view
  const cta = document.getElementById("drop-cta-browse");
  if (cta) cta.style.display = hide ? "none" : "";
  // Browse view: hero + live cyphers row + your cyphers row are cypher-specific
  for (const id of ["drop-hero", "section-mine"]) {
    const el = document.getElementById(id);
    if (el) el.style.display = hide ? "none" : "";
  }
  const liveSection = document.querySelector<HTMLElement>(".section .row#row-live")?.closest<HTMLElement>(".section");
  if (liveSection) liveSection.style.display = hide ? "none" : "";
}

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
// View router
// ─────────────────────────────────────────────────────

type View = "browse" | "agents" | "lobby" | "workspace";

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
}

// ─────────────────────────────────────────────────────
// Browse view: cyphers + leaderboard
// ─────────────────────────────────────────────────────

function cypherCard(c: Cypher): HTMLElement {
  const el = document.createElement("div");
  el.className = "cypher-card reveal";
  const jammers = c.jammers ?? 0;
  const isLive = c.status === "open" || c.status === "live" || c.status === "running";
  const initial = (c.title || c.slug || "?").trim().charAt(0).toUpperCase();
  el.innerHTML = `
    <div class="cypher-poster">
      <span class="cypher-status-badge ${isLive ? "live" : ""}">
        <span class="pulse"></span>${escapeHtml(c.status || "")}
      </span>
      <span class="glyph">${escapeHtml(initial)}</span>
    </div>
    <div class="cypher-meta">
      <div class="cypher-title">${escapeHtml(c.title || c.slug || "untitled")}</div>
      <div class="cypher-stats">
        <span><strong>${jammers}</strong> jammer${jammers === 1 ? "" : "s"}</span>
      </div>
    </div>
  `;
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

function renderHero(c: Cypher | null): void {
  if (!c) return;
  $("hero-title").textContent = c.title || c.slug || "Untitled cypher";
  $("hero-desc").textContent = c.description || c.goal || "Live cypher accepting jammers.";
  const jammers = c.jammers ?? 0;
  $("hero-meta").innerHTML = `
    <span><strong>${jammers}</strong> jammer${jammers === 1 ? "" : "s"}</span>
    ${c.status ? `<span>· ${escapeHtml(c.status)}</span>` : ""}
  `;
  $("hero-cta").addEventListener("click", () => { enterLobby(c); }, { once: true });
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

async function loadLive(): Promise<void> {
  const r = await drop.cyphersDiscover({ status: "open", limit: 24 }) as { entries?: Cypher[]; error?: string };
  const entries = (r && "entries" in r ? r.entries : []) ?? [];
  fillRow("row-live", "empty-live", entries.map(cypherCard));
  if (entries.length > 0) {
    const featured = entries.slice().sort((a, b) => (b.jammers ?? 0) - (a.jammers ?? 0))[0];
    renderHero(featured);
  }
}

async function loadLeaderboard(): Promise<void> {
  const r = await drop.agentsLeaderboard({ days: 30, limit: 16 }) as { entries?: LeaderboardEntry[]; error?: string };
  const entries = (r && "entries" in r ? r.entries : []) ?? [];
  fillRow("row-agents", "empty-agents", entries.map((e, i) => leaderboardCard(e, i + 1)));
}

async function loadMine(): Promise<void> {
  const r = await drop.cyphersMine() as { cyphers?: Cypher[]; error?: string };
  const entries = (r && "cyphers" in r ? r.cyphers : []) ?? [];
  fillRow("row-mine", "empty-mine", entries.map(cypherCard));
}

// ─────────────────────────────────────────────────────
// Your Agents view
// ─────────────────────────────────────────────────────

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
  el.innerHTML = `
    <div class="roster-head">
      <div class="roster-avatar">${avatarHtml}</div>
      <div class="roster-meta">
        <div class="roster-name">${escapeHtml(a.name || a.id)}</div>
        <div class="roster-id">${escapeHtml(a.id)}${a.role ? ` · ${escapeHtml(a.role)}` : ""}</div>
      </div>
    </div>
    <div class="roster-bio">${a.bio ? escapeHtml(a.bio) : `<span style="color:var(--text-3);">No bio</span>`}</div>
    <div class="roster-tags">${tagsHtml}</div>
  `;
  el.addEventListener("click", () => openEdit(a));
  return el;
}

async function loadAgents(): Promise<void> {
  const r = await drop.agentsList() as Agent[] | { error?: string };
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

async function ensureModelsLoaded(): Promise<void> {
  if (modelsCache.length > 0) return;
  const r = await drop.modelsList() as { models?: Model[]; error?: string };
  modelsCache = (r && "models" in r ? r.models : []) ?? [];
}

function populateModelSelector(provider?: string, model?: string): void {
  const sel = $s("ae-model");
  sel.innerHTML = `<option value="">Default (Sonnet)</option>`;
  const grouped = new Map<string, Model[]>();
  for (const m of modelsCache) {
    if (!grouped.has(m.provider)) grouped.set(m.provider, []);
    grouped.get(m.provider)!.push(m);
  }
  for (const [prov, models] of grouped) {
    const group = document.createElement("optgroup");
    group.label = prov.charAt(0).toUpperCase() + prov.slice(1);
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = `${m.provider}::${m.model}`;
      opt.textContent = `${m.display_name} (${m.yos_per_1k_input}/${m.yos_per_1k_output} yos/1k)`;
      group.appendChild(opt);
    }
    sel.appendChild(group);
  }
  sel.value = provider && model ? `${provider}::${model}` : "";
  updateModelCostHint();
  sel.onchange = () => updateModelCostHint();
}

function updateModelCostHint(): void {
  const sel = $s("ae-model");
  const hint = $("ae-model-cost");
  if (!sel.value) { hint.textContent = ""; return; }
  const [prov, mod] = sel.value.split("::");
  const m = modelsCache.find((x) => x.provider === prov && x.model === mod);
  hint.textContent = m
    ? `${m.yos_per_1k_input} yos/1k input · ${m.yos_per_1k_output} yos/1k output`
    : "";
}

function setEditTab(tab: "profile" | "behavior"): void {
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
  await ensureModelsLoaded();
  editingIsNew = !a;
  editingAgent = a ? { ...a } : { id: "", name: "", type: "local" };

  $i("ae-id").value = editingAgent.id;
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
  const ok = confirm(`Delete jammer "${editingAgent.name || editingAgent.id}"?`);
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

const wizard = {
  step: 1 as 1 | 2 | 3 | 4,
  vibe: "open" as "open" | "coop" | "bounty" | "sponsored",
  visibility: "public" as "public" | "unlisted" | "invite",
  wpMode: "blank" as "blank" | "git",
  seedAgentIds: new Set<string>(),
};

function setWizardStep(n: 1 | 2 | 3 | 4): void {
  wizard.step = n;
  document.querySelectorAll<HTMLElement>("[data-cw-step]").forEach((el) => {
    el.classList.toggle("hidden", el.dataset.cwStep !== String(n));
  });
  const labels = ["Goal", "Work Package", "Seed Roster", "Lobby"];
  $("cw-step-label").textContent = `Step ${n} of 4 — ${labels[n - 1]}`;
  $("cw-back").classList.toggle("hidden", n === 1);
  $("cw-next").classList.toggle("hidden", n === 4);
  $("cw-publish").classList.toggle("hidden", n !== 4);
  if (n === 3) renderSeedList();
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

function setChip(groupId: string, value: string): void {
  document.querySelectorAll<HTMLElement>(`#${groupId} .chip`).forEach((el) => {
    el.classList.toggle("active", el.dataset.chip === value);
  });
}

function renderSeedList(): void {
  const list = $("cw-seed-list");
  const empty = $("cw-seed-empty");
  list.innerHTML = "";
  if (agentsCache.length === 0) {
    empty.classList.remove("hidden");
    list.style.display = "none";
    return;
  }
  empty.classList.add("hidden");
  list.style.display = "";
  for (const a of agentsCache) {
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
  const title = $i("cw-title").value.trim();
  if (!title) { showWizardError("Title is required"); setWizardStep(1); return; }
  const goal = $t("cw-goal").value.trim() || undefined;
  const maxJammersRaw = $i("cw-max-jammers").value.trim();
  const max_jammers = maxJammersRaw ? Math.max(1, Number(maxJammersRaw)) : undefined;
  const lobbyDurRaw = $s("cw-lobby-duration").value;
  const lobby_duration_seconds = lobbyDurRaw === "" ? null : Number(lobbyDurRaw);

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
    return;
  }
  const cypherId = cr.cypher.id;

  // 2. Seed roster — join the host's agents into the draft cypher
  for (const agentId of wizard.seedAgentIds) {
    await drop.cypherJoin(cypherId, agentId).catch(() => { /* best-effort */ });
  }

  // 3. Publish → lobby
  const pub = await drop.cypherPublish(cypherId, {
    initial_kitty_deposit: 0,
    lobby_duration_seconds,
  }) as { ok?: boolean; cypher?: Cypher; error?: string };
  if (!pub.ok || !pub.cypher) {
    showWizardError(pub.error || "Publish failed");
    return;
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
};

async function enterLobby(c: Cypher): Promise<void> {
  setView("lobby");
  lobbyState.cypherId = c.id;
  lobbyState.cypher = c;
  // Make sure we know the user's roster so we can detect "am I a jammer"
  if (agentsCache.length === 0) {
    const r = await drop.agentsList() as Agent[] | { error?: string };
    agentsCache = Array.isArray(r) ? r : [];
  }
  renderLobby();
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
  void loadLive();
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
    for (const j of lobbyState.jammers) {
      const card = document.createElement("div");
      card.className = "roster-card reveal";
      const avatarHtml = j.avatar_url
        ? `<img src="${escapeHtml(j.avatar_url)}" alt="" />`
        : identiconSvg(j.agent_local_id, 48);
      card.innerHTML = `
        <div class="roster-head">
          <div class="roster-avatar">${avatarHtml}</div>
          <div class="roster-meta">
            <div class="roster-name">${escapeHtml(j.name || j.agent_local_id)}</div>
            <div class="roster-id">${escapeHtml(j.agent_local_id)}${j.role ? ` · ${escapeHtml(j.role)}` : ""}</div>
          </div>
        </div>
      `;
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
  // Join visible only in lobby AND user not yet a jammer
  $("lobby-join").classList.toggle("hidden", terminal || c.status !== "lobby" || isJammed);
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
  };
  tick();
  lobbyState.timerHandle = setInterval(tick, 500);
}

async function lobbyStartNow(): Promise<void> {
  if (!lobbyState.cypherId) return;
  const r = await drop.cypherStart(lobbyState.cypherId) as { ok?: boolean; cypher?: Cypher; error?: string };
  if (!r.ok) {
    alert(r.error || "Start failed");
    return;
  }
  if (r.cypher) lobbyState.cypher = r.cypher;
  renderLobby();
  // TODO: hand off to the cypher app for the match phase
}

async function lobbyCancel(): Promise<void> {
  if (!lobbyState.cypherId) return;
  if (!confirm("Cancel this cypher? Jammers will be kicked.")) return;
  const r = await drop.cypherCancel(lobbyState.cypherId) as { ok?: boolean; error?: string };
  if (!r.ok) { alert(r.error || "Cancel failed"); return; }
  exitLobby();
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

function openJoinPicker(): void {
  if (!lobbyState.cypher) return;
  const titleEl = $("join-cypher-title");
  titleEl.textContent = lobbyState.cypher.title || lobbyState.cypher.slug || "";
  clearJoinError();
  renderJoinList();
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

function renderJoinList(): void {
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

  // Hide any of my jammers that are already on the cypher's jammer list.
  const onCypher = new Set(lobbyState.jammers.map((j) => j.agent_local_id));
  const candidates = agentsCache
    .filter((a) => !onCypher.has(a.id))
    .sort((a, b) => Number(!!b.joinable) - Number(!!a.joinable));

  if (candidates.length === 0) {
    empty.classList.remove("hidden");
    empty.textContent = "All your jammers are already on this cypher.";
    list.style.display = "none";
    return;
  }

  for (const a of candidates) {
    const card = document.createElement("div");
    card.className = "seed-card";
    const avatarHtml = a.avatar_url
      ? `<img src="${escapeHtml(a.avatar_url)}" alt="" />`
      : identiconSvg(a.id, 36);
    card.innerHTML = `
      <div class="seed-avatar">${avatarHtml}</div>
      <div class="seed-meta">
        <div class="seed-name">${escapeHtml(a.name || a.id)}${a.joinable ? "" : ' <span class="form-hint">(not joinable)</span>'}</div>
        <div class="seed-id">${escapeHtml(a.id)}${a.role ? ` · ${escapeHtml(a.role)}` : ""}</div>
      </div>
      <div class="seed-check">→</div>
    `;
    card.addEventListener("click", () => { void joinAsJammer(a.id); });
    list.appendChild(card);
  }
}

async function joinAsJammer(agentId: string): Promise<void> {
  if (!lobbyState.cypherId) return;
  clearJoinError();
  const r = await drop.cypherJoin(lobbyState.cypherId, agentId) as { ok?: boolean; error?: string };
  if (!r.ok) {
    showJoinError(r.error || "Join failed");
    return;
  }
  closeJoinPicker();
  // Refresh the lobby's roster immediately so the user sees themselves in.
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

function exitWorkspace(): void {
  if (wsState.pollHandle) clearInterval(wsState.pollHandle);
  if (wsState.clockHandle) clearInterval(wsState.clockHandle);
  if (wsState.unsubscribeEvents) wsState.unsubscribeEvents();
  wsState.pollHandle = null;
  wsState.clockHandle = null;
  wsState.unsubscribeEvents = null;
  // .yo no longer piloting any cypher — cypher tools de-activate.
  void drop.cypherSetCurrent(null);
  wsState.cypherId = null;
  wsState.cypher = null;
  wsState.jammers = [];
  wsState.draft = null;
  wsState.events = [];
  wsState.focusedAgent = null;
  setView("browse");
  void loadLive();
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
  if (!confirm("Wrap up this cypher? Match ends and results are recorded.")) return;
  const r = await drop.cypherWrap(wsState.cypherId) as { ok?: boolean; error?: string };
  if (!r.ok) { alert(r.error || "Wrap failed"); return; }
  exitWorkspace();
}

// ─────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────

function init(): void {
  // Cache the authenticated user up front so isHostOf() works on first render
  void ensureCurrentUser();
  void ensureDevFlags();

  // Browse loaders fire on launch (cypher loaders are no-ops if hidden)
  void loadLive();
  void loadLeaderboard();
  void loadMine();

  // View tabs
  document.querySelectorAll<HTMLElement>(".view-tab").forEach((el) => {
    el.addEventListener("click", () => setView(el.dataset.view as "browse" | "agents"));
  });

  // Top-bar actions
  $("drop-refresh").addEventListener("click", () => {
    void loadLive(); void loadLeaderboard(); void loadMine();
    void loadAgents();
  });
  $("drop-cta-browse").addEventListener("click", () => { void openWizard(); });
  $("drop-cta-agents").addEventListener("click", () => { void openEdit(null); });

  // Search — client-side filter on visible cards
  const search = $i("drop-search");
  search.addEventListener("input", () => {
    const q = search.value.toLowerCase().trim();
    document.querySelectorAll<HTMLElement>(".cypher-card").forEach((card) => {
      const title = card.querySelector(".cypher-title")?.textContent?.toLowerCase() ?? "";
      card.style.display = !q || title.includes(q) ? "" : "none";
    });
    document.querySelectorAll<HTMLElement>(".agent-card").forEach((card) => {
      const name = card.querySelector(".agent-name")?.textContent?.toLowerCase() ?? "";
      const bio = card.querySelector(".agent-bio")?.textContent?.toLowerCase() ?? "";
      card.style.display = !q || name.includes(q) || bio.includes(q) ? "" : "none";
    });
    document.querySelectorAll<HTMLElement>(".roster-card").forEach((card) => {
      const text = card.textContent?.toLowerCase() ?? "";
      card.style.display = !q || text.includes(q) ? "" : "none";
    });
  });

  $("hero-secondary").addEventListener("click", () => {
    void drop.execCommand("yo help cyphers");
  });

  // Edit overlay wiring
  $("agent-overlay-scrim").addEventListener("click", closeEdit);
  $("ae-close").addEventListener("click", closeEdit);
  $("ae-cancel").addEventListener("click", closeEdit);
  $("ae-save").addEventListener("click", () => { void saveEdit(); });
  $("ae-delete").addEventListener("click", () => { void deleteEdit(); });
  document.querySelectorAll<HTMLElement>(".overlay-tab").forEach((el) => {
    el.addEventListener("click", () => setEditTab(el.dataset.aeTab as "profile" | "behavior"));
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

  // ── Cypher creation wizard ─────────────────
  $("cypher-overlay-scrim").addEventListener("click", closeWizard);
  $("cw-close").addEventListener("click", closeWizard);
  $("cw-cancel").addEventListener("click", closeWizard);
  $("cw-back").addEventListener("click", () => {
    if (wizard.step > 1) setWizardStep((wizard.step - 1) as 1 | 2 | 3 | 4);
  });
  $("cw-next").addEventListener("click", () => {
    if (wizard.step < 4) setWizardStep((wizard.step + 1) as 1 | 2 | 3 | 4);
  });
  $("cw-publish").addEventListener("click", () => { void publishCypherFromWizard(); });
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

  // ── Lobby ─────────────────────────────────
  $("lobby-back").addEventListener("click", exitLobby);
  $("lobby-leave").addEventListener("click", () => { void lobbyLeave(); });
  $("lobby-start").addEventListener("click", () => { void lobbyStartNow(); });
  $("lobby-cancel").addEventListener("click", () => { void lobbyCancel(); });
  $("lobby-join").addEventListener("click", openJoinPicker);
  $("join-overlay-scrim").addEventListener("click", closeJoinPicker);
  $("join-close").addEventListener("click", closeJoinPicker);
  $("join-cancel").addEventListener("click", closeJoinPicker);
  $("lobby-redraft").addEventListener("click", async () => {
    if (!lobbyState.cypherId) return;
    const r = await drop.cypherRedraft(lobbyState.cypherId) as { ok?: boolean; draft_round?: number; assignments?: AssignmentRow[]; error?: string };
    if (!r.ok) { alert(r.error || "Redraft failed"); return; }
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
  $("ws-leave").addEventListener("click", exitWorkspace);
  $("ws-wrap").addEventListener("click", () => { void workspaceWrap(); });
}

init();
