/**
 * Cyphers section — list, discover, join modal, publish, detail.
 */

import { $a, escapeHtml, formatYos, closeHelp } from "./shared.js";
import type { AgentDef } from "./agents.js";

// ─────────────────────────────────────────────────────────────────────
// Cyphers — collaborative gatherings of agents
// Mirrors Agents/Apps section structure: list+search, inline form, detail
// view with kitty/jammers/events. The publish form doubles as create form
// (a draft is created on save and published in the same call).
// ─────────────────────────────────────────────────────────────────────

interface CypherListItem {
  id: string;
  slug: string;
  title: string;
  type: string;
  status: string;
  visibility: string;
  created_at: string;
  updated_at: string;
}

interface CypherDetail {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  goal: string | null;
  type: string;
  status: string;
  visibility: string;
  max_jammers: number | null;
  min_tier: string | null;
  requirements: { skills?: string[]; apps?: string[]; mcp_servers?: string[]; model_provider?: string; min_tier?: string };
  sensitivity: string;
  owner_user_id: string;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

let cyphersCache: CypherListItem[] = [];
let currentCypher: CypherDetail | null = null;
let currentCypherKitty = 0;
let cypherDetailPollTimer: ReturnType<typeof setInterval> | null = null;

async function loadCyphers(): Promise<void> {
  const r = await window.yo.cypherListMine();
  cyphersCache = "error" in r ? [] : (r.cyphers as CypherListItem[]);
  await refreshCypherYosBalance();
  renderCyphersList();
  $a("cyphers-list").classList.remove("hidden");
  $a("cypher-publish-form").classList.add("hidden");
  $a("cypher-detail").classList.add("hidden");
  $a("cypher-search").parentElement?.parentElement?.classList.remove("hidden");
  // Show whichever tab the user last had open (default: Mine).
  switchCypherTab(currentCypherTab);
  stopCypherDetailPoll();
}

// ── Mine / Discover tab switching ───────────────────────────

let currentCypherTab: "mine" | "discover" = "mine";
let discoverPollTimer: ReturnType<typeof setInterval> | null = null;

function switchCypherTab(tab: "mine" | "discover"): void {
  currentCypherTab = tab;
  document.querySelectorAll<HTMLButtonElement>(".help-section[data-section='cyphers'] [data-cypher-tab]").forEach((btn) => {
    const active = btn.dataset.cypherTab === tab;
    btn.classList.toggle("active", active);
    btn.style.borderBottom = active ? "2px solid var(--accent)" : "2px solid transparent";
  });
  // The publish form / detail can be open in either context — only swap the *list* views.
  const showingForm = !$a("cypher-publish-form").classList.contains("hidden");
  const showingDetail = !$a("cypher-detail").classList.contains("hidden");
  if (showingForm || showingDetail) return;
  $a("cypher-mine-view").classList.toggle("hidden", tab !== "mine");
  $a("cypher-discover-view").classList.toggle("hidden", tab !== "discover");
  if (tab === "discover") {
    void loadDiscoverCyphers();
    startDiscoverPoll();
  } else {
    stopDiscoverPoll();
  }
}

let discoverCache: Array<{
  id: string; slug: string; title: string; description: string | null;
  type: string; status: string; visibility: string; max_jammers: number | null;
  created_at: string;
}> = [];

async function loadDiscoverCyphers(): Promise<void> {
  const typeFilter = ($a<HTMLSelectElement>("cypher-discover-type").value || undefined);
  const r = await window.yo.cypherDiscover({ status: "live", type: typeFilter });
  discoverCache = "error" in r ? [] : (r.cyphers as typeof discoverCache);
  renderDiscoverList();
}

function renderDiscoverList(): void {
  const list = $a("cypher-discover-list");
  const search = ($a<HTMLInputElement>("cypher-discover-search").value || "").toLowerCase();
  list.innerHTML = "";
  const filtered = discoverCache.filter((c) =>
    !search ||
    c.title.toLowerCase().includes(search) ||
    (c.description || "").toLowerCase().includes(search) ||
    c.slug.toLowerCase().includes(search) ||
    c.type.toLowerCase().includes(search),
  );
  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "padding:48px 16px;text-align:center;color:var(--text-2);font-size:13px;";
    empty.textContent = discoverCache.length === 0
      ? "No live cyphers right now. Check back soon."
      : "No cyphers match your filters.";
    list.appendChild(empty);
    return;
  }
  for (const c of filtered) {
    const card = document.createElement("div");
    card.className = "app-card";
    card.style.position = "relative";
    const initial = (c.title || c.slug).slice(0, 1).toUpperCase();
    const typeBadgeColor =
      c.type === "bounty" ? "#a78bfa" :
      c.type === "coop" ? "#60a5fa" :
      c.type === "sponsored" ? "#fb923c" :
      "var(--accent)";
    card.innerHTML = `
      <div style="position:absolute;top:8px;right:8px;display:flex;align-items:center;gap:4px;font-size:9px;color:var(--accent);">
        <span style="width:6px;height:6px;border-radius:50%;background:var(--accent);animation:cw-dot-pulse 1.2s ease-in-out infinite;"></span>
        LIVE
      </div>
      <div class="app-card-icon"><div class="app-card-initial">${escapeHtml(initial)}</div></div>
      <div class="app-card-name">${escapeHtml(c.title)}</div>
      <div class="app-card-id">${escapeHtml(c.slug)}</div>
      <div style="font-size:9px;letter-spacing:0.5px;text-transform:uppercase;margin-top:6px;color:${typeBadgeColor};">${c.type}${c.max_jammers != null ? ` · max ${c.max_jammers}` : ""}</div>
      ${c.description ? `<div style="font-size:11px;color:var(--text-2);margin-top:6px;line-height:1.4;max-height:36px;overflow:hidden;">${escapeHtml(c.description)}</div>` : ""}
    `;
    card.addEventListener("click", () => { void openJoinModal(c.id); });
    list.appendChild(card);
  }
}

