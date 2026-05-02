/**
 * Layouts section — grid builder, layout CRUD.
 */

import { paginate, renderPaginationBar, confirmAction, clearInvalid, closeHelp } from "./shared.js";


let layoutsPage = 0;
let allLayouts: Array<{ name: string; splits: Array<{ panelId: string; col?: number; row?: number; colSpan?: number; rowSpan?: number }>; type?: string; rootDir?: string; slots?: Array<{ slotId: string; enableInput?: boolean }> }> = [];
const layoutsList = document.getElementById("layouts-list")!;
const layoutEditor = document.getElementById("layout-editor")!;
const layoutsToolbar = document.getElementById("layouts-toolbar")!;
const layoutSearchInput = document.getElementById("layout-search") as HTMLInputElement;
const layoutNameInput = document.getElementById("layout-new-name") as HTMLInputElement;
const layoutFormError = document.getElementById("layout-form-error")!;
const layoutDeleteBtn = document.getElementById("layout-delete-btn") as HTMLButtonElement;
const layoutEditorTitle: HTMLElement | null = document.getElementById("layout-editor-title");
let editingLayoutName: string | null = null;
const layoutTypeSelect = document.getElementById("layout-type-select") as HTMLSelectElement;
const layoutCodeFields = document.getElementById("layout-code-fields")!;
const layoutRootDirInput = document.getElementById("layout-rootdir") as HTMLInputElement;
const layoutSlotsList = document.getElementById("layout-slots-list")!;
const layoutSlotsAddBtn = document.getElementById("layout-slots-add") as HTMLButtonElement;
const layoutPickDirBtn = document.getElementById("layout-pick-dir") as HTMLButtonElement;
const layoutGridBuilder = document.getElementById("layout-grid-builder")!;
const gridPreview = document.getElementById("grid-preview")!;
const gridColsSelect = document.getElementById("grid-cols") as HTMLSelectElement;
const gridRowsSelect = document.getElementById("grid-rows") as HTMLSelectElement;
const mergeRightBtn = document.getElementById("grid-merge-right") as HTMLButtonElement;
const mergeDownBtn = document.getElementById("grid-merge-down") as HTMLButtonElement;
const splitBtn = document.getElementById("grid-split-btn") as HTMLButtonElement;

interface BuilderCell {
  panelId: string;
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
}

let builderCols = 2;
let builderRows = 1;
let builderCells: BuilderCell[] = [];
let builderSelected = -1;

function initBuilderCells() {
  builderCells = [];
  for (let r = 0; r < builderRows; r++) {
    for (let c = 0; c < builderCols; c++) {
      builderCells.push({ panelId: "", col: c, row: r, colSpan: 1, rowSpan: 1 });
    }
  }
  builderSelected = -1;
}

function cellAt(col: number, row: number): number {
  return builderCells.findIndex(
    (c) => col >= c.col && col < c.col + c.colSpan && row >= c.row && row < c.row + c.rowSpan,
  );
}

function canMergeRight(idx: number): boolean {
  const cell = builderCells[idx];
  if (cell.col + cell.colSpan >= builderCols) return false;
  // All cells in the column to the right (within this cell's row range) must be one cell with matching span
  const rightIdx = cellAt(cell.col + cell.colSpan, cell.row);
  if (rightIdx < 0) return false;
  const right = builderCells[rightIdx];
  return right.col === cell.col + cell.colSpan &&
    right.row === cell.row && right.rowSpan === cell.rowSpan;
}

function canMergeDown(idx: number): boolean {
  const cell = builderCells[idx];
  if (cell.row + cell.rowSpan >= builderRows) return false;
  const belowIdx = cellAt(cell.col, cell.row + cell.rowSpan);
  if (belowIdx < 0) return false;
  const below = builderCells[belowIdx];
  return below.row === cell.row + cell.rowSpan &&
    below.col === cell.col && below.colSpan === cell.colSpan;
}

function doMergeRight(idx: number) {
  const cell = builderCells[idx];
  const rightIdx = cellAt(cell.col + cell.colSpan, cell.row);
  if (rightIdx < 0) return;
  cell.colSpan += builderCells[rightIdx].colSpan;
  builderCells.splice(rightIdx, 1);
  builderSelected = builderCells.indexOf(cell);
}

