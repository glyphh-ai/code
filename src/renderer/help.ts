/**
 * Help overlay — combined docs + settings (library, skills, layouts, panels).
 */

const overlay = document.getElementById("help-overlay")!;
const navItems = document.querySelectorAll<HTMLButtonElement>(".help-nav-item");
const sections = document.querySelectorAll<HTMLDivElement>(".help-section");

// ── Open / close ─────────────────────────────────────────

export function openHelp() {
  window.yo.panelsHide();
  overlay.classList.remove("hidden");
  loadActiveSection();
}

export function closeHelp() {
  overlay.classList.add("hidden");
  window.yo.panelsShow();
}

export function isHelpOpen(): boolean {
  return !overlay.classList.contains("hidden");
}

// ── Navigation ───────────────────────────────────────────

navItems.forEach((item) => {
  item.addEventListener("click", () => {
    navItems.forEach((n) => n.classList.remove("active"));
    sections.forEach((s) => s.classList.remove("active"));
    item.classList.add("active");
    document.querySelector(`.help-section[data-section="${item.dataset.section}"]`)!.classList.add("active");
    loadActiveSection();
  });
});

function activeSection(): string {
  return (document.querySelector(".help-nav-item.active") as HTMLElement).dataset.section!;
}

function loadActiveSection() {
  const sec = activeSection();
  if (sec === "library") loadLibrary();
  else if (sec === "skills") loadSkills();
  else if (sec === "layouts") loadLayouts();
  else if (sec === "panels") loadPanels();
}

// ── Init ─────────────────────────────────────────────────

export function initHelp() {
  document.getElementById("help-close")!.addEventListener("click", closeHelp);

  document.getElementById("dismiss-check")!.addEventListener("change", (e) => {
    window.yo.setPreference("hideWelcome", (e.target as HTMLInputElement).checked);
  });

  // Library
  document.getElementById("library-save-btn")!.addEventListener("click", saveLibraryItem);
  document.getElementById("library-new-btn")!.addEventListener("click", newLibraryItem);

  // Skills
  document.getElementById("skills-save-btn")!.addEventListener("click", saveSkillItem);
  document.getElementById("skills-new-btn")!.addEventListener("click", newSkillItem);

  // Layouts
  document.getElementById("layout-new-btn")!.addEventListener("click", newLayout);
  document.getElementById("layout-save-btn")!.addEventListener("click", saveLayout);

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

  // Panels
  document.getElementById("panel-add-btn")!.addEventListener("click", addPanel);
}

// ── Library ──────────────────────────────────────────────

const libraryList = document.getElementById("library-list")!;
const libraryEditor = document.getElementById("library-editor")!;
const libraryEditName = document.getElementById("library-edit-name")!;
const libraryEditContent = document.getElementById("library-edit-content") as HTMLTextAreaElement;

async function loadLibrary() {
  libraryEditor.classList.add("hidden");
  const items = await window.yo.libraryList();
  if (items.length === 0) {
    libraryList.innerHTML = `<div class="empty-state">No files yet. Use <strong>yo &lt;name&gt;</strong> to save context.</div>`;
    return;
  }
  libraryList.innerHTML = items.map((name) => `
    <div class="item-row" data-name="${name}">
      <span class="item-name">${name}.md</span>
      <div class="item-actions">
        <button class="edit-btn">edit</button>
        <button class="danger delete-btn">delete</button>
      </div>
    </div>`).join("");

  libraryList.querySelectorAll(".item-row").forEach((row) => {
    row.addEventListener("click", () => editLibraryItem((row as HTMLElement).dataset.name!));
  });
  libraryList.querySelectorAll(".edit-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      editLibraryItem((btn.closest(".item-row") as HTMLElement).dataset.name!);
    });
  });
  libraryList.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await window.yo.libraryRemove((btn.closest(".item-row") as HTMLElement).dataset.name!);
      loadLibrary();
    });
  });
}

async function editLibraryItem(name: string) {
  const content = await window.yo.libraryRead(name);
  libraryEditName.textContent = name + ".md";
  libraryEditContent.value = content || "";
  libraryEditor.classList.remove("hidden");
  libraryEditor.dataset.name = name;
  libraryEditContent.focus();
}