function startDiscoverPoll(): void {
  if (discoverPollTimer) return;
  discoverPollTimer = setInterval(() => { void loadDiscoverCyphers(); }, 5000);
}
function stopDiscoverPoll(): void {
  if (discoverPollTimer) { clearInterval(discoverPollTimer); discoverPollTimer = null; }
}

// ── Join modal ──────────────────────────────────────────────

let joinTargetCypherId: string | null = null;
let joinSelectedAgentId: string | null = null;

async function openJoinModal(cypherId: string): Promise<void> {
  joinTargetCypherId = cypherId;
  joinSelectedAgentId = null;
  $a("cypher-join-error").classList.add("hidden");
  ($a<HTMLSelectElement>("cypher-join-role")).value = "jammer";
  $a("cypher-join-modal").style.display = "flex";

  // Fetch cypher details + my agents in parallel
  const [cy, mineRes] = await Promise.all([
    window.yo.cypherGet(cypherId),
    window.yo.agentsList(),
  ]);
  if ("error" in cy) {
    $a("cypher-join-error").textContent = cy.error;
    $a("cypher-join-error").classList.remove("hidden");
    return;
  }
  const c = cy.cypher;
  $a("cypher-join-title").textContent = c.title;
  $a("cypher-join-meta").textContent = `slug: ${c.slug} · status: ${c.status}` + (c.goal ? ` · goal: ${c.goal}` : "");
  $a("cypher-join-type").textContent = c.type;
  $a("cypher-join-kitty").textContent = formatYos(cy.kitty_balance);
  $a("cypher-join-sensitivity").textContent = c.sensitivity;

  // Render requirements
  const reqEl = $a("cypher-join-requirements");
  const reqs = c.requirements || {};
  const reqLines: string[] = [];
  if (reqs.skills?.length) reqLines.push(`<b>Skills:</b> ${reqs.skills.join(", ")}`);
  if (reqs.apps?.length) reqLines.push(`<b>Apps:</b> ${reqs.apps.join(", ")}`);
  if (reqs.mcp_servers?.length) reqLines.push(`<b>MCP:</b> ${reqs.mcp_servers.join(", ")}`);
  if (reqs.model_provider) reqLines.push(`<b>Provider:</b> ${reqs.model_provider}`);
  if (reqs.min_tier) reqLines.push(`<b>Min tier:</b> ${reqs.min_tier}`);
  reqEl.innerHTML = reqLines.length ? `<div style="padding:8px;background:var(--bg-2);border-radius:4px;">${reqLines.join(" · ")}</div>` : "";

  // Render agent picker — show all agents but mark joinable status
  const myAgents = (mineRes as AgentDef[]) || [];
  const list = $a("cypher-join-agent-list");
  list.innerHTML = "";
  if (myAgents.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "padding:16px 8px;color:var(--text-2);font-size:12px;text-align:center;";
    empty.textContent = "No agents in your registry. Create one in Home → Agents first.";
    list.appendChild(empty);
    return;
  }

  const requiredSkills = new Set(reqs.skills || []);
  const requiredApps = new Set(reqs.apps || []);

  for (const a of myAgents) {
    const agentSkills = new Set(a.skills || []);
    const agentApps = new Set(a.apps || []);
    const missingSkills = [...requiredSkills].filter((s) => !agentSkills.has(s));
    const missingApps = [...requiredApps].filter((s) => !agentApps.has(s));
    const matches = a.joinable && missingSkills.length === 0 && missingApps.length === 0;

    const row = document.createElement("label");
    row.style.cssText = `padding:8px 12px;display:flex;align-items:center;gap:8px;cursor:${matches ? "pointer" : "not-allowed"};border:1px solid var(--border);border-radius:6px;${matches ? "" : "opacity:0.5;"}`;
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "cypher-join-agent";
    radio.value = a.id;
    radio.disabled = !matches;
    radio.style.margin = "0";
    radio.addEventListener("change", () => { if (radio.checked) joinSelectedAgentId = a.id; });

    const labelWrap = document.createElement("div");
    labelWrap.style.cssText = "flex:1;display:flex;flex-direction:column;gap:2px;";
    const name = document.createElement("span");
    name.style.cssText = "font-size:13px;color:var(--text);";
    name.textContent = `${a.name} (${a.type})`;
    const meta = document.createElement("span");
    meta.style.cssText = "font-size:10px;color:var(--text-3);font-family:var(--font-mono);";
    const metaParts: string[] = [];
    if (a.skills?.length) metaParts.push(`skills: ${a.skills.join(",")}`);
    if (a.apps?.length) metaParts.push(`apps: ${a.apps.join(",")}`);
    if (!a.joinable) metaParts.push("not joinable — turn on in Agents tab");
    if (matches === false && a.joinable) {
      const why: string[] = [];
      if (missingSkills.length) why.push(`needs ${missingSkills.join(",")}`);
      if (missingApps.length) why.push(`apps ${missingApps.join(",")}`);
      metaParts.push(`missing: ${why.join("; ")}`);
    }
    meta.textContent = metaParts.join(" · ") || "—";
    labelWrap.appendChild(name);
    labelWrap.appendChild(meta);
    row.appendChild(radio);
    row.appendChild(labelWrap);
    list.appendChild(row);
  }
}