function doMergeDown(idx: number) {
  const cell = builderCells[idx];
  const belowIdx = cellAt(cell.col, cell.row + cell.rowSpan);
  if (belowIdx < 0) return;
  cell.rowSpan += builderCells[belowIdx].rowSpan;
  builderCells.splice(belowIdx, 1);
  builderSelected = builderCells.indexOf(cell);
}

function doSplit(idx: number) {
  const cell = builderCells[idx];
  if (cell.colSpan === 1 && cell.rowSpan === 1) return;
  const newCells: BuilderCell[] = [];
  for (let r = cell.row; r < cell.row + cell.rowSpan; r++) {
    for (let c = cell.col; c < cell.col + cell.colSpan; c++) {
      newCells.push({
        panelId: r === cell.row && c === cell.col ? cell.panelId : "",
        col: c, row: r, colSpan: 1, rowSpan: 1,
      });
    }
  }
  builderCells.splice(idx, 1, ...newCells);
  builderSelected = -1;
}

function updateMergeButtons() {
  if (builderSelected < 0) {
    mergeRightBtn.disabled = true;
    mergeDownBtn.disabled = true;
    splitBtn.disabled = true;
    return;
  }
  const cell = builderCells[builderSelected];
  mergeRightBtn.disabled = !canMergeRight(builderSelected);
  mergeDownBtn.disabled = !canMergeDown(builderSelected);
  splitBtn.disabled = cell.colSpan === 1 && cell.rowSpan === 1;
}

function renderGridPreview() {
  gridPreview.style.gridTemplateColumns = `repeat(${builderCols}, 1fr)`;
  gridPreview.style.gridTemplateRows = `repeat(${builderRows}, 1fr)`;

  gridPreview.innerHTML = builderCells
    .map((cell, i) => {
      const cls = ["grid-cell"];
      if (cell.panelId) cls.push("assigned");
      if (i === builderSelected) cls.push("selected");
      let label = cell.panelId || "\u2014";
      if (cell.panelId?.startsWith("agent:")) label = cell.panelId.slice(6);
      else if (cell.panelId === "agents-tabbed") label = "Agents (tabbed)";
      else if (cell.panelId === "vscode") label = "VS Code";
      return `<div class="${cls.join(" ")}" data-index="${i}"
        style="grid-column: ${cell.col + 1} / span ${cell.colSpan}; grid-row: ${cell.row + 1} / span ${cell.rowSpan}">
        ${label}
      </div>`;
    })
    .join("");

  gridPreview.querySelectorAll(".grid-cell").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt((el as HTMLElement).dataset.index!, 10);
      showCellPicker(idx, el as HTMLElement);
    });
  });

  updateMergeButtons();
}

async function showCellPicker(cellIndex: number, anchor: HTMLElement) {
  document.querySelectorAll(".cell-panel-picker").forEach((el) => el.remove());
  const rect = anchor.getBoundingClientRect();
  builderSelected = cellIndex;
  renderGridPreview();

  const isCode = layoutTypeSelect.value === "code";

  type PickerOption = { id: string; label: string };
  let options: PickerOption[];

  if (isCode) {
    const slots = getSlotEntries();
    options = [
      { id: "vscode", label: "VS Code" },
      ...slots.map((s) => ({ id: `agent-slot:${s.slotId}`, label: `Agent slot — ${s.slotId}` })),
    ];
  } else {
    const apps = await window.yo.appsList();
    options = apps.map((a) => ({ id: a.id, label: a.name }));
  }

  const picker = document.createElement("div");
  picker.className = "cell-panel-picker";
  picker.style.left = `${rect.left}px`;

  picker.innerHTML = [
    `<input class="cell-panel-search" placeholder="Search…" autocomplete="off" spellcheck="false" />`,
    `<div class="cell-panel-options">`,
    `<div class="cell-panel-option empty" data-id="">Empty</div>`,
    ...options.map((o) => `<div class="cell-panel-option" data-id="${o.id}">${o.label}</div>`),
    `</div>`,
  ].join("");

  document.body.appendChild(picker);

  const pickerHeight = picker.offsetHeight;
  const spaceBelow = window.innerHeight - rect.bottom - 4;
  if (spaceBelow < pickerHeight && rect.top > pickerHeight) {
    picker.style.bottom = `${window.innerHeight - rect.top + 4}px`;
  } else {
    picker.style.top = `${rect.bottom + 4}px`;
  }

  const closePicker = (ev: MouseEvent) => {
    if (!(ev.target as HTMLElement).closest(".cell-panel-picker")) {
      picker.remove();
      document.removeEventListener("click", closePicker);
    }
  };

  const searchInput = picker.querySelector(".cell-panel-search") as HTMLInputElement;
  searchInput.focus();

  searchInput.addEventListener("input", () => {
    const q = searchInput.value.toLowerCase();
    picker.querySelectorAll<HTMLElement>(".cell-panel-option:not(.empty)").forEach((opt) => {
      opt.style.display = (opt.textContent || "").toLowerCase().includes(q) ? "" : "none";
    });
  });

  searchInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      picker.remove();
      document.removeEventListener("click", closePicker);
    }
  });

  picker.querySelectorAll(".cell-panel-option").forEach((opt) => {
    opt.addEventListener("click", (ev) => {
      ev.stopPropagation();
      builderCells[cellIndex].panelId = (opt as HTMLElement).dataset.id!;
      picker.remove();
      renderGridPreview();
    });
  });

  setTimeout(() => document.addEventListener("click", closePicker), 0);
}

