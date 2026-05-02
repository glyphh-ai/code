/**
 * Agents section — agent CRUD, apps/skills picker, remote grid, reservations.
 */

import { $a, escapeHtml, slugify, formatYos, closeHelp } from "./shared.js";

// ─────────────────────────────────────────────────────────────────────
// Agents Registry — local templates + remote reservations
// Mirrors Apps section structure: list+search, inline add form, tabbed
// detail with left form + right test bench. Remote tab shows a live
// picker grid (mirrors Connections grid in Apps).
// ─────────────────────────────────────────────────────────────────────

interface AgentGuardrails {
  max_yos_per_turn?: number;
  max_yos_per_session?: number;
  max_yos_per_day?: number;
  max_idle_minutes?: number;
  max_concurrent_reservations?: number;
}
interface AgentRemote {
  preferred_tier?: "premiere" | "standard" | "low" | "any";
  preferred_providers?: string[];
  default_idle_minutes?: number;
  active_reservation_id?: string;
  active_provider_handle?: string;
}
export interface AgentDef {
  id: string;
  name: string;
  type: "local" | "remote";
  role?: string;
  systemPrompt?: string;
  apps?: string[];
  skills?: string[];
  builtin_tools?: string[];
  mcp_servers?: string[];
  model_provider?: string;
  model_name?: string;
  joinable?: boolean;
  guardrails?: AgentGuardrails;
  remote?: AgentRemote;
  meta?: { createdAt: string; updatedAt: string; description?: string };
}
interface MarketEntry {
  offer_handle: string;
  derived_tier: string;
  providers: string[];
  pricing: { terms: string; tier: string; yos_per_1k_input?: number; yos_per_1k_output?: number } | null;
  last_seen_at: string;
}

let agentsCache: AgentDef[] = [];
let currentAgent: AgentDef | null = null;
let currentAgentSnapshot: AgentDef | null = null;
let agentMarketTimer: ReturnType<typeof setInterval> | null = null;
let agentBalanceTimer: ReturnType<typeof setInterval> | null = null;
let rateCardCache: Array<{ tier: string; yos_per_1k_input: number; yos_per_1k_output: number; yos_per_idle_minute: number }> = [];

// $a, slugify, formatYos imported from shared

async function refreshYosBalanceLabel(): Promise<void> {
  const el = $a("agent-yos-balance");
  if (!el) return;
  const r = await window.yo.yosBalance();
  if ("error" in r) { el.textContent = "— yos"; return; }
  el.textContent = formatYos(r.balance);
}

async function loadAgents(): Promise<void> {
  agentsCache = (await window.yo.agentsList() as AgentDef[]) || [];
  void refreshYosBalanceLabel();
  if (rateCardCache.length === 0) {
    const rc = await window.yo.yosRateCards();
    if (!("error" in rc)) rateCardCache = rc.cards;
  }
  renderAgentsList();
  // Show list view, hide detail/add
  $a("agents-list").classList.remove("hidden");
  $a("agents-toolbar").classList.remove("hidden");
  $a("agent-add-form").classList.add("hidden");
  $a("agent-detail").classList.add("hidden");
  stopAgentMarketTimer();
  stopAgentBalanceTimer();
}

function renderAgentsList(): void {
  const list = $a("agents-list");
  const search = ($a<HTMLInputElement>("agent-search").value || "").toLowerCase();
  list.innerHTML = "";

  const filtered = agentsCache.filter((a) =>
    !search || a.name.toLowerCase().includes(search) || a.id.toLowerCase().includes(search) || (a.role || "").toLowerCase().includes(search),
  );

  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "padding:32px 16px;text-align:center;color:var(--text-2);font-size:13px;";
    empty.textContent = agentsCache.length === 0 ? `No agents yet. Click "+ New" to add one.` : "No agents match your search.";
    list.appendChild(empty);
    return;
  }

  for (const a of filtered) {
    const card = document.createElement("div");
    card.className = "crud-card";
    const typeBadge = a.type === "remote" ? `<span class="crud-card-badge">remote</span>` : "";
    const role = a.role ? `<span class="crud-card-meta">${escapeHtml(a.role)}</span>` : "";
    card.innerHTML = `
      <div class="crud-card-info">
        <span class="crud-card-name">${typeBadge}${escapeHtml(a.name || a.id)}</span>
        <span class="crud-card-meta" style="font-family:var(--font-mono);font-size:11px;">${escapeHtml(a.id)}</span>
        ${role}
      </div>
      <div class="crud-card-actions">
        <button class="crud-card-btn crud-open-btn" title="Edit">✎</button>
      </div>
    `;
    card.addEventListener("click", () => openAgentDetail(a));
    list.appendChild(card);
  }
}