function closeJoinModal(): void {
  $a("cypher-join-modal").style.display = "none";
  joinTargetCypherId = null;
  joinSelectedAgentId = null;
}

async function confirmJoinCypher(): Promise<void> {
  if (!joinTargetCypherId) return;
  if (!joinSelectedAgentId) {
    $a("cypher-join-error").textContent = "Pick an agent to join with";
    $a("cypher-join-error").classList.remove("hidden");
    return;
  }
  const role = ($a<HTMLSelectElement>("cypher-join-role")).value;
  const r = await window.yo.cypherJoin(joinTargetCypherId, joinSelectedAgentId, role);
  if (!r.ok) {
    $a("cypher-join-error").textContent = r.error || "Join failed";
    $a("cypher-join-error").classList.remove("hidden");
    return;
  }
  const id = joinTargetCypherId;
  closeJoinModal();
  await loadCyphers();
  await openCypherDetail(id);
}

async function refreshCypherYosBalance(): Promise<void> {
  const el = $a("cypher-yos-balance");
  if (!el) return;
  const r = await window.yo.yosBalance();
  el.textContent = "error" in r ? "— yos" : formatYos(r.balance);
}

function renderCyphersList(): void {
  const list = $a("cyphers-list");
  const search = ($a<HTMLInputElement>("cypher-search").value || "").toLowerCase();
  list.innerHTML = "";

  const filtered = cyphersCache.filter((c) =>
    !search || c.title.toLowerCase().includes(search) || c.slug.toLowerCase().includes(search) || c.type.toLowerCase().includes(search),
  );

  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "padding:32px 16px;text-align:center;color:var(--text-2);font-size:13px;";
    empty.textContent = cyphersCache.length === 0 ? `No cyphers yet. Click "+ New" to host one.` : "No cyphers match your search.";
    list.appendChild(empty);
    return;
  }

  for (const c of filtered) {
    const card = document.createElement("div");
    card.className = "app-card";
    const initial = (c.title || c.slug).slice(0, 1).toUpperCase();
    const statusColor = c.status === "live" ? "var(--accent)" : c.status === "wrapped" ? "var(--text-2)" : c.status === "cancelled" ? "var(--danger)" : "var(--text-3)";
    card.innerHTML = `
      <div class="app-card-icon"><div class="app-card-initial">${escapeHtml(initial)}</div></div>
      <div class="app-card-name">${escapeHtml(c.title)}</div>
      <div class="app-card-id">${escapeHtml(c.slug)}</div>
      <div style="font-size:9px;letter-spacing:0.5px;text-transform:uppercase;margin-top:4px;display:flex;gap:6px;">
        <span style="color:${statusColor};">${c.status}</span>
        <span style="color:var(--text-3);">·</span>
        <span style="color:var(--text-2);">${c.type}</span>
      </div>
    `;
    card.addEventListener("click", () => { void openCypherDetail(c.id); });
    list.appendChild(card);
  }
}

