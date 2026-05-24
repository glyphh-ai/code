/**
 * Vibes section — persisted vibe-coding projects.
 *
 * A flat list + search + inline detail, mirroring the Agents section. Each vibe
 * is a project under ~/yo/vibes/<id>/ (meta.json + plan.md + CLAUDE.md + code/).
 * "Open workspace" binds the vibe panel to the vibe by id and closes the home
 * overlay; the panel reloads so its agent re-spawns in the vibe's code dir.
 */

import { $a, escapeHtml, paginate, renderPaginationBar, confirmAction } from "./shared.js";
import { closeHelp } from "./shared.js";

export interface VibeDef {
  id: string;
  name: string;
  description?: string;
  status?: "active" | "paused" | "completed";
  createdAt?: string;
  updatedAt?: string;
}

const DELETE_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`;
const OPEN_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>`;

let vibesCache: VibeDef[] = [];
let vibesPage = 1;
let current: VibeDef | null = null;   // vibe being viewed; null when not in detail
let isNew = false;

// ── List ────────────────────────────────────────────────────

async function loadVibes(): Promise<void> {
  vibesCache = ((await window.yo.vibesList()) as unknown as VibeDef[]) || [];
  $a("vibes-toolbar").classList.remove("hidden");
  $a("vibes-list").classList.remove("hidden");
  $a("vibe-detail").classList.add("hidden");
  current = null;
  renderVibesList();
}

function renderVibesList(): void {
  const list = $a("vibes-list");
  const search = ($a<HTMLInputElement>("vibe-search").value || "").toLowerCase().trim();
  list.innerHTML = "";

  if (vibesCache.length === 0) {
    list.innerHTML = `<div class="crud-empty">No vibes yet. Click "+ New" to start one.</div>`;
    return;
  }
  const filtered = vibesCache.filter((v) =>
    !search || v.name.toLowerCase().includes(search) || v.id.toLowerCase().includes(search) || (v.description || "").toLowerCase().includes(search),
  );
  if (filtered.length === 0) {
    list.innerHTML = `<div class="crud-empty">No vibes matching "${escapeHtml(search)}"</div>`;
    return;
  }

  const { items, state } = paginate(filtered, vibesPage);
  vibesPage = state.page;

  for (const v of items) {
    const meta: string[] = [];
    if (v.status) meta.push(escapeHtml(v.status));
    meta.push(`<span style="font-family:var(--font-mono);">${escapeHtml(v.id)}</span>`);
    if (v.description) meta.push(escapeHtml(v.description));

    const card = document.createElement("div");
    card.className = "crud-card";
    card.innerHTML = `
      <div class="crud-card-info">
        <span class="crud-card-name">${escapeHtml(v.name || v.id)}</span>
        <span class="crud-card-meta">${meta.join(" · ")}</span>
      </div>
      <div class="crud-card-actions">
        <button class="crud-card-btn crud-open-btn" title="Open workspace">${OPEN_ICON}</button>
        <button class="crud-card-btn danger crud-delete-btn" title="Delete">${DELETE_ICON}</button>
      </div>`;
    card.querySelector(".crud-open-btn")!.addEventListener("click", (e) => { e.stopPropagation(); void openWorkspace(v.id); });
    card.querySelector(".crud-delete-btn")!.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!(await confirmAction(`Delete vibe "${v.name || v.id}"? This removes its project files.`))) return;
      await window.yo.vibesDelete(v.id);
      await loadVibes();
    });
    card.addEventListener("click", () => openDetail(v));
    list.appendChild(card);
  }

  list.appendChild(renderPaginationBar(state, (p) => { vibesPage = p; renderVibesList(); }));
}

// ── Detail / create ─────────────────────────────────────────

function openDetail(vibe: VibeDef | null): void {
  isNew = vibe === null;
  current = vibe ? { ...vibe } : { id: "", name: "", description: "" };

  $a("vibes-toolbar").classList.add("hidden");
  $a("vibes-list").classList.add("hidden");
  $a("vibe-detail").classList.remove("hidden");
  $a("vibe-form-error").classList.add("hidden");

  $a<HTMLInputElement>("vibe-name").value = current.name || "";
  $a<HTMLTextAreaElement>("vibe-description").value = current.description || "";
  // Seed the goal from the description as a sensible starting point.
  $a<HTMLTextAreaElement>("vibe-goal").value = current.description || "";
  const planStatus = $a("vibe-plan-status");
  if (planStatus) planStatus.textContent = "";
  // Existing vibes are opened by id; only new vibes are read-write here.
  ($a("vibe-delete-btn") as HTMLElement).style.display = isNew ? "none" : "";
}

/** Resolve the vibe id to plan against — creating the vibe first if this is a new one. */
async function resolvePlanTarget(status: HTMLElement | null): Promise<string | null> {
  let vibeId = isNew ? undefined : current?.id;
  if (vibeId) return vibeId;
  const name = $a<HTMLInputElement>("vibe-name").value.trim();
  if (!name) { if (status) status.textContent = "Name is required."; return null; }
  const description = $a<HTMLTextAreaElement>("vibe-description").value.trim() || undefined;
  const created = (await window.yo.vibesCreate(name, description)) as unknown as VibeDef;
  vibeId = created?.id;
  if (!vibeId) { if (status) status.textContent = "Could not create vibe."; return null; }
  // Now editing the created vibe.
  current = created;
  isNew = false;
  ($a("vibe-delete-btn") as HTMLElement).style.display = "";
  return vibeId;
}