// escapeHtml is defined earlier in the file; reuse it.

function showAddAgentForm(): void {
  $a("agents-list").classList.add("hidden");
  $a("agents-toolbar").classList.add("hidden");
  $a("agent-detail").classList.add("hidden");
  $a("agent-add-form").classList.remove("hidden");
  ($a<HTMLInputElement>("agent-add-name")).value = "";
  ($a<HTMLInputElement>("agent-add-slug")).value = "";
  ($a<HTMLSelectElement>("agent-add-type")).value = "local";
  $a("agent-add-error").classList.add("hidden");
}

async function saveNewAgent(): Promise<void> {
  const name = ($a<HTMLInputElement>("agent-add-name")).value.trim();
  let id = ($a<HTMLInputElement>("agent-add-slug")).value.trim() || slugify(name);
  const type = ($a<HTMLSelectElement>("agent-add-type")).value as "local" | "remote";
  const errEl = $a("agent-add-error");

  if (!name) { errEl.textContent = "Name required"; errEl.classList.remove("hidden"); return; }
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) { errEl.textContent = "Slug must be letters/digits/_/-"; errEl.classList.remove("hidden"); return; }
  if (!(await window.yo.agentsIdAvailable(id))) {
    errEl.textContent = `Slug "${id}" already exists`; errEl.classList.remove("hidden"); return;
  }

  const cfg: AgentDef = {
    id, name, type,
    guardrails: type === "remote"
      ? { max_yos_per_session: 5000, max_yos_per_day: 20000, max_idle_minutes: 30, max_concurrent_reservations: 1 }
      : {},
    remote: type === "remote" ? { preferred_tier: "any", default_idle_minutes: 30 } : undefined,
  };
  const saved = await window.yo.agentsSave(cfg) as AgentDef;
  await loadAgents();
  openAgentDetail(saved);
}

function openAgentDetail(agent: AgentDef): void {
  currentAgent = JSON.parse(JSON.stringify(agent));
  currentAgentSnapshot = JSON.parse(JSON.stringify(agent));
  $a("agents-list").classList.add("hidden");
  $a("agents-toolbar").classList.add("hidden");
  $a("agent-add-form").classList.add("hidden");
  $a("agent-detail").classList.remove("hidden");
  $a("agent-detail-heading").textContent = agent.name;
  const badge = $a("agent-detail-type-badge");
  badge.textContent = agent.type;
  badge.style.color = agent.type === "remote" ? "var(--accent)" : "var(--text-2)";

  // Show/hide Remote tab based on type
  const remoteTabBtn = document.querySelector<HTMLButtonElement>('.app-detail-tab[data-tab="remote"]');
  if (remoteTabBtn) remoteTabBtn.style.display = agent.type === "remote" ? "" : "none";

  // General fields
  ($a<HTMLInputElement>("agent-detail-id")).value = agent.id;
  ($a<HTMLInputElement>("agent-detail-name")).value = agent.name;
  ($a<HTMLInputElement>("agent-detail-role")).value = agent.role || "";
  ($a<HTMLTextAreaElement>("agent-detail-prompt")).value = agent.systemPrompt || "";
  ($a<HTMLInputElement>("agent-detail-joinable")).checked = !!agent.joinable;

  // Guardrails fields
  const g = agent.guardrails || {};
  ($a<HTMLInputElement>("agent-guard-per-turn")).value = g.max_yos_per_turn != null ? String(g.max_yos_per_turn) : "";
  ($a<HTMLInputElement>("agent-guard-per-session")).value = g.max_yos_per_session != null ? String(g.max_yos_per_session) : "";
  ($a<HTMLInputElement>("agent-guard-per-day")).value = g.max_yos_per_day != null ? String(g.max_yos_per_day) : "";
  ($a<HTMLInputElement>("agent-guard-max-idle")).value = g.max_idle_minutes != null ? String(g.max_idle_minutes) : "";
  ($a<HTMLInputElement>("agent-guard-max-concurrent")).value = g.max_concurrent_reservations != null ? String(g.max_concurrent_reservations) : "";

  // Remote fields
  const r = agent.remote || {};
  ($a<HTMLSelectElement>("agent-remote-pref-tier")).value = r.preferred_tier || "any";
  ($a<HTMLInputElement>("agent-remote-default-idle")).value = String(r.default_idle_minutes ?? 30);

  switchAgentTab("general");
  void refreshActiveReservation();
  void loadAgentAppsList();
  void loadAgentSkillsList();
  updateTestCostEstimate();
}

