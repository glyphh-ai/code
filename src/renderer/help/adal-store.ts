/**
 * adaL Substrate section — browse/search thoughts, promote to fact, edit, delete.
 *
 * Mirrors data-store.ts but targets the curated HDC substrate rather than the
 * episodic capture corpus. Thoughts carry a tier (fact | episodic); facts are
 * durable and rank higher in recall, episodic thoughts decay.
 */

import { relativeTime, confirmAction, buildPaginationBar } from "./shared.js";

const adalListEl = document.getElementById("adal-list")!;
const adalToolbar = document.getElementById("adal-toolbar")!;
const adalDetail = document.getElementById("adal-detail")!;
const adalSearchInput = document.getElementById("adal-search") as HTMLInputElement;
const adalDetailMeta = document.getElementById("adal-detail-meta")!;
const adalDetailContent = document.getElementById("adal-detail-content")!;
const adalEditText = document.getElementById("adal-edit-text") as HTMLTextAreaElement;
const adalEditActions = document.getElementById("adal-edit-actions")!;
const adalPromoteBtn = document.getElementById("adal-promote-btn") as HTMLButtonElement;

let adalOffset = 0;
const ADAL_PAGE_SIZE = 20;
let adalSearchTimer: ReturnType<typeof setTimeout> | null = null;

type ViewingThought = { id: string; tier: "fact" | "episodic" } | null;
let viewing: ViewingThought = null;

export function adalSearchDebounce() {
  if (adalSearchTimer) clearTimeout(adalSearchTimer);
  adalSearchTimer = setTimeout(() => { adalOffset = 0; renderAdalList(); }, 300);
}

export async function loadAdal() {
  adalDetail.classList.add("hidden");
  adalListEl.classList.remove("hidden");
  adalToolbar.classList.remove("hidden");
  await renderAdalList();
}

async function renderAdalList() {
  const query = adalSearchInput.value.trim();

  if (query) {
    const results = await window.yo.adalThoughtsSearch(query, 200);
    const total = results.length;
    const page = results.slice(adalOffset, adalOffset + ADAL_PAGE_SIZE);
    adalListEl.innerHTML = "";
    if (page.length === 0) {
      adalListEl.innerHTML = `<div class="crud-empty">No thoughts matching "${query}"</div>`;
      return;
    }
    for (const t of page) {
      adalListEl.appendChild(makeAdalCard(t.thoughtId, t.speaker, t.createdAt, t.content, t.tier, t.score));
    }
    if (total > ADAL_PAGE_SIZE) {
      adalListEl.appendChild(buildPaginationBar(adalOffset, ADAL_PAGE_SIZE, total, (n) => { adalOffset = n; renderAdalList(); }));
    }
    return;
  }

  const [entries, stats] = await Promise.all([
    window.yo.adalThoughtsList(adalOffset, ADAL_PAGE_SIZE),
    window.yo.adalStats(),
  ]);
  const total = stats.count;
  adalListEl.innerHTML = "";
  if (entries.length === 0 && adalOffset === 0) {
    adalListEl.innerHTML = `<div class="crud-empty">No thoughts yet. adaL absorbs your turns automatically.</div>`;
    return;
  }

  for (const t of entries) {
    adalListEl.appendChild(makeAdalCard(t.thoughtId, t.speaker, t.createdAt, t.content, t.tier));
  }

  if (total > ADAL_PAGE_SIZE) {
    adalListEl.appendChild(buildPaginationBar(adalOffset, ADAL_PAGE_SIZE, total, (n) => { adalOffset = n; renderAdalList(); }));
  }
}

