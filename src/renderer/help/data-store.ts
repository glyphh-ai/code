/**
 * Data Store section — browse/search/detail captures.
 */

import { formatBytes, relativeTime, confirmAction, buildPaginationBar } from "./shared.js";

const dataListEl = document.getElementById("data-list")!;
const dataToolbar = document.getElementById("data-toolbar")!;
const dataDetail = document.getElementById("data-detail")!;
const dataSearchInput = document.getElementById("data-search") as HTMLInputElement;
const dataDetailMeta = document.getElementById("data-detail-meta")!;
const dataDetailContent = document.getElementById("data-detail-content")!;
const dataClearSelect = document.getElementById("data-clear-select") as HTMLSelectElement;
let dataOffset = 0;
const DATA_PAGE_SIZE = 20;
let viewingEntryId: string | null = null;
let dataSearchTimer: ReturnType<typeof setTimeout> | null = null;

export function dataSearchDebounce() {
  if (dataSearchTimer) clearTimeout(dataSearchTimer);
  dataSearchTimer = setTimeout(() => { dataOffset = 0; renderDataList(); }, 300);
}

export async function loadData() {
  dataDetail.classList.add("hidden");
  dataListEl.classList.remove("hidden");
  dataToolbar.classList.remove("hidden");

  const stats = await window.yo.capturesStats();

  const prevVal = dataClearSelect.value;
  dataClearSelect.innerHTML = "";
  const allOpt = document.createElement("option");
  allOpt.value = "__all__";
  allOpt.textContent = `All sources (${stats.count})`;
  dataClearSelect.appendChild(allOpt);
  const sorted = Object.entries(stats.sources).sort((a, b) => b[1] - a[1]);
  for (const [source, count] of sorted) {
    const opt = document.createElement("option");
    opt.value = source;
    opt.textContent = `${source} (${count})`;
    dataClearSelect.appendChild(opt);
  }
  if (Array.from(dataClearSelect.options).some(o => o.value === prevVal)) {
    dataClearSelect.value = prevVal;
  }

  renderDataList();
}

async function renderDataList() {
  const query = dataSearchInput.value.trim();

  if (query) {
    const results = await window.yo.capturesSearch(query, 200);
    const total = results.length;
    const page = results.slice(dataOffset, dataOffset + DATA_PAGE_SIZE);
    dataListEl.innerHTML = "";
    if (page.length === 0) {
      dataListEl.innerHTML = `<div class="crud-empty">No captures matching "${query}"</div>`;
      return;
    }
    for (const r of page) {
      dataListEl.appendChild(makeDataCard(r.meta.id, r.meta.source, r.meta.created, r.content.slice(0, 200), r.score));
    }
    if (total > DATA_PAGE_SIZE) {
      dataListEl.appendChild(buildPaginationBar(dataOffset, DATA_PAGE_SIZE, total, (newOffset) => {
        dataOffset = newOffset;
        renderDataList();
      }));
    }
    return;
  }

  const [entries, stats] = await Promise.all([
    window.yo.capturesList(dataOffset, DATA_PAGE_SIZE),
    window.yo.capturesStats(),
  ]);
  const total = stats.count;
  dataListEl.innerHTML = "";
  if (entries.length === 0 && dataOffset === 0) {
    dataListEl.innerHTML = `<div class="crud-empty">No captures yet. Use .sup to capture panel content.</div>`;
    return;
  }

  for (const e of entries) {
    dataListEl.appendChild(makeDataCard(e.meta.id, e.meta.source, e.meta.created, e.snippet, undefined, e.size));
  }

  if (total > DATA_PAGE_SIZE) {
    dataListEl.appendChild(buildPaginationBar(dataOffset, DATA_PAGE_SIZE, total, (newOffset) => {
      dataOffset = newOffset;
      renderDataList();
    }));
  }
}

function makeDataCard(id: string, source: string, created: number, snippet: string, score?: number, size?: number): HTMLElement {
  const card = document.createElement("div");
  card.className = "crud-card";
  const info = document.createElement("div");
  info.className = "crud-card-info";
  info.style.cssText = "min-width:0;";

  const nameRow = document.createElement("div");
  nameRow.style.cssText = "display:flex;gap:6px;align-items:center;";
  const srcSpan = document.createElement("span");
  srcSpan.className = "crud-card-name";
  srcSpan.textContent = source;
  nameRow.appendChild(srcSpan);

  const timeSpan = document.createElement("span");
  timeSpan.style.cssText = "font-size:10px;color:var(--text-muted);";
  timeSpan.textContent = relativeTime(created);
  nameRow.appendChild(timeSpan);
  if (size !== undefined && size > 0) {
    const sizeSpan = document.createElement("span");
    sizeSpan.style.cssText = "font-size:10px;color:#48dbfb;flex-shrink:0;";
    sizeSpan.textContent = formatBytes(size);
    nameRow.appendChild(sizeSpan);
  }
  if (score !== undefined) {
    const scoreSpan = document.createElement("span");
    scoreSpan.style.cssText = "font-size:10px;color:var(--accent);";
    scoreSpan.textContent = `${(score * 100).toFixed(0)}%`;
    nameRow.appendChild(scoreSpan);
  }
  info.appendChild(nameRow);

  const meta = document.createElement("span");
  meta.className = "crud-card-meta";
  meta.textContent = snippet;
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
    await window.yo.capturesDelete(id);
    loadData();
  });
  actions.appendChild(delBtn);
  card.appendChild(actions);

  card.addEventListener("click", () => openDataDetail(id, source, created));
  return card;
}

async function openDataDetail(id: string, source: string, created: number) {
  viewingEntryId = id;
  const [content, size] = await Promise.all([
    window.yo.capturesRead(id),
    window.yo.capturesEntrySize(id),
  ]);
  dataDetailMeta.textContent = `${source} · ${new Date(created).toLocaleString()} · ${formatBytes(size)} · ${id}`;
  dataDetailContent.textContent = content || "(empty)";

  dataListEl.classList.add("hidden");
  dataToolbar.classList.add("hidden");
  dataDetail.classList.remove("hidden");
}

export function closeDataDetail() {
  dataDetail.classList.add("hidden");
  dataListEl.classList.remove("hidden");
  dataToolbar.classList.remove("hidden");
  viewingEntryId = null;
  loadData();
}

export async function deleteDataEntry() {
  if (!viewingEntryId) return;
  const confirmed = await confirmAction("Delete this capture?");
  if (!confirmed) return;
  await window.yo.capturesDelete(viewingEntryId);
  closeDataDetail();
}

export async function clearData() {
  const selected = dataClearSelect.value;
  if (selected === "__all__") {
    const confirmed = await confirmAction("Delete ALL captures? This cannot be undone.");
    if (!confirmed) return;
    await window.yo.capturesClear();
  } else {
    const confirmed = await confirmAction(`Delete all captures from "${selected}"? This cannot be undone.`);
    if (!confirmed) return;
    await window.yo.capturesDeleteBySource(selected);
  }
  loadData();
}