// ── Apps + Skills picker (multi-select via checkbox lists) ──

let agentAppsCache: Array<{ id: string; name: string }> = [];
let agentSkillsCache: Array<{ name: string; description?: string }> = [];

async function loadAgentAppsList(): Promise<void> {
  if (!currentAgent) return;
  if (agentAppsCache.length === 0) {
    try {
      const apps = await window.yo.appsList();
      agentAppsCache = apps.map((a) => ({ id: a.id, name: a.name }));
    } catch { agentAppsCache = []; }
  }
  renderAgentAppsList();
}

function renderAgentAppsList(): void {
  if (!currentAgent) return;
  const list = $a("agent-apps-list");
  list.innerHTML = "";
  const selected = currentAgent.apps || [];
  for (const appId of selected) {
    const app = agentAppsCache.find((a) => a.id === appId);
    const row = document.createElement("div");
    row.className = "skill-row";
    row.innerHTML = `
      <span style="font-size:13px;">${escapeHtml(app?.name || appId)}</span>
      <span style="font-size:11px;color:var(--text-3);font-family:var(--font-mono);margin-left:auto;">${escapeHtml(appId)}</span>
      <button class="skill-row-remove" title="Remove">×</button>
    `;
    row.querySelector(".skill-row-remove")!.addEventListener("click", () => {
      currentAgent!.apps = (currentAgent!.apps || []).filter((id) => id !== appId);
      renderAgentAppsList();
    });
    list.appendChild(row);
  }
}

function showAgentAppsAddPicker(): void {
  if (!currentAgent) return;
  const selected = new Set(currentAgent.apps || []);
  const available = agentAppsCache.filter((a) => !selected.has(a.id));
  if (available.length === 0) { alert("No more apps to add. Create apps in Home → Apps."); return; }

  const menu = document.createElement("div");
  menu.className = "skill-row-picker";
  menu.style.cssText = "position:absolute;z-index:100;background:var(--surface);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 12px var(--shadow);max-height:200px;overflow-y:auto;width:260px;";
  for (const app of available) {
    const item = document.createElement("div");
    item.style.cssText = "padding:6px 12px;cursor:pointer;font-size:13px;display:flex;justify-content:space-between;";
    item.innerHTML = `<span>${escapeHtml(app.name)}</span><span style="font-size:11px;color:var(--text-3);font-family:var(--font-mono);">${escapeHtml(app.id)}</span>`;
    item.addEventListener("click", () => {
      currentAgent!.apps = [...(currentAgent!.apps || []), app.id];
      renderAgentAppsList();
      menu.remove();
    });
    item.addEventListener("mouseenter", () => { item.style.background = "var(--hover)"; });
    item.addEventListener("mouseleave", () => { item.style.background = ""; });
    menu.appendChild(item);
  }
  const btn = $a("agent-apps-add");
  btn.style.position = "relative";
  btn.parentElement!.appendChild(menu);
  const close = (e: MouseEvent) => { if (!menu.contains(e.target as Node) && e.target !== btn) { menu.remove(); document.removeEventListener("mousedown", close); } };
  setTimeout(() => document.addEventListener("mousedown", close), 0);
}