function makeAdalCard(id: string, speaker: string, created: number, content: string, tier: "fact" | "episodic", score?: number): HTMLElement {
  const card = document.createElement("div");
  card.className = "crud-card";

  const info = document.createElement("div");
  info.className = "crud-card-info";
  info.style.cssText = "min-width:0;";

  const nameRow = document.createElement("div");
  nameRow.style.cssText = "display:flex;gap:6px;align-items:center;";

  const tierBadge = document.createElement("span");
  tierBadge.textContent = tier === "fact" ? "FACT" : "EPISODIC";
  tierBadge.style.cssText = tier === "fact"
    ? "font-size:9px;font-weight:600;color:#0a0a0a;background:var(--accent);padding:1px 5px;border-radius:3px;flex-shrink:0;"
    : "font-size:9px;font-weight:600;color:var(--text-muted);background:var(--border);padding:1px 5px;border-radius:3px;flex-shrink:0;";
  nameRow.appendChild(tierBadge);

  const spkSpan = document.createElement("span");
  spkSpan.className = "crud-card-name";
  spkSpan.textContent = speaker;
  nameRow.appendChild(spkSpan);

  const timeSpan = document.createElement("span");
  timeSpan.style.cssText = "font-size:10px;color:var(--text-muted);flex-shrink:0;";
  timeSpan.textContent = relativeTime(created);
  nameRow.appendChild(timeSpan);

  if (score !== undefined) {
    const scoreSpan = document.createElement("span");
    scoreSpan.style.cssText = "font-size:10px;color:var(--accent);flex-shrink:0;";
    scoreSpan.textContent = `${(score * 100).toFixed(0)}%`;
    nameRow.appendChild(scoreSpan);
  }
  info.appendChild(nameRow);

  const meta = document.createElement("span");
  meta.className = "crud-card-meta";
  meta.textContent = content;
  meta.style.cssText = "display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;";
  info.appendChild(meta);
  card.appendChild(info);

  const actions = document.createElement("div");
  actions.className = "crud-card-actions";
  const delBtn = document.createElement("button");
  delBtn.className = "crud-card-btn danger crud-delete-btn";
  delBtn.title = "Delete";
  delBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`;
  delBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    await window.yo.adalThoughtsDelete(id);
    loadAdal();
  });
  actions.appendChild(delBtn);
  card.appendChild(actions);

  card.addEventListener("click", () => openAdalDetail(id, speaker, created, content, tier));
  return card;
}

function openAdalDetail(id: string, speaker: string, created: number, content: string, tier: "fact" | "episodic") {
  viewing = { id, tier };
  adalDetailMeta.textContent = `${tier} · ${speaker} · ${new Date(created).toLocaleString()} · ${id}`;
  adalDetailContent.textContent = content || "(empty)";
  adalPromoteBtn.textContent = tier === "fact" ? "Demote to episodic" : "Promote to fact";

  exitEditMode();
  adalListEl.classList.add("hidden");
  adalToolbar.classList.add("hidden");
  adalDetail.classList.remove("hidden");
}

function exitEditMode() {
  adalEditText.classList.add("hidden");
  adalEditActions.classList.add("hidden");
  adalDetailContent.classList.remove("hidden");
}

export function closeAdalDetail() {
  adalDetail.classList.add("hidden");
  adalListEl.classList.remove("hidden");
  adalToolbar.classList.remove("hidden");
  viewing = null;
  loadAdal();
}

export async function deleteAdalThought() {
  if (!viewing) return;
  const confirmed = await confirmAction("Delete this thought?");
  if (!confirmed) return;
  await window.yo.adalThoughtsDelete(viewing.id);
  closeAdalDetail();
}

export async function promoteAdalThought() {
  if (!viewing) return;
  const makeFact = viewing.tier !== "fact";
  await window.yo.adalThoughtsPromote(viewing.id, makeFact);
  closeAdalDetail();
}

export function beginAdalEdit() {
  if (!viewing) return;
  adalEditText.value = adalDetailContent.textContent || "";
  adalDetailContent.classList.add("hidden");
  adalEditText.classList.remove("hidden");
  adalEditActions.classList.remove("hidden");
  adalEditText.focus();
}

export async function saveAdalEdit() {
  if (!viewing) return;
  const text = adalEditText.value.trim();
  if (!text) return;
  await window.yo.adalThoughtsEdit(viewing.id, text);
  closeAdalDetail();
}

export function cancelAdalEdit() {
  exitEditMode();
}