async function loadLayouts() {
  layoutEditor.classList.add("hidden");
  layoutFormError.classList.add("hidden");
  allLayouts = await window.yo.layoutsList();

  // Check layout limit for free tier
  const limitMsg = document.getElementById("layouts-limit-msg")!;
  const newBtn = document.getElementById("layout-new-btn") as HTMLButtonElement;
  try {
    const auth = await window.yo.getAuthStatus();
    const atLimit = auth.tier !== "basic" && auth.tier !== "advanced" && allLayouts.length >= 5;
    limitMsg.classList.toggle("hidden", !atLimit);
    newBtn.disabled = atLimit;
    if (atLimit) {
      document.getElementById("layouts-upgrade-link")!.onclick = (e) => {
        e.preventDefault();
        closeHelp();
        window.yo.execCommand(`dip ${window.yo.platformUrl}/dashboard/billing`);
      };
    }
  } catch { /* fall through */ }

  renderLayoutsList();
}

function renderLayoutsList() {
  const query = layoutSearchInput.value.trim().toLowerCase();
  const filtered = query ? allLayouts.filter((l) => l.name.toLowerCase().includes(query)) : allLayouts;

  if (allLayouts.length === 0) {
    layoutsList.innerHTML = `<div class="crud-empty">No layouts yet. Click "+ New" to create one.</div>`;
    return;
  }
  if (filtered.length === 0) {
    layoutsList.innerHTML = `<div class="crud-empty">No layouts matching "${query}"</div>`;
    return;
  }

  const { items: layouts, state } = paginate(filtered, layoutsPage);
  layoutsPage = state.page;
  layoutsList.innerHTML = "";

  for (const layout of layouts) {
    const card = document.createElement("div");
    card.className = "crud-card";
    const isCode = layout.type === "code";
    const panels = layout.splits.map((s) => s.panelId).filter(Boolean).join(" | ");
    const typeBadge = isCode ? `<span class="crud-card-badge">code</span>` : "";
    const dirLine = isCode && layout.rootDir ? `<span class="crud-card-dir">${layout.rootDir}</span>` : "";
    const slotLine = isCode && layout.slots?.length ? `<span class="crud-card-agents">${layout.slots.length} slot${layout.slots.length === 1 ? "" : "s"}</span>` : "";
    card.innerHTML = `
      <div class="crud-card-info">
        <span class="crud-card-name">${typeBadge}${layout.name}</span>
        ${dirLine}
        ${slotLine || (!isCode ? `<span class="crud-card-meta">${panels || "empty"}</span>` : "")}
      </div>
      <div class="crud-card-actions">
        <button class="crud-card-btn crud-edit-btn" title="Edit">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
        </button>
        <button class="crud-card-btn danger crud-delete-btn" title="Delete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
        </button>
      </div>`;

    card.querySelector(".crud-edit-btn")!.addEventListener("click", (e) => {
      e.stopPropagation();
      editLayout(layout.name);
    });

    card.querySelector(".crud-delete-btn")!.addEventListener("click", async (e) => {
      e.stopPropagation();
      const confirmed = await confirmAction(`Delete layout "${layout.name}"?`);
      if (!confirmed) return;
      await window.yo.layoutsDelete(layout.name);
      loadLayouts();
    });

    card.addEventListener("click", () => editLayout(layout.name));
    layoutsList.appendChild(card);
  }

  layoutsList.appendChild(renderPaginationBar(state, (p) => { layoutsPage = p; renderLayoutsList(); }));
}