function showPublishForm(): void {
  $a("cyphers-list").classList.add("hidden");
  $a("cypher-detail").classList.add("hidden");
  $a("cypher-publish-form").classList.remove("hidden");
  ($a<HTMLInputElement>("cypher-publish-title")).value = "";
  ($a<HTMLInputElement>("cypher-publish-goal")).value = "";
  ($a<HTMLTextAreaElement>("cypher-publish-description")).value = "";
  ($a<HTMLSelectElement>("cypher-publish-type")).value = "open";
  ($a<HTMLSelectElement>("cypher-publish-visibility")).value = "public";
  ($a<HTMLSelectElement>("cypher-publish-sensitivity")).value = "internal";
  ($a<HTMLInputElement>("cypher-publish-req-skills")).value = "";
  ($a<HTMLInputElement>("cypher-publish-req-apps")).value = "";
  ($a<HTMLSelectElement>("cypher-publish-req-tier")).value = "";
  ($a<HTMLInputElement>("cypher-publish-max-jammers")).value = "";
  ($a<HTMLInputElement>("cypher-publish-kitty-amount")).value = "1000";
  $a("cypher-publish-error").classList.add("hidden");
  updateCypherKittyHint();
}

function updateCypherKittyHint(): void {
  const type = ($a<HTMLSelectElement>("cypher-publish-type")).value;
  const hint = $a("cypher-publish-kitty-hint");
  if (type === "bounty") hint.textContent = "Bounty cyphers must pre-fund > 0.";
  else if (type === "coop") hint.textContent = "Co-op: each joiner contributes equally; this is your share.";
  else if (type === "sponsored") hint.textContent = "You're the sponsor — fund what jammers will draw down.";
  else hint.textContent = "Anyone can add to the kitty after publish.";
}

function parseCsvList(s: string): string[] | undefined {
  const arr = s.split(",").map((x) => x.trim()).filter(Boolean);
  return arr.length ? arr : undefined;
}

