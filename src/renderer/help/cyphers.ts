/**
 * Cyphers section — list, discover, join modal, create/edit form, detail.
 */

import { $a, escapeHtml, formatYos, confirmAction } from "./shared.js";
import type { AgentDef } from "./agents.js";

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

// ── Load + render ─────────────────────────────────────────────

async function loadCyphers(): Promise<void> {
  const r = await window.yo.cypherListMine();
  cyphersCache = "error" in r ? [] : (r.cyphers as CypherListItem[]);
  await refreshCypherYosBalance();
  renderCyphersList();
  $a("cyphers-list").classList.remove("hidden");
  $a("cypher-form").classList.add("hidden");
  $a("cypher-detail").classList.add("hidden");
  $a("cypher-tabs").classList.remove("hidden");
  $a("cypher-mine-view").classList.remove("hidden");
  switchCypherTab(currentCypherTab);
  stopCypherDetailPoll();
}

// ── Mine / Discover tab switching ─────────────────────────────

let currentCypherTab: "mine" | "discover" = "mine";
let discoverPollTimer: ReturnType<typeof setInterval> | null = null;

function switchCypherTab(tab: "mine" | "discover"): void {
  currentCypherTab = tab;
  document.querySelectorAll<HTMLButtonElement>(".help-section[data-section='cyphers'] [data-cypher-tab]").forEach((btn) => {
    const active = btn.dataset.cypherTab === tab;
    btn.classList.toggle("active", active);
    btn.style.borderBottom = active ? "2px solid var(--accent)" : "2px solid transparent";
  });
  const showingForm = !$a("cypher-form").classList.contains("hidden");
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

// ── Discover ──────────────────────────────────────────────────

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
    list.innerHTML = `<div class="crud-empty">${discoverCache.length === 0 ? "No live cyphers right now. Check back soon." : "No cyphers match your filters."}</div>`;
    return;
  }
  for (const c of filtered) {
    const card = document.createElement("div");
    card.className = "crud-card";
    const typeBadge =
      c.type === "bounty" ? "bounty" :
      c.type === "coop" ? "co-op" :
      c.type === "sponsored" ? "sponsored" : "open";
    card.innerHTML = `
      <div class="crud-card-info">
        <span class="crud-card-name">${escapeHtml(c.title)} <span class="skill-pill" style="background:var(--accent);color:var(--bg);">LIVE</span> <span class="skill-pill">${typeBadge}</span></span>
        <span class="crud-card-meta">${escapeHtml(c.slug)}${c.max_jammers != null ? ` · max ${c.max_jammers} jammers` : ""}${c.description ? ` — ${escapeHtml(c.description.slice(0, 80))}` : ""}</span>
      </div>
      <div class="crud-card-actions">
        <button class="crud-card-btn crud-edit-btn" title="Join">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>
        </button>
      </div>`;
    card.querySelector(".crud-edit-btn")!.addEventListener("click", (e) => {
      e.stopPropagation();
      void openJoinModal(c.id);
    });
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

// ── Join modal ────────────────────────────────────────────────

let joinTargetCypherId: string | null = null;
let joinSelectedAgentId: string | null = null;

async function openJoinModal(cypherId: string): Promise<void> {
  joinTargetCypherId = cypherId;
  joinSelectedAgentId = null;
  $a("cypher-join-error").classList.add("hidden");
  ($a<HTMLSelectElement>("cypher-join-role")).value = "jammer";
  $a("cypher-join-modal").style.display = "flex";

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

  const reqEl = $a("cypher-join-requirements");
  const reqs = c.requirements || {};
  const reqLines: string[] = [];
  if (reqs.skills?.length) reqLines.push(`<b>Skills:</b> ${reqs.skills.join(", ")}`);
  if (reqs.apps?.length) reqLines.push(`<b>Apps:</b> ${reqs.apps.join(", ")}`);
  if (reqs.mcp_servers?.length) reqLines.push(`<b>MCP:</b> ${reqs.mcp_servers.join(", ")}`);
  if (reqs.model_provider) reqLines.push(`<b>Provider:</b> ${reqs.model_provider}`);
  if (reqs.min_tier) reqLines.push(`<b>Min tier:</b> ${reqs.min_tier}`);
  reqEl.innerHTML = reqLines.length ? `<div style="padding:8px;background:var(--bg-2);border-radius:4px;">${reqLines.join(" · ")}</div>` : "";

  const myAgents = (mineRes as AgentDef[]) || [];
  const list = $a("cypher-join-agent-list");
  list.innerHTML = "";
  if (myAgents.length === 0) {
    list.innerHTML = `<div class="crud-empty">No agents in your registry. Create one in Home → Agents first.</div>`;
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
  // Optional invite token — accept either the raw JWT or a full invite URL.
  // URL format we mint: yosup://cypher-invite?token=<JWT>  (the joiner can
  // paste either; we strip the URL wrapper if present).
  const rawInvite = ($a<HTMLInputElement>("cypher-join-invite-token")).value.trim();
  let inviteToken: string | undefined;
  if (rawInvite) {
    const m = rawInvite.match(/[?&]token=([^&\s]+)/);
    inviteToken = m ? decodeURIComponent(m[1]) : rawInvite;
  }
  const r = await window.yo.cypherJoin(joinTargetCypherId, joinSelectedAgentId, role, inviteToken);
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

// ── Yos balance display ───────────────────────────────────────

async function refreshCypherYosBalance(): Promise<void> {
  const el = $a("cypher-yos-balance");
  if (!el) return;
  const r = await window.yo.yosBalance();
  el.textContent = "error" in r ? "— yos" : formatYos(r.balance);
}

// ── Mine list (crud-card pattern) ─────────────────────────────

function renderCyphersList(): void {
  const list = $a("cyphers-list");
  const search = ($a<HTMLInputElement>("cypher-search").value || "").toLowerCase();
  list.innerHTML = "";

  const filtered = cyphersCache.filter((c) =>
    !search || c.title.toLowerCase().includes(search) || c.slug.toLowerCase().includes(search) || c.type.toLowerCase().includes(search),
  );

  if (filtered.length === 0) {
    list.innerHTML = `<div class="crud-empty">${cyphersCache.length === 0 ? 'No cyphers yet. Click "+ New" to host one.' : "No cyphers match your search."}</div>`;
    return;
  }

  for (const c of filtered) {
    const statusColor =
      c.status === "live" ? "var(--accent)" :
      c.status === "wrapped" ? "var(--text-2)" :
      c.status === "cancelled" ? "var(--danger)" : "var(--text-3)";
    const statusPill = `<span class="skill-pill" style="background:${statusColor};color:var(--bg);">${c.status}</span>`;
    const typePill = `<span class="skill-pill">${c.type}</span>`;

    const card = document.createElement("div");
    card.className = "crud-card";
    card.innerHTML = `
      <div class="crud-card-info">
        <span class="crud-card-name">${escapeHtml(c.title)} ${statusPill} ${typePill}</span>
        <span class="crud-card-meta">${escapeHtml(c.slug)} · ${c.visibility}</span>
      </div>
      <div class="crud-card-actions">
        <button class="crud-card-btn crud-edit-btn" title="Edit">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
        </button>
        <button class="crud-card-btn danger crud-delete-btn" title="Cancel cypher">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
        </button>
      </div>`;

    card.querySelector(".crud-edit-btn")!.addEventListener("click", (e) => {
      e.stopPropagation();
      void openCypherEdit(c.id);
    });
    card.querySelector(".crud-delete-btn")!.addEventListener("click", async (e) => {
      e.stopPropagation();
      const confirmed = await confirmAction(`Cancel cypher "${c.title}"? All contributors get full refunds.`);
      if (!confirmed) return;
      const r = await window.yo.cypherCancel(c.id);
      if (!r.ok) { alert((r as any).error || "Cancel failed"); return; }
      await refreshCypherYosBalance();
      await loadCyphers();
    });
    card.addEventListener("click", () => { void openCypherEdit(c.id); });
    list.appendChild(card);
  }
}

// ── Create form ───────────────────────────────────────────────

let editingCypherId: string | null = null;

function showCreateForm(): void {
  editingCypherId = null;
  $a("cyphers-list").classList.add("hidden");
  $a("cypher-detail").classList.add("hidden");
  $a("cypher-tabs").classList.add("hidden");
  $a("cypher-mine-view").classList.add("hidden");
  $a("cypher-discover-view").classList.add("hidden");
  $a("cypher-form").classList.remove("hidden");
  $a("cypher-form-heading").textContent = "New cypher";

  ($a<HTMLInputElement>("cypher-form-title")).value = "";
  ($a<HTMLInputElement>("cypher-form-goal")).value = "";
  ($a<HTMLTextAreaElement>("cypher-form-description")).value = "";
  ($a<HTMLSelectElement>("cypher-form-type")).value = "open";
  ($a<HTMLSelectElement>("cypher-form-visibility")).value = "public";
  ($a<HTMLSelectElement>("cypher-form-sensitivity")).value = "internal";
  ($a<HTMLInputElement>("cypher-form-req-skills")).value = "";
  ($a<HTMLInputElement>("cypher-form-req-apps")).value = "";
  ($a<HTMLSelectElement>("cypher-form-req-tier")).value = "";
  ($a<HTMLInputElement>("cypher-form-max-jammers")).value = "";
  ($a<HTMLInputElement>("cypher-form-kitty-amount")).value = "1000";
  $a("cypher-form-error").classList.add("hidden");
  $a("cypher-form-delete").classList.add("hidden");
  $a("cypher-form-kitty-section").classList.remove("hidden");
  $a("cypher-form-save").textContent = "Publish cypher";
  updateCypherKittyHint();
}

// ── Edit form (loads existing cypher into same form) ──────────

async function openCypherEdit(cypherId: string): Promise<void> {
  const r = await window.yo.cypherGet(cypherId);
  if ("error" in r) { alert(r.error); return; }
  const c = r.cypher as CypherDetail;
  editingCypherId = c.id;
  currentCypher = c;
  currentCypherKitty = r.kitty_balance;

  $a("cyphers-list").classList.add("hidden");
  $a("cypher-detail").classList.add("hidden");
  $a("cypher-tabs").classList.add("hidden");
  $a("cypher-mine-view").classList.add("hidden");
  $a("cypher-discover-view").classList.add("hidden");
  $a("cypher-form").classList.remove("hidden");
  $a("cypher-form-heading").textContent = c.title;

  ($a<HTMLInputElement>("cypher-form-title")).value = c.title;
  ($a<HTMLInputElement>("cypher-form-goal")).value = c.goal || "";
  ($a<HTMLTextAreaElement>("cypher-form-description")).value = c.description || "";
  ($a<HTMLSelectElement>("cypher-form-type")).value = c.type;
  ($a<HTMLSelectElement>("cypher-form-visibility")).value = c.visibility;
  ($a<HTMLSelectElement>("cypher-form-sensitivity")).value = c.sensitivity;
  ($a<HTMLInputElement>("cypher-form-req-skills")).value = (c.requirements?.skills || []).join(", ");
  ($a<HTMLInputElement>("cypher-form-req-apps")).value = (c.requirements?.apps || []).join(", ");
  ($a<HTMLSelectElement>("cypher-form-req-tier")).value = c.requirements?.min_tier || "";
  ($a<HTMLInputElement>("cypher-form-max-jammers")).value = c.max_jammers != null ? String(c.max_jammers) : "";
  ($a<HTMLInputElement>("cypher-form-kitty-amount")).value = "";
  $a("cypher-form-error").classList.add("hidden");
  $a("cypher-form-delete").classList.remove("hidden");
  $a("cypher-form-kitty-section").classList.add("hidden");
  $a("cypher-form-save").textContent = "Save";

  // Show detail link for live cyphers
  const detailLink = $a("cypher-form-detail-link");
  if (c.status === "live") {
    detailLink.classList.remove("hidden");
  } else {
    detailLink.classList.add("hidden");
  }
}

// ── Save (create or update) ───────────────────────────────────

function parseCsvList(s: string): string[] | undefined {
  const arr = s.split(",").map((x) => x.trim()).filter(Boolean);
  return arr.length ? arr : undefined;
}

function updateCypherKittyHint(): void {
  const type = ($a<HTMLSelectElement>("cypher-form-type")).value;
  const hint = $a("cypher-form-kitty-hint");
  if (type === "bounty") hint.textContent = "Bounty cyphers must pre-fund > 0.";
  else if (type === "coop") hint.textContent = "Co-op: each joiner contributes equally; this is your share.";
  else if (type === "sponsored") hint.textContent = "You're the sponsor — fund what jammers will draw down.";
  else hint.textContent = "Anyone can add to the kitty after publish.";
}

async function saveCypher(): Promise<void> {
  const errEl = $a("cypher-form-error");
  errEl.classList.add("hidden");
  const title = ($a<HTMLInputElement>("cypher-form-title")).value.trim();
  if (!title) { errEl.textContent = "Title required"; errEl.classList.remove("hidden"); return; }

  const type = ($a<HTMLSelectElement>("cypher-form-type")).value;
  const visibility = ($a<HTMLSelectElement>("cypher-form-visibility")).value;
  const sensitivity = ($a<HTMLSelectElement>("cypher-form-sensitivity")).value;
  const goal = ($a<HTMLInputElement>("cypher-form-goal")).value.trim() || undefined;
  const description = ($a<HTMLTextAreaElement>("cypher-form-description")).value.trim() || undefined;
  const maxJammers = Number(($a<HTMLInputElement>("cypher-form-max-jammers")).value);
  const tierReq = ($a<HTMLSelectElement>("cypher-form-req-tier")).value || undefined;
  const requirements: Record<string, unknown> = {};
  const skills = parseCsvList(($a<HTMLInputElement>("cypher-form-req-skills")).value);
  const apps = parseCsvList(($a<HTMLInputElement>("cypher-form-req-apps")).value);
  if (skills) requirements.skills = skills;
  if (apps) requirements.apps = apps;
  if (tierReq) requirements.min_tier = tierReq;

  if (editingCypherId) {
    // Update existing
    const r = await window.yo.cypherUpdate(editingCypherId, {
      title, goal, description, type, visibility, sensitivity,
      max_jammers: Number.isFinite(maxJammers) && maxJammers > 0 ? maxJammers : null,
      requirements,
    });
    if (!r.ok) {
      errEl.textContent = r.error || "Update failed";
      errEl.classList.remove("hidden");
      return;
    }
  } else {
    // Create + publish
    const kittyAmount = Math.max(0, Number(($a<HTMLInputElement>("cypher-form-kitty-amount")).value) || 0);
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
    const pub = await window.yo.cypherPublish(create.cypher.id, { initial_kitty_deposit: kittyAmount });
    if (!pub.ok) {
      errEl.textContent = pub.error || "Publish failed";
      errEl.classList.remove("hidden");
      return;
    }
  }

  await loadCyphers();
}

async function deleteCypher(): Promise<void> {
  if (!editingCypherId || !currentCypher) return;
  const confirmed = await confirmAction(`Cancel cypher "${currentCypher.title}"? All contributors get full refunds.`);
  if (!confirmed) return;
  const r = await window.yo.cypherCancel(editingCypherId);
  if (!r.ok) { alert((r as any).error || "Cancel failed"); return; }
  await refreshCypherYosBalance();
  await loadCyphers();
}

// ── Detail view (live cypher monitoring) ──────────────────────

async function openCypherDetail(cypherId: string): Promise<void> {
  const r = await window.yo.cypherGet(cypherId);
  if ("error" in r) { alert(r.error); return; }
  currentCypher = r.cypher as CypherDetail;
  currentCypherKitty = r.kitty_balance;

  $a("cyphers-list").classList.add("hidden");
  $a("cypher-form").classList.add("hidden");
  $a("cypher-tabs").classList.add("hidden");
  $a("cypher-mine-view").classList.add("hidden");
  $a("cypher-discover-view").classList.add("hidden");
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
    jammersEl.innerHTML = `<span style="color:var(--text-2);">No jammers yet.</span>`;
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
    eventsEl.innerHTML = `<span style="color:var(--text-2);">No events yet.</span>`;
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
  const confirmed = await confirmAction(`Wrap "${currentCypher.title}"? Remaining kitty refunds pro-rata to contributors.`);
  if (!confirmed) return;
  const r = await window.yo.cypherWrap(currentCypher.id);
  if (!r.ok) { alert(r.error || "Wrap failed"); return; }
  await refreshCypherYosBalance();
  await openCypherDetail(currentCypher.id);
}

async function mintInviteForCurrent(): Promise<void> {
  if (!currentCypher) return;
  const r = await window.yo.cypherInviteMint(currentCypher.id, { multi_use: true });
  if (!r.ok || !r.token) { alert(r.error || "Failed to mint invite"); return; }
  const url = `yosup://cypher-invite?token=${encodeURIComponent(r.token)}`;
  await navigator.clipboard.writeText(url);
  alert("Invite link copied to clipboard");
}

async function cancelCurrentCypher(): Promise<void> {
  if (!currentCypher) return;
  const confirmed = await confirmAction(`Cancel "${currentCypher.title}"? All contributors get full refunds.`);
  if (!confirmed) return;
  const r = await window.yo.cypherCancel(currentCypher.id);
  if (!r.ok) { alert(r.error || "Cancel failed"); return; }
  await refreshCypherYosBalance();
  await loadCyphers();
}

// ── Init ──────────────────────────────────────────────────────

function initCyphers(): void {
  const search = $a<HTMLInputElement>("cypher-search");
  if (!search) return;
  search.addEventListener("input", () => renderCyphersList());

  // New button
  $a("cypher-new-btn").addEventListener("click", showCreateForm);

  // Form actions
  $a("cypher-form-back").addEventListener("click", () => { void loadCyphers(); });
  $a("cypher-form-cancel").addEventListener("click", () => { void loadCyphers(); });
  $a("cypher-form-save").addEventListener("click", () => { void saveCypher(); });
  $a("cypher-form-delete").addEventListener("click", () => { void deleteCypher(); });
  $a("cypher-form-type").addEventListener("change", updateCypherKittyHint);
  $a("cypher-form-detail-link").addEventListener("click", () => {
    if (editingCypherId) void openCypherDetail(editingCypherId);
  });

  // Detail actions
  $a("cypher-detail-close").addEventListener("click", () => { void loadCyphers(); });
  $a("cypher-detail-deposit-btn").addEventListener("click", () => { void depositToCypherKitty(); });
  $a("cypher-detail-wrap").addEventListener("click", () => { void wrapCurrentCypher(); });
  $a("cypher-detail-cancel-cypher").addEventListener("click", () => { void cancelCurrentCypher(); });
  $a("cypher-detail-invite").addEventListener("click", () => { void mintInviteForCurrent(); });

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