async function saveLibraryItem() {
  const name = libraryEditor.dataset.name!;
  await window.yo.libraryWrite(name, libraryEditContent.value);
  libraryEditor.classList.add("hidden");
  loadLibrary();
}

async function newLibraryItem() {
  const input = document.getElementById("library-new-name") as HTMLInputElement;
  const name = input.value.trim();
  if (!name) return;
  await window.yo.libraryWrite(name, "");
  input.value = "";
  loadLibrary();
  editLibraryItem(name);
}

// ── Skills ───────────────────────────────────────────────

const skillsList = document.getElementById("skills-list")!;
const skillsEditor = document.getElementById("skills-editor")!;
const skillsEditName = document.getElementById("skills-edit-name")!;
const skillsEditContent = document.getElementById("skills-edit-content") as HTMLTextAreaElement;

async function loadSkills() {
  skillsEditor.classList.add("hidden");
  const items = await window.yo.skillsList();
  if (items.length === 0) {
    skillsList.innerHTML = `<div class="empty-state">No skills yet. Create one to process captured sessions.</div>`;
    return;
  }
  skillsList.innerHTML = items.map((name) => `
    <div class="item-row" data-name="${name}">
      <span class="item-name">${name}</span>
      <div class="item-actions">
        <button class="edit-btn">edit</button>
        <button class="danger delete-btn">delete</button>
      </div>
    </div>`).join("");

  skillsList.querySelectorAll(".item-row").forEach((row) => {
    row.addEventListener("click", () => editSkillItem((row as HTMLElement).dataset.name!));
  });
  skillsList.querySelectorAll(".edit-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      editSkillItem((btn.closest(".item-row") as HTMLElement).dataset.name!);
    });
  });
  skillsList.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await window.yo.skillsRemove((btn.closest(".item-row") as HTMLElement).dataset.name!);
      loadSkills();
    });
  });
}

async function editSkillItem(name: string) {
  const content = await window.yo.skillsRead(name);
  skillsEditName.textContent = name;
  skillsEditContent.value = content || "";
  skillsEditor.classList.remove("hidden");
  skillsEditor.dataset.name = name;
  skillsEditContent.focus();
}

async function saveSkillItem() {
  const name = skillsEditor.dataset.name!;
  await window.yo.skillsWrite(name, skillsEditContent.value);
  skillsEditor.classList.add("hidden");
  loadSkills();
}

async function newSkillItem() {
  const input = document.getElementById("skills-new-name") as HTMLInputElement;
  const name = input.value.trim();
  if (!name) return;
  await window.yo.skillsWrite(name, "");
  input.value = "";
  loadSkills();
  editSkillItem(name);
}

// ── Layouts (Grid Builder) ──────────────────────────────────