async function publishNewCypher(): Promise<void> {
  const errEl = $a("cypher-publish-error");
  errEl.classList.add("hidden");
  const title = ($a<HTMLInputElement>("cypher-publish-title")).value.trim();
  if (!title) { errEl.textContent = "Title required"; errEl.classList.remove("hidden"); return; }
  const type = ($a<HTMLSelectElement>("cypher-publish-type")).value;
  const visibility = ($a<HTMLSelectElement>("cypher-publish-visibility")).value;
  const sensitivity = ($a<HTMLSelectElement>("cypher-publish-sensitivity")).value;
  const goal = ($a<HTMLInputElement>("cypher-publish-goal")).value.trim() || undefined;
  const description = ($a<HTMLTextAreaElement>("cypher-publish-description")).value.trim() || undefined;
  const maxJammers = Number(($a<HTMLInputElement>("cypher-publish-max-jammers")).value);
  const tierReq = ($a<HTMLSelectElement>("cypher-publish-req-tier")).value || undefined;
  const requirements: Record<string, unknown> = {};
  const skills = parseCsvList(($a<HTMLInputElement>("cypher-publish-req-skills")).value);
  const apps = parseCsvList(($a<HTMLInputElement>("cypher-publish-req-apps")).value);
  if (skills) requirements.skills = skills;
  if (apps) requirements.apps = apps;
  if (tierReq) requirements.min_tier = tierReq;

  const kittyAmount = Math.max(0, Number(($a<HTMLInputElement>("cypher-publish-kitty-amount")).value) || 0);

  const create = await window.yo.cypherCreate({
    title, goal, description, type, visibility, sensitivity,
    max_jammers: Number.isFinite(maxJammers) && maxJammers > 0 ? maxJammers : undefined,
    requirements,
    work_package: { kind: "blank" },
  });
  if (!create.ok || !create.cypher) {
    errEl.textContent = create.error || "Create failed";
    errEl.classList.remove("hidden");
    return;
  }

  const cypherId = create.cypher.id;
  const pub = await window.yo.cypherPublish(cypherId, kittyAmount);
  if (!pub.ok) {
    errEl.textContent = pub.error || "Publish failed";
    errEl.classList.remove("hidden");
    return;
  }

  await loadCyphers();
  await openCypherDetail(cypherId);
}

async function openCypherDetail(cypherId: string): Promise<void> {
  const r = await window.yo.cypherGet(cypherId);
  if ("error" in r) { alert(r.error); return; }
  currentCypher = r.cypher as CypherDetail;
  currentCypherKitty = r.kitty_balance;

  $a("cyphers-list").classList.add("hidden");
  $a("cypher-publish-form").classList.add("hidden");
  $a("cypher-detail").classList.remove("hidden");

  $a("cypher-detail-heading").textContent = currentCypher.title;
  const statusBadge = $a("cypher-detail-status-badge");
  statusBadge.textContent = currentCypher.status;
  statusBadge.style.color = currentCypher.status === "live" ? "var(--accent)" : currentCypher.status === "wrapped" ? "var(--text-2)" : currentCypher.status === "cancelled" ? "var(--danger)" : "var(--text-3)";
  $a("cypher-detail-type-badge").textContent = currentCypher.type;

  const meta: string[] = [
    `slug: ${currentCypher.slug}`,
    `visibility: ${currentCypher.visibility}`,
    `sensitivity: ${currentCypher.sensitivity}`,
  ];
  if (currentCypher.goal) meta.push(`goal: ${currentCypher.goal}`);
  if (currentCypher.max_jammers != null) meta.push(`max jammers: ${currentCypher.max_jammers}`);
  $a("cypher-detail-meta").textContent = meta.join(" · ");

  $a("cypher-detail-kitty").textContent = formatYos(currentCypherKitty);

  await refreshCypherDetail();
  startCypherDetailPoll();

  // Disable wrap/cancel for non-live or non-owner; we don't have user_id locally,
  // so we rely on server to reject — but visually grey out for non-live.
  const wrapBtn = $a<HTMLButtonElement>("cypher-detail-wrap");
  const cancelBtn = $a<HTMLButtonElement>("cypher-detail-cancel-cypher");
  if (currentCypher.status !== "live") {
    wrapBtn.disabled = true;
    cancelBtn.disabled = currentCypher.status === "wrapped" || currentCypher.status === "cancelled";
  } else {
    wrapBtn.disabled = false;
    cancelBtn.disabled = false;
  }
}