async function editLayout(name: string) {
  editingLayoutName = name;
  const layouts = await window.yo.layoutsList();
  const layout = layouts.find((l) => l.name === name);
  if (layout) {
    builderCols = layout.cols || 2;
    builderRows = layout.rows || 1;
    initBuilderCells();
    for (const s of layout.splits) {
      const cell = builderCells.find((c) => c.col === s.col && c.row === s.row);
      if (cell) {
        cell.panelId = s.panelId;
        cell.colSpan = s.colSpan ?? 1;
        cell.rowSpan = s.rowSpan ?? 1;
      }
    }
  } else {
    builderCols = 2;
    builderRows = 1;
    initBuilderCells();
  }
  gridColsSelect.value = String(builderCols);
  gridRowsSelect.value = String(builderRows);
  layoutNameInput.value = name;
  layoutDeleteBtn.style.display = "";
  if (layoutEditorTitle) layoutEditorTitle.textContent = name;
  layoutFormError.classList.add("hidden");

  const isCode = layout?.type === "code";
  layoutTypeSelect.value = isCode ? "code" : "standard";
  layoutCodeFields.classList.toggle("hidden", !isCode);
  layoutGridBuilder.classList.remove("hidden");
  layoutRootDirInput.value = (isCode && layout?.rootDir) || "";
  clearSlotRows();
  if (isCode && layout?.slots) {
    layout.slots.forEach((s: { slotId: string; enableInput?: boolean }) => addSlotRow(s.slotId, s.enableInput));
  }

  layoutsList.classList.add("hidden");
  layoutsToolbar.classList.add("hidden");
  layoutEditor.classList.remove("hidden");
  renderGridPreview();
}

async function newLayout() {
  editingLayoutName = null;
  builderCols = 2;
  builderRows = 1;
  initBuilderCells();
  gridColsSelect.value = "2";
  gridRowsSelect.value = "1";
  layoutNameInput.value = "";
  layoutDeleteBtn.style.display = "none";
  if (layoutEditorTitle) layoutEditorTitle.textContent = "New Layout";
  layoutFormError.classList.add("hidden");
  layoutTypeSelect.value = "standard";
  layoutCodeFields.classList.add("hidden");
  layoutGridBuilder.classList.remove("hidden");
  renderGridPreview();
  layoutRootDirInput.value = "";
  clearSlotRows();
  layoutsList.classList.add("hidden");
  layoutsToolbar.classList.add("hidden");
  layoutEditor.classList.remove("hidden");
  layoutNameInput.focus();
  renderGridPreview();
}

function cancelLayout() {
  layoutEditor.classList.add("hidden");
  layoutsList.classList.remove("hidden");
  layoutsToolbar.classList.remove("hidden");
  editingLayoutName = null;
  loadLayouts();
}

async function saveLayout() {
  const name = layoutNameInput.value.trim();
  if (!name) {
    layoutNameInput.classList.add("invalid");
    clearInvalid(layoutNameInput);
    layoutFormError.textContent = "Layout name is required.";
    layoutFormError.classList.remove("hidden");
    return;
  }
  const isCode = layoutTypeSelect.value === "code";
  const assignedCells = builderCells.filter((c) => c.panelId);
  if (assignedCells.length < 1) {
    layoutFormError.textContent = "Assign at least one panel to the grid.";
    layoutFormError.classList.remove("hidden");
    return;
  }

  if (editingLayoutName && editingLayoutName !== name) {
    await window.yo.layoutsDelete(editingLayoutName);
  }

  const slotRows = getSlotEntries();
  const slots = isCode && slotRows.length ? slotRows : undefined;

  await window.yo.layoutsSaveGrid({
    name,
    cols: builderCols,
    rows: builderRows,
    colWidths: Array(builderCols).fill(1 / builderCols),
    rowHeights: Array(builderRows).fill(1 / builderRows),
    cells: assignedCells,
    type: isCode ? "code" : undefined,
    rootDir: isCode ? layoutRootDirInput.value.trim() || undefined : undefined,
    slots,
  });
  cancelLayout();
}

async function deleteLayout() {
  if (!editingLayoutName) return;
  const confirmed = await confirmAction(`Delete layout "${editingLayoutName}"?`);
  if (!confirmed) return;
  await window.yo.layoutsDelete(editingLayoutName);
  cancelLayout();
}


// ── Slot rows (layout agent slots) ──────────────────────

// ── Slot row list (layout agent slots — placeholders, not agent defs) ──