const layoutsList = document.getElementById("layouts-list")!;
const layoutEditor = document.getElementById("layout-editor")!;
const layoutEditName = document.getElementById("layout-edit-name")!;
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
      return `<div class="${cls.join(" ")}" data-index="${i}"
        style="grid-column: ${cell.col + 1} / span ${cell.colSpan}; grid-row: ${cell.row + 1} / span ${cell.rowSpan}">
        ${cell.panelId || "\u2014"}
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
  // Capture position before re-render destroys the anchor element
  const rect = anchor.getBoundingClientRect();
  builderSelected = cellIndex;
  renderGridPreview();

  const panels = await window.yo.panelsList();
  const picker = document.createElement("div");
  picker.className = "cell-panel-picker";
  picker.style.left = `${rect.left}px`;
  picker.style.top = `${rect.bottom + 4}px`;

  picker.innerHTML = [
    `<div class="cell-panel-option empty" data-id="">Empty</div>`,
    ...panels.map((p) => `<div class="cell-panel-option" data-id="${p.id}">${p.id}</div>`),
  ].join("");

  document.body.appendChild(picker);

  picker.querySelectorAll(".cell-panel-option").forEach((opt) => {
    opt.addEventListener("click", (ev) => {
      ev.stopPropagation();
      builderCells[cellIndex].panelId = (opt as HTMLElement).dataset.id!;
      picker.remove();
      renderGridPreview();
    });
  });

  const closePicker = (ev: MouseEvent) => {
    if (!(ev.target as HTMLElement).closest(".cell-panel-picker")) {
      picker.remove();
      document.removeEventListener("click", closePicker);
    }
  };
  setTimeout(() => document.addEventListener("click", closePicker), 0);
}

async function loadLayouts() {
  layoutEditor.classList.add("hidden");
  const items = await window.yo.layoutsList();
  if (items.length === 0) {
    layoutsList.innerHTML = `<div class="empty-state">No layouts yet. Create one to arrange panels your way.</div>`;
    return;
  }
  layoutsList.innerHTML = items
    .map(
      (layout) => `
    <div class="item-row" data-name="${layout.name}">
      <span class="item-name">${layout.name}</span>
      <span class="item-meta">${layout.splits.map((s) => s.panelId).join(" | ")}</span>
      <div class="item-actions">
        <button class="edit-btn">edit</button>
        <button class="danger delete-btn">delete</button>
      </div>
    </div>`,
    )
    .join("");

  layoutsList.querySelectorAll(".item-row").forEach((row) => {
    row.addEventListener("click", () => editLayout((row as HTMLElement).dataset.name!));
  });
  layoutsList.querySelectorAll(".edit-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      editLayout((btn.closest(".item-row") as HTMLElement).dataset.name!);
    });
  });
  layoutsList.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await window.yo.layoutsDelete((btn.closest(".item-row") as HTMLElement).dataset.name!);
      loadLayouts();
    });
  });
}

async function editLayout(name: string) {
  const layouts = await window.yo.layoutsList();
  const layout = layouts.find((l) => l.name === name);
  if (layout) {
    // Reconstruct builder state from layout cells
    const panelIds = layout.splits.map((s) => s.panelId);
    builderCols = panelIds.length;
    builderRows = 1;
    initBuilderCells();
    builderCells.forEach((c, i) => {
      if (i < panelIds.length) c.panelId = panelIds[i];
    });
  } else {
    builderCols = 2;
    builderRows = 1;
    initBuilderCells();
  }
  gridColsSelect.value = String(builderCols);
  gridRowsSelect.value = String(builderRows);
  layoutEditName.textContent = name;
  layoutEditor.classList.remove("hidden");
  layoutEditor.dataset.name = name;
  renderGridPreview();
}

async function newLayout() {
  const input = document.getElementById("layout-new-name") as HTMLInputElement;
  const name = input.value.trim();
  if (!name) return;
  builderCols = 2;
  builderRows = 1;
  initBuilderCells();
  gridColsSelect.value = "2";
  gridRowsSelect.value = "1";
  layoutEditName.textContent = name;
  layoutEditor.classList.remove("hidden");
  layoutEditor.dataset.name = name;
  input.value = "";
  renderGridPreview();
}

async function saveLayout() {
  const name = layoutEditor.dataset.name!;
  const assignedCells = builderCells.filter((c) => c.panelId);
  if (assignedCells.length < 1) return;
  await window.yo.layoutsSaveGrid({
    name,
    cols: builderCols,
    rows: builderRows,
    colWidths: Array(builderCols).fill(1 / builderCols),
    rowHeights: Array(builderRows).fill(1 / builderRows),
    cells: assignedCells,
  });
  layoutEditor.classList.add("hidden");
  loadLayouts();
}

// ── Panels ───────────────────────────────────────────────

const panelsList = document.getElementById("panels-list")!;

async function loadPanels() {
  const panels = await window.yo.panelsList();
  panelsList.innerHTML = panels.map((p) => `
    <div class="item-row">
      <span class="item-name">${p.id}</span>
      <span class="item-meta">${p.url}</span>
    </div>`).join("");
}

async function addPanel() {
  const input = document.getElementById("panel-new-url") as HTMLInputElement;
  const url = input.value.trim();
  if (!url) return;
  const id = url.replace(/https?:\/\//, "").split(/[./]/)[0];
  await window.yo.panelsAdd(id, url);
  input.value = "";
  loadPanels();
}