async function refreshCypherDetail(): Promise<void> {
  if (!currentCypher) return;

  const [jammersR, eventsR, kittyR] = await Promise.all([
    window.yo.cypherJammers(currentCypher.id),
    window.yo.cypherEventsList(currentCypher.id, { limit: 50 }),
    window.yo.cypherKittyBalance(currentCypher.id),
  ]);

  if (!("error" in kittyR)) {
    currentCypherKitty = kittyR.balance;
    $a("cypher-detail-kitty").textContent = formatYos(currentCypherKitty);
  }

  const jammers = "error" in jammersR ? [] : jammersR.jammers;
  $a("cypher-detail-jammers-count").textContent = String(jammers.filter((j) => !j.left_at).length);
  const jammersEl = $a("cypher-detail-jammers");
  jammersEl.innerHTML = "";
  if (jammers.length === 0) {
    jammersEl.textContent = "No jammers yet.";
  } else {
    for (const j of jammers) {
      const row = document.createElement("div");
      row.style.cssText = "padding:4px 0;display:flex;gap:8px;align-items:center;";
      const dot = document.createElement("span");
      dot.style.cssText = `width:6px;height:6px;border-radius:50%;background:${j.left_at ? "var(--text-faint)" : "var(--accent)"};`;
      const role = document.createElement("span");
      role.style.cssText = "font-size:9px;text-transform:uppercase;color:var(--text-3);min-width:54px;";
      role.textContent = j.role;
      const id = document.createElement("span");
      id.style.cssText = "color:var(--text);";
      id.textContent = `${j.user_id.slice(0, 8)} · ${j.agent_local_id}`;
      const status = document.createElement("span");
      status.style.cssText = "color:var(--text-3);margin-left:auto;font-size:10px;";
      status.textContent = j.left_at ? "left" : "active";
      row.appendChild(dot); row.appendChild(role); row.appendChild(id); row.appendChild(status);
      jammersEl.appendChild(row);
    }
  }

  const events = "error" in eventsR ? [] : eventsR.events;
  $a("cypher-detail-events-count").textContent = String(events.length);
  const eventsEl = $a("cypher-detail-events");
  eventsEl.innerHTML = "";
  if (events.length === 0) {
    eventsEl.textContent = "No events yet.";
  } else {
    for (const e of events.slice().reverse()) {
      const row = document.createElement("div");
      row.style.cssText = "padding:2px 0;display:flex;gap:8px;font-size:11px;";
      const seq = document.createElement("span");
      seq.style.cssText = "color:var(--text-3);min-width:40px;";
      seq.textContent = `#${e.seq}`;
      const kind = document.createElement("span");
      kind.style.cssText = "color:var(--accent);min-width:80px;text-transform:uppercase;font-size:9px;letter-spacing:0.5px;";
      kind.textContent = e.kind;
      const by = document.createElement("span");
      by.style.cssText = "color:var(--text-2);min-width:140px;";
      by.textContent = e.by_agent_id || (e.by_user_id ? e.by_user_id.slice(0, 8) : "system");
      const payloadStr = (() => {
        try { return JSON.stringify(e.payload).slice(0, 120); } catch { return ""; }
      })();
      const body = document.createElement("span");
      body.style.cssText = "color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      body.textContent = payloadStr;
      row.appendChild(seq); row.appendChild(kind); row.appendChild(by); row.appendChild(body);
      eventsEl.appendChild(row);
    }
  }
}