function setPlanButtonsDisabled(disabled: boolean): void {
  const a = document.getElementById("vibe-plan-btn") as HTMLButtonElement | null;
  const b = document.getElementById("vibe-council-btn") as HTMLButtonElement | null;
  if (a) a.disabled = disabled;
  if (b) b.disabled = disabled;
}

/**
 * Generate plan.md + CLAUDE.md for the current vibe via vibe-planner.
 * For a brand-new vibe, create it first (so it has an id + dir to write into).
 */
async function generatePlan(): Promise<void> {
  const status = $a("vibe-plan-status");
  const goal = $a<HTMLTextAreaElement>("vibe-goal").value.trim();
  if (!goal) { if (status) status.textContent = "Enter a goal first."; return; }

  const vibeId = await resolvePlanTarget(status);
  if (!vibeId) return;

  setPlanButtonsDisabled(true);
  if (status) status.textContent = "Generating plan…";
  try {
    const res = await window.yo.vibesPlan(vibeId, goal);
    if (status) status.textContent = res?.ok ? "Plan ready. Open the workspace to see it." : (res?.error || "Failed to generate plan.");
  } catch (err) {
    if (status) status.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    setPlanButtonsDisabled(false);
  }
}

/**
 * Plan with a council (Phase 4): convene a multi-LLM council on the goal, then
 * feed its synthesis into the planner. Slow — buttons are disabled while it
 * runs. On the <2-provider gate (fellBack:false) we point the user at Settings
 * → Providers and suggest plain Generate plan.
 */
async function planWithCouncil(): Promise<void> {
  const status = $a("vibe-plan-status");
  const goal = $a<HTMLTextAreaElement>("vibe-goal").value.trim();
  if (!goal) { if (status) status.textContent = "Enter a goal first."; return; }

  const vibeId = await resolvePlanTarget(status);
  if (!vibeId) return;

  setPlanButtonsDisabled(true);
  if (status) status.textContent = "Convening council… (this can take a minute)";
  try {
    const res = await window.yo.vibesPlanWithCouncil(vibeId, goal);
    if (res?.ok) {
      if (status) status.textContent = "Plan ready (informed by the council). Open the workspace to see it.";
    } else if (res && res.fellBack === false && /2\+? providers|2 or more providers/i.test(res.error || "")) {
      if (status) status.textContent = "Council needs 2+ providers. Add API keys in Settings → Providers, or use “Generate plan” instead.";
    } else {
      if (status) status.textContent = res?.error || "Failed to plan with council.";
    }
  } catch (err) {
    if (status) status.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    setPlanButtonsDisabled(false);
  }
}

/** Open (creating first if this is a new vibe) → bind the panel + close home. */
async function openWorkspace(id?: string): Promise<void> {
  let vibeId = id;

  if (!vibeId) {
    // New-vibe path: create from the form, then open the freshly-created vibe.
    const err = $a("vibe-form-error");
    const name = $a<HTMLInputElement>("vibe-name").value.trim();
    if (!name) { err.textContent = "Name is required."; err.classList.remove("hidden"); return; }
    const description = $a<HTMLTextAreaElement>("vibe-description").value.trim() || undefined;
    const created = (await window.yo.vibesCreate(name, description)) as unknown as VibeDef;
    vibeId = created?.id;
    if (!vibeId) { err.textContent = "Could not create vibe."; err.classList.remove("hidden"); return; }
  }

  await window.yo.vibesOpen(vibeId);
  closeHelp();
}

// ── Init ────────────────────────────────────────────────────

function initVibes(): void {
  const search = $a<HTMLInputElement>("vibe-search");
  if (!search) return; // section not in this panel
  search.addEventListener("input", () => { vibesPage = 1; renderVibesList(); });
  $a("vibe-new-btn").addEventListener("click", () => openDetail(null));
  $a("vibe-back-link").addEventListener("click", () => { void loadVibes(); });
  $a("vibe-open-btn").addEventListener("click", () => {
    // In the detail view: existing vibe opens by id; new vibe creates then opens.
    void openWorkspace(isNew ? undefined : current?.id);
  });
  $a("vibe-plan-btn").addEventListener("click", () => { void generatePlan(); });
  const councilBtn = document.getElementById("vibe-council-btn");
  if (councilBtn) councilBtn.addEventListener("click", () => { void planWithCouncil(); });
  $a("vibe-delete-btn").addEventListener("click", async () => {
    if (!current || isNew) return;
    if (!(await confirmAction(`Delete vibe "${current.name || current.id}"? This removes its project files.`))) return;
    await window.yo.vibesDelete(current.id);
    await loadVibes();
  });
}

export { loadVibes, initVibes };