function collectAgentAppsSelection(): string[] {
  return currentAgent?.apps || [];
}

async function loadAgentSkillsList(): Promise<void> {
  if (!currentAgent) return;
  if (agentSkillsCache.length === 0) {
    try {
      const skills = await window.yo.skillsListDetailed();
      agentSkillsCache = skills.map((s) => ({ name: s.name, description: s.description }));
    } catch { agentSkillsCache = []; }
  }
  renderAgentSkillsList();
}

function renderAgentSkillsList(): void {
  if (!currentAgent) return;
  const list = $a("agent-skills-list");
  list.innerHTML = "";
  const selected = currentAgent.skills || [];
  for (const skillName of selected) {
    const sk = agentSkillsCache.find((s) => s.name === skillName);
    const row = document.createElement("div");
    row.className = "skill-row";
    row.innerHTML = `
      <span style="font-size:13px;">${escapeHtml(sk?.name || skillName)}</span>
      ${sk?.description ? `<span style="font-size:11px;color:var(--text-3);margin-left:auto;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(sk.description)}</span>` : ""}
      <button class="skill-row-remove" title="Remove">×</button>
    `;
    row.querySelector(".skill-row-remove")!.addEventListener("click", () => {
      currentAgent!.skills = (currentAgent!.skills || []).filter((n) => n !== skillName);
      renderAgentSkillsList();
    });
    list.appendChild(row);
  }
}

function showAgentSkillsAddPicker(): void {
  if (!currentAgent) return;
  const selected = new Set(currentAgent.skills || []);
  const available = agentSkillsCache.filter((s) => !selected.has(s.name));
  if (available.length === 0) { alert("No more skills to add. Create skills in Home → Skills."); return; }

  const menu = document.createElement("div");
  menu.className = "skill-row-picker";
  menu.style.cssText = "position:absolute;z-index:100;background:var(--surface);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 12px var(--shadow);max-height:200px;overflow-y:auto;width:260px;";
  for (const sk of available) {
    const item = document.createElement("div");
    item.style.cssText = "padding:6px 12px;cursor:pointer;font-size:13px;";
    item.textContent = sk.name;
    item.addEventListener("click", () => {
      currentAgent!.skills = [...(currentAgent!.skills || []), sk.name];
      renderAgentSkillsList();
      menu.remove();
    });
    item.addEventListener("mouseenter", () => { item.style.background = "var(--hover)"; });
    item.addEventListener("mouseleave", () => { item.style.background = ""; });
    menu.appendChild(item);
  }
  const btn = $a("agent-skills-add");
  btn.style.position = "relative";
  btn.parentElement!.appendChild(menu);
  const close = (e: MouseEvent) => { if (!menu.contains(e.target as Node) && e.target !== btn) { menu.remove(); document.removeEventListener("mousedown", close); } };
  setTimeout(() => document.addEventListener("mousedown", close), 0);
}

function collectAgentSkillsSelection(): string[] {
  return currentAgent?.skills || [];
}

function switchAgentTab(tab: string): void {
  document.querySelectorAll<HTMLButtonElement>(".help-section[data-section='agents'] .app-detail-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
  document.querySelectorAll<HTMLDivElement>(".help-section[data-section='agents'] .app-tab-left").forEach((div) => {
    div.style.display = div.dataset.tab === tab ? "" : "none";
  });

  if (tab === "remote" && currentAgent?.type === "remote") {
    void loadRemoteGrid();
    startAgentMarketTimer();
    startAgentBalanceTimer();
  } else {
    stopAgentMarketTimer();
    stopAgentBalanceTimer();
  }
}

async function saveCurrentAgent(includeGuardrails = true, includeRemote = false): Promise<void> {
  if (!currentAgent) return;
  const newId = ($a<HTMLInputElement>("agent-detail-id")).value.trim() || currentAgent.id;
  const cfg: AgentDef = {
    ...currentAgent,
    id: newId,
    name: ($a<HTMLInputElement>("agent-detail-name")).value.trim() || currentAgent.name,
    role: ($a<HTMLInputElement>("agent-detail-role")).value.trim() || undefined,
    systemPrompt: ($a<HTMLTextAreaElement>("agent-detail-prompt")).value || undefined,
    joinable: ($a<HTMLInputElement>("agent-detail-joinable")).checked,
  };
  cfg.apps = collectAgentAppsSelection();
  cfg.skills = collectAgentSkillsSelection();
  if (includeGuardrails) {
    const num = (id: string) => {
      const v = ($a<HTMLInputElement>(id)).value.trim();
      return v ? Math.max(0, Number(v)) : undefined;
    };
    cfg.guardrails = {
      max_yos_per_turn: num("agent-guard-per-turn"),
      max_yos_per_session: num("agent-guard-per-session"),
      max_yos_per_day: num("agent-guard-per-day"),
      max_idle_minutes: num("agent-guard-max-idle"),
      max_concurrent_reservations: num("agent-guard-max-concurrent"),
    };
  }
  if (includeRemote || currentAgent.type === "remote") {
    cfg.remote = {
      ...(currentAgent.remote || {}),
      preferred_tier: ($a<HTMLSelectElement>("agent-remote-pref-tier")).value as AgentRemote["preferred_tier"],
      default_idle_minutes: Number(($a<HTMLInputElement>("agent-remote-default-idle")).value) || 30,
    };
  }
  // If id changed, remove the old file
  if (newId !== currentAgent.id) {
    if (!(await window.yo.agentsIdAvailable(newId))) {
      alert(`Slug "${newId}" already exists`);
      return;
    }
    await window.yo.agentsRemove(currentAgent.id);
  }
  const saved = await window.yo.agentsSave(cfg) as AgentDef;
  currentAgent = saved;
  // Refresh list cache
  agentsCache = (await window.yo.agentsList() as AgentDef[]) || [];
}

async function deleteCurrentAgent(): Promise<void> {
  if (!currentAgent) return;
  if (!confirm(`Delete agent "${currentAgent.name}"? This is permanent.`)) return;
  if (currentAgent.remote?.active_reservation_id) {
    if (!confirm("This agent has an active reservation. Release it first?")) return;
    await window.yo.reservationRelease(currentAgent.remote.active_reservation_id, "agent deleted");
  }
  await window.yo.agentsRemove(currentAgent.id);
  currentAgent = null;
  await loadAgents();
}

// ── Remote picker grid ──────────────────────────────────────

let lastMarketEntries: MarketEntry[] = [];

async function loadRemoteGrid(): Promise<void> {
  if (!currentAgent || currentAgent.type !== "remote") return;
  const tier = ($a<HTMLSelectElement>("agent-remote-pref-tier")).value;
  const opts: { tier?: string; limit: number } = { limit: 50 };
  if (tier && tier !== "any") opts.tier = tier;
  const r = await window.yo.marketplaceAvailable(opts);
  if ("error" in r) {
    const empty = $a("agent-remote-empty");
    empty.classList.remove("hidden");
    empty.textContent = `Error: ${r.error}`;
    $a("agent-remote-grid").innerHTML = "";
    return;
  }
  lastMarketEntries = r.entries as MarketEntry[];
  renderRemoteGrid();
}

function renderRemoteGrid(): void {
  const grid = $a("agent-remote-grid");
  const search = (($a<HTMLInputElement>("agent-remote-search")).value || "").toLowerCase();
  const filtered = lastMarketEntries.filter((e) =>
    !search || e.providers.some((p) => p.toLowerCase().includes(search)) || e.derived_tier.toLowerCase().includes(search) || e.offer_handle.toLowerCase().includes(search),
  );
  grid.innerHTML = "";
  $a("agent-remote-empty").classList.toggle("hidden", filtered.length > 0);

  for (const e of filtered) {
    const card = document.createElement("div");
    card.className = "connector-card";
    const tierColor = e.derived_tier === "premiere" ? "#a78bfa" : e.derived_tier === "standard" ? "#60a5fa" : "var(--text-2)";
    const priceLabel = e.pricing && e.pricing.terms === "rate" && e.pricing.yos_per_1k_output
      ? `${e.pricing.yos_per_1k_input}in / ${e.pricing.yos_per_1k_output}out yos·1k`
      : "free";
    const isReserved = currentAgent?.remote?.active_provider_handle === e.offer_handle;
    card.innerHTML = `
      <div class="connector-card-name">${escapeHtml(e.providers.join(", ") || "—")}</div>
      <div style="font-size:10px;color:${tierColor};text-transform:uppercase;letter-spacing:0.5px;margin-top:4px;">${e.derived_tier}</div>
      <div style="font-size:11px;color:var(--text-2);font-family:var(--font-mono);margin-top:4px;">${priceLabel}</div>
      <button class="action-btn ${isReserved ? "" : "primary"}" style="margin-top:8px;font-size:11px;padding:4px 8px;" ${isReserved ? "disabled" : ""}>${isReserved ? "Reserved" : "Reserve"}</button>
    `;
    const btn = card.querySelector("button")!;
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void reserveAgent(e);
    });
    grid.appendChild(card);
  }
}

async function reserveAgent(entry: MarketEntry): Promise<void> {
  if (!currentAgent || currentAgent.type !== "remote") return;
  if (currentAgent.remote?.active_reservation_id) {
    alert("This agent already holds a reservation. Release it first.");
    return;
  }
  const idleMin = Number(($a<HTMLInputElement>("agent-remote-default-idle")).value) || 30;
  // Confirm intent with rough cost preview
  const card = rateCardCache.find((c) => c.tier === entry.derived_tier);
  const escrow = card ? card.yos_per_idle_minute * idleMin : null;
  const ok = confirm(
    `Reserve a ${entry.derived_tier} agent for ${idleMin} minutes?\n` +
    (escrow !== null ? `This will escrow ~${escrow} yos as an idle hold (refunded if released early).` : ""),
  );
  if (!ok) return;
  const result = await window.yo.reservationCreate({
    provider_handle: entry.offer_handle,
    idle_minutes: idleMin,
    guardrails: currentAgent.guardrails,
  });
  if (!result.ok) {
    alert(`Reservation failed: ${result.error || "unknown error"}`);
    return;
  }
  // Persist on the agent
  currentAgent.remote = {
    ...(currentAgent.remote || {}),
    active_reservation_id: result.reservation!.id,
    active_provider_handle: entry.offer_handle,
  };
  await window.yo.agentsSave(currentAgent);
  await refreshYosBalanceLabel();
  renderRemoteGrid();
  void refreshActiveReservation();
}

async function refreshActiveReservation(): Promise<void> {
  const card = $a("agent-active-reservation");
  if (!currentAgent || currentAgent.type !== "remote" || !currentAgent.remote?.active_reservation_id) {
    card.classList.add("hidden");
    return;
  }
  const list = await window.yo.reservationList({});
  if ("error" in list) { card.classList.add("hidden"); return; }
  const rid = currentAgent.remote.active_reservation_id;
  const r = list.reservations.find((res) => res.id === rid);
  if (!r) {
    // No longer present (released or expired) — clear local state
    currentAgent.remote = { ...(currentAgent.remote || {}), active_reservation_id: undefined, active_provider_handle: undefined };
    await window.yo.agentsSave(currentAgent);
    card.classList.add("hidden");
    return;
  }
  if (r.status !== "reserved") {
    // Auto-released or expired server-side
    currentAgent.remote = { ...(currentAgent.remote || {}), active_reservation_id: undefined, active_provider_handle: undefined };
    await window.yo.agentsSave(currentAgent);
    card.classList.add("hidden");
    void refreshYosBalanceLabel();
    return;
  }
  const remaining = Math.max(0, Math.round((new Date(r.release_at).getTime() - Date.now()) / 60000));
  $a("agent-active-meta").textContent = `id ${r.id.slice(0, 8)} · budget ${r.idle_budget_yos} yos · expires in ~${remaining} min`;
  card.classList.remove("hidden");
}

async function releaseActiveReservation(): Promise<void> {
  if (!currentAgent?.remote?.active_reservation_id) return;
  if (!confirm("Release this reservation? Unused yos refund automatically.")) return;
  const result = await window.yo.reservationRelease(currentAgent.remote.active_reservation_id, "user released");
  if (!result.ok) { alert(`Release failed: ${result.error || "unknown error"}`); return; }
  currentAgent.remote = { ...(currentAgent.remote || {}), active_reservation_id: undefined, active_provider_handle: undefined };
  await window.yo.agentsSave(currentAgent);
  await refreshYosBalanceLabel();
  renderRemoteGrid();
  void refreshActiveReservation();
}

function updateTestCostEstimate(): void {
  // placeholder — execution wires up later
}

// ── Timers (poll while remote tab is open) ──────────────────

function startAgentMarketTimer(): void {
  if (agentMarketTimer) return;
  agentMarketTimer = setInterval(() => {
    void loadRemoteGrid();
    void refreshActiveReservation();
  }, 5000);
}
function stopAgentMarketTimer(): void {
  if (agentMarketTimer) { clearInterval(agentMarketTimer); agentMarketTimer = null; }
}
function startAgentBalanceTimer(): void {
  if (agentBalanceTimer) return;
  agentBalanceTimer = setInterval(() => { void refreshYosBalanceLabel(); }, 10000);
}
function stopAgentBalanceTimer(): void {
  if (agentBalanceTimer) { clearInterval(agentBalanceTimer); agentBalanceTimer = null; }
}


// ── Init ────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────

function initAgents(): void {
  const search = $a<HTMLInputElement>("agent-search");
  if (!search) return;
  search.addEventListener("input", () => renderAgentsList());
  $a("agent-add-btn").addEventListener("click", showAddAgentForm);
  $a("agent-add-cancel").addEventListener("click", () => { void loadAgents(); });
  $a("agent-add-cancel-btn").addEventListener("click", () => { void loadAgents(); });
  $a("agent-add-save").addEventListener("click", () => { void saveNewAgent(); });

  $a("agent-detail-close").addEventListener("click", () => { void loadAgents(); });
  $a("agent-detail-save").addEventListener("click", async () => { await saveCurrentAgent(); $a("agent-detail-heading").textContent = currentAgent?.name || ""; });
  $a("agent-detail-cancel").addEventListener("click", () => { if (currentAgentSnapshot) openAgentDetail(currentAgentSnapshot); });
  $a("agent-detail-delete").addEventListener("click", () => { void deleteCurrentAgent(); });

  $a("agent-apps-add").addEventListener("click", () => showAgentAppsAddPicker());
  $a("agent-skills-add").addEventListener("click", () => showAgentSkillsAddPicker());

  $a("agent-remote-refresh").addEventListener("click", () => { void loadRemoteGrid(); });
  $a("agent-remote-search").addEventListener("input", () => renderRemoteGrid());
  $a("agent-remote-pref-tier").addEventListener("change", () => { void loadRemoteGrid(); });
  $a("agent-release-btn").addEventListener("click", () => { void releaseActiveReservation(); });

  document.querySelectorAll<HTMLButtonElement>(".help-section[data-section='agents'] .app-detail-tab").forEach((btn) => {
    btn.addEventListener("click", () => switchAgentTab(btn.dataset.tab!));
  });
}

export { loadAgents, initAgents };