function addSlotRow(slotId?: string, enableInput?: boolean) {
  const wrapper = document.createElement("div");
  wrapper.className = "slot-row-wrapper";

  const row = document.createElement("div");
  row.className = "skill-row";

  const nextIndex = layoutSlotsList.querySelectorAll(".slot-row-wrapper").length + 1;
  const finalSlotId = slotId || `slot-${nextIndex}`;

  const idInput = document.createElement("input");
  idInput.type = "text";
  idInput.placeholder = "slot id";
  idInput.value = finalSlotId;
  idInput.style.fontFamily = "var(--font-mono)";
  idInput.style.fontSize = "12px";

  const removeBtn = document.createElement("button");
  removeBtn.className = "skill-row-remove";
  removeBtn.type = "button";
  removeBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`;
  removeBtn.addEventListener("click", () => wrapper.remove());

  row.appendChild(idInput);
  row.appendChild(removeBtn);

  const inputToggle = document.createElement("label");
  inputToggle.className = "agent-input-toggle";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.className = "slot-input-cb";
  cb.checked = !!enableInput;
  inputToggle.appendChild(cb);
  inputToggle.appendChild(document.createTextNode(" Enable user input"));

  wrapper.appendChild(row);
  wrapper.appendChild(inputToggle);
  layoutSlotsList.appendChild(wrapper);
}

function getSlotEntries(): Array<{ slotId: string; enableInput?: boolean }> {
  const wrappers = layoutSlotsList.querySelectorAll(".slot-row-wrapper");
  const entries: Array<{ slotId: string; enableInput?: boolean }> = [];
  wrappers.forEach((wrapper, i) => {
    const idInput = wrapper.querySelector("input[type=\"text\"]") as HTMLInputElement | null;
    let id = (idInput?.value || "").trim() || `slot-${i + 1}`;
    id = id.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "") || `slot-${i + 1}`;
    const ei = (wrapper.querySelector(".slot-input-cb") as HTMLInputElement)?.checked;
    entries.push({ slotId: id, enableInput: ei || undefined });
  });
  // Dedupe: if two slots end up with the same id, suffix the duplicates.
  const seen = new Set<string>();
  return entries.map((e) => {
    let id = e.slotId;
    let n = 2;
    while (seen.has(id)) id = `${e.slotId}-${n++}`;
    seen.add(id);
    return { ...e, slotId: id };
  });
}

function clearSlotRows() {
  layoutSlotsList.innerHTML = "";
}

export { loadLayouts };

export function initLayoutsEvents() {
  document.getElementById("layout-new-btn")!.addEventListener("click", newLayout);
  document.getElementById("layout-save-btn")!.addEventListener("click", saveLayout);
  document.getElementById("layout-cancel-btn")!.addEventListener("click", cancelLayout);
  document.getElementById("layout-back-link")!.addEventListener("click", cancelLayout);
  document.getElementById("layout-delete-btn")!.addEventListener("click", deleteLayout);
  layoutSearchInput.addEventListener("input", () => { layoutsPage = 0; renderLayoutsList(); });
  layoutTypeSelect.addEventListener("change", () => {
    const isCode = layoutTypeSelect.value === "code";
    layoutCodeFields.classList.toggle("hidden", !isCode);
    layoutGridBuilder.classList.remove("hidden");
    renderGridPreview();
  });
  layoutPickDirBtn.addEventListener("click", async () => {
    const dir = await window.yo.pickDirectory();
    if (dir) layoutRootDirInput.value = dir;
  });
  layoutSlotsAddBtn.addEventListener("click", () => addSlotRow());

  // Grid builder dimension controls
  gridColsSelect.addEventListener("change", () => {
    builderCols = parseInt(gridColsSelect.value, 10);
    initBuilderCells();
    renderGridPreview();
  });
  gridRowsSelect.addEventListener("change", () => {
    builderRows = parseInt(gridRowsSelect.value, 10);
    initBuilderCells();
    renderGridPreview();
  });
  mergeRightBtn.addEventListener("click", () => {
    if (builderSelected >= 0) {
      doMergeRight(builderSelected);
      renderGridPreview();
    }
  });
  mergeDownBtn.addEventListener("click", () => {
    if (builderSelected >= 0) {
      doMergeDown(builderSelected);
      renderGridPreview();
    }
  });
  splitBtn.addEventListener("click", () => {
    if (builderSelected >= 0) {
      doSplit(builderSelected);
      renderGridPreview();
    }
  });
}