function startCypherDetailPoll(): void {
  if (cypherDetailPollTimer) return;
  cypherDetailPollTimer = setInterval(() => { void refreshCypherDetail(); }, 5000);
}

function stopCypherDetailPoll(): void {
  if (cypherDetailPollTimer) { clearInterval(cypherDetailPollTimer); cypherDetailPollTimer = null; }
}

async function depositToCypherKitty(): Promise<void> {
  if (!currentCypher) return;
  const amount = Math.max(0, Number(($a<HTMLInputElement>("cypher-detail-deposit-amount")).value) || 0);
  const status = $a("cypher-detail-deposit-status");
  if (amount <= 0) { status.textContent = "Amount must be > 0"; return; }
  const r = await window.yo.cypherKittyDeposit(currentCypher.id, amount);
  if (!r.ok) { status.textContent = r.error || "Deposit failed"; return; }
  status.textContent = `Deposited. Balance: ${formatYos(r.kitty_balance ?? 0)}`;
  ($a<HTMLInputElement>("cypher-detail-deposit-amount")).value = "";
  await refreshCypherYosBalance();
  await refreshCypherDetail();
}

async function wrapCurrentCypher(): Promise<void> {
  if (!currentCypher) return;
  if (!confirm(`Wrap "${currentCypher.title}"? Remaining kitty refunds pro-rata to contributors.`)) return;
  const r = await window.yo.cypherWrap(currentCypher.id);
  if (!r.ok) { alert(r.error || "Wrap failed"); return; }
  alert(`Wrapped. ${r.refunds?.length ?? 0} refund(s) issued.`);
  await refreshCypherYosBalance();
  await openCypherDetail(currentCypher.id);
}

async function cancelCurrentCypher(): Promise<void> {
  if (!currentCypher) return;
  if (!confirm(`Cancel "${currentCypher.title}"? All contributors get full refunds.`)) return;
  const r = await window.yo.cypherCancel(currentCypher.id);
  if (!r.ok) { alert(r.error || "Cancel failed"); return; }
  await refreshCypherYosBalance();
  await loadCyphers();
}

function initCyphers(): void {
  const search = $a<HTMLInputElement>("cypher-search");
  if (!search) return;
  search.addEventListener("input", () => renderCyphersList());
  $a("cypher-new-btn").addEventListener("click", showPublishForm);
  $a("cypher-publish-cancel").addEventListener("click", () => { void loadCyphers(); });
  $a("cypher-publish-cancel-btn").addEventListener("click", () => { void loadCyphers(); });
  $a("cypher-publish-save").addEventListener("click", () => { void publishNewCypher(); });
  $a("cypher-publish-type").addEventListener("change", updateCypherKittyHint);

  $a("cypher-detail-close").addEventListener("click", () => { void loadCyphers(); });
  $a("cypher-detail-deposit-btn").addEventListener("click", () => { void depositToCypherKitty(); });
  $a("cypher-detail-wrap").addEventListener("click", () => { void wrapCurrentCypher(); });
  $a("cypher-detail-cancel-cypher").addEventListener("click", () => { void cancelCurrentCypher(); });

  // Mine / Discover tab toggle
  $a("cypher-tab-mine").addEventListener("click", () => switchCypherTab("mine"));
  $a("cypher-tab-discover").addEventListener("click", () => switchCypherTab("discover"));

  // Discover view controls
  $a("cypher-discover-search").addEventListener("input", () => renderDiscoverList());
  $a("cypher-discover-type").addEventListener("change", () => { void loadDiscoverCyphers(); });
  $a("cypher-discover-refresh").addEventListener("click", () => { void loadDiscoverCyphers(); });

  // Join modal
  $a("cypher-join-close").addEventListener("click", closeJoinModal);
  $a("cypher-join-cancel").addEventListener("click", closeJoinModal);
  $a("cypher-join-confirm").addEventListener("click", () => { void confirmJoinCypher(); });
  $a("cypher-join-modal").addEventListener("click", (e) => {
    if (e.target === $a("cypher-join-modal")) closeJoinModal();
  });
}


export { loadCyphers, initCyphers };
