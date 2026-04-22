/**
 * Help overlay — combined docs + settings (layouts, panels, apps).
 */

import { showOnboarding } from "./onboarding.js";

// ── Confirm modal ──────────────────────────────────────────

function confirmAction(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.getElementById("confirm-modal")!;
    document.getElementById("confirm-message")!.textContent = message;
    overlay.classList.remove("hidden");

    const yesBtn = document.getElementById("confirm-yes")!;
    const noBtn = document.getElementById("confirm-no")!;

    function cleanup() {
      overlay.classList.add("hidden");
      yesBtn.removeEventListener("click", onYes);
      noBtn.removeEventListener("click", onNo);
    }
    function onYes() { cleanup(); resolve(true); }
    function onNo() { cleanup(); resolve(false); }

    yesBtn.addEventListener("click", onYes);
    noBtn.addEventListener("click", onNo);
  });
}

function clearInvalid(el: HTMLElement) {
  el.addEventListener("input", () => el.classList.remove("invalid"), { once: true });
}

// ── Pagination utility ──────────────────────────────────────
const PAGE_SIZE = 50;

interface PaginationState {
  page: number;
  totalPages: number;
  total: number;
}

function renderPaginationBar(state: PaginationState, onPage: (page: number) => void): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "pagination-bar";
  if (state.totalPages <= 1) return bar;

  const info = document.createElement("span");
  info.className = "pagination-info";
  const start = state.page * PAGE_SIZE + 1;
  const end = Math.min((state.page + 1) * PAGE_SIZE, state.total);
  info.textContent = `${start}–${end} of ${state.total}`;

  const nav = document.createElement("div");
  nav.className = "pagination-nav";

  const prev = document.createElement("button");
  prev.className = "pagination-btn";
  prev.textContent = "‹ Prev";
  prev.disabled = state.page === 0;
  prev.addEventListener("click", () => onPage(state.page - 1));

  // Page buttons — show max 7 with ellipsis
  const pages: (number | "...")[] = [];
  const tp = state.totalPages;
  const cp = state.page;
  if (tp <= 7) {
    for (let i = 0; i < tp; i++) pages.push(i);
  } else {
    pages.push(0);
    if (cp > 2) pages.push("...");
    for (let i = Math.max(1, cp - 1); i <= Math.min(tp - 2, cp + 1); i++) pages.push(i);
    if (cp < tp - 3) pages.push("...");
    pages.push(tp - 1);
  }

  const next = document.createElement("button");
  next.className = "pagination-btn";
  next.textContent = "Next ›";
  next.disabled = state.page >= state.totalPages - 1;
  next.addEventListener("click", () => onPage(state.page + 1));

  nav.appendChild(prev);
  for (const p of pages) {
    if (p === "...") {
      const ell = document.createElement("span");
      ell.className = "pagination-ellipsis";
      ell.textContent = "…";
      nav.appendChild(ell);
    } else {
      const btn = document.createElement("button");
      btn.className = "pagination-btn" + (p === state.page ? " active" : "");
      btn.textContent = String(p + 1);
      btn.addEventListener("click", () => onPage(p));
      nav.appendChild(btn);
    }
  }
  nav.appendChild(next);

  bar.appendChild(info);
  bar.appendChild(nav);
  return bar;
}

function paginate<T>(items: T[], page: number): { items: T[]; state: PaginationState } {
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  return {
    items: items.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE),
    state: { page: safePage, totalPages, total: items.length },
  };
}

const overlay = document.getElementById("help-overlay")!;
const navItems = document.querySelectorAll<HTMLButtonElement>(".help-nav-item");
const sections = document.querySelectorAll<HTMLDivElement>(".help-section");
const navSubItems = document.querySelectorAll<HTMLButtonElement>(".help-nav-sub-item");

// ── Open / close ─────────────────────────────────────────

let helpTransitioning = false;

export function openHelp() {
  if (helpTransitioning) return;
  helpTransitioning = true;
  setTimeout(() => { helpTransitioning = false; }, 300);
  window.yo.panelsHide();
  overlay.classList.remove("hidden");
  loadActiveSection();
}

export function openSettings(sub?: string) {
  switchToSection("settings");
  if (sub) {
    // Activate the specific settings sub-panel
    const settingsNavItems = document.querySelectorAll<HTMLButtonElement>(".help-section[data-section='settings'] .settings-nav-item");
    const settingsPanels = document.querySelectorAll<HTMLDivElement>(".help-section[data-section='settings'] .settings-panel");
    settingsNavItems.forEach((n) => n.classList.toggle("active", n.dataset.sub === sub));
    settingsPanels.forEach((p) => p.classList.toggle("active", p.dataset.sub === sub));
    // Also highlight the sub-item in sidebar
    navSubItems.forEach((s) => s.classList.toggle("active", s.dataset.section === "settings" && s.dataset.sub === sub));
  }
  openHelp();
}

export function closeHelp() {
  if (helpTransitioning) return;
  helpTransitioning = true;
  setTimeout(() => { helpTransitioning = false; }, 300);
  overlay.classList.add("hidden");
  window.yo.panelsShow();
}

export function isHelpOpen(): boolean {
  return !overlay.classList.contains("hidden");
}

// ── Navigation ───────────────────────────────────────────

function resetEditors() {
  // Skills
  const se = document.getElementById("skill-editor");
  if (se && !se.classList.contains("hidden")) {
    se.classList.add("hidden");
    document.getElementById("skills-list")?.classList.remove("hidden");
    document.getElementById("skills-toolbar")?.classList.remove("hidden");
  }
  // Layouts
  const le = document.getElementById("layout-editor");
  if (le && !le.classList.contains("hidden")) {
    le.classList.add("hidden");
    document.getElementById("layouts-list")?.classList.remove("hidden");
    document.getElementById("layouts-toolbar")?.classList.remove("hidden");
  }
  // Rips
  const re = document.getElementById("rip-editor");
  if (re && !re.classList.contains("hidden")) {
    re.classList.add("hidden");
    document.getElementById("rips-list")?.classList.remove("hidden");
    document.getElementById("rips-toolbar")?.classList.remove("hidden");
  }
  // Apps
  const ad = document.getElementById("app-detail");
  if (ad && !ad.classList.contains("hidden")) {
    ad.classList.add("hidden");
    document.getElementById("apps-list")?.classList.remove("hidden");
    document.getElementById("apps-toolbar")?.classList.remove("hidden");
    const preview = document.getElementById("app-preview") as HTMLElement & { src: string } | null;
    if (preview) preview.src = "about:blank";
  }
  const af = document.getElementById("app-add-form");
  if (af && !af.classList.contains("hidden")) {
    af.classList.add("hidden");
    document.getElementById("apps-list")?.classList.remove("hidden");
    document.getElementById("apps-toolbar")?.classList.remove("hidden");
  }
  // MCP
  document.getElementById("mcp-detail-panel")?.classList.add("hidden");
  document.getElementById("mcp-custom-panel")?.classList.add("hidden");
  document.getElementById("mcp-servers-list")?.classList.remove("hidden");
  document.getElementById("mcp-toolbar")?.classList.remove("hidden");
}

function switchToSection(sectionId: string) {
  resetEditors();
  navItems.forEach((n) => n.classList.remove("active"));
  sections.forEach((s) => s.classList.remove("active"));
  const navItem = document.querySelector(`.help-nav-item[data-section="${sectionId}"]`) as HTMLElement;
  const section = document.querySelector(`.help-section[data-section="${sectionId}"]`) as HTMLElement;
  if (navItem) navItem.classList.add("active");
  if (section) section.classList.add("active");
}

navItems.forEach((item) => {
  item.addEventListener("click", () => {
    if (item.classList.contains("has-sub")) {
      // Toggle dropdown expand/collapse — don't switch section
      item.classList.toggle("expanded");
    } else {
      // Regular nav item — switch section, collapse all dropdowns
      collapseAllDropdowns();
      navSubItems.forEach((s) => s.classList.remove("active"));
      switchToSection(item.dataset.section!);
      loadActiveSection();
    }
  });
});

function collapseAllDropdowns() {
  navItems.forEach((n) => n.classList.remove("expanded"));
}

// ── Sidebar sub-navigation (dropdown items) ──────────────

navSubItems.forEach((sub) => {
  sub.addEventListener("click", () => {
    const sectionId = sub.dataset.section!;
    const subId = sub.dataset.sub!;

    // Collapse the dropdown after selection
    collapseAllDropdowns();

    // Activate the parent section
    switchToSection(sectionId);

    // Highlight this sub-item
    navSubItems.forEach((s) => s.classList.remove("active"));
    sub.classList.add("active");

    if (sectionId === "docs") {
      loadDocs();
      showDocPanel(subId);
    } else if (sectionId === "settings") {
      loadActiveSection();
      // Switch to specific settings sub-panel
      const settingsNavItems = document.querySelectorAll<HTMLButtonElement>(".help-section[data-section='settings'] .settings-nav-item");
      const settingsPanels = document.querySelectorAll<HTMLDivElement>(".help-section[data-section='settings'] .settings-panel");
      settingsNavItems.forEach((n) => n.classList.toggle("active", n.dataset.sub === subId));
      settingsPanels.forEach((p) => p.classList.toggle("active", p.dataset.sub === subId));
    }
  });
});

// ── Settings inner sub-navigation ────────────────────────

const settingsSubNav = document.querySelectorAll<HTMLButtonElement>(".help-section[data-section='settings'] .settings-nav-item");
const settingsSubPanels = document.querySelectorAll<HTMLDivElement>(".help-section[data-section='settings'] .settings-panel");

settingsSubNav.forEach((btn) => {
  btn.addEventListener("click", () => {
    settingsSubNav.forEach((n) => n.classList.remove("active"));
    settingsSubPanels.forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    const target = document.querySelector(`.help-section[data-section='settings'] .settings-panel[data-sub="${btn.dataset.sub}"]`);
    if (target) target.classList.add("active");
    // Sync sidebar sub-item highlight
    navSubItems.forEach((s) => s.classList.toggle("active", s.dataset.section === "settings" && s.dataset.sub === btn.dataset.sub));
  });
});

// ── Docs inner sub-navigation ────────────────────────────

const docsSubNav = document.querySelectorAll<HTMLButtonElement>(".docs-nav .settings-nav-item");
const docsPanels = document.querySelectorAll<HTMLDivElement>(".docs-panel");

function showDocPanel(docId: string) {
  docsSubNav.forEach((n) => n.classList.toggle("active", n.dataset.doc === docId));
  docsPanels.forEach((p) => p.classList.toggle("active", p.dataset.doc === docId));
  // Sync sidebar sub-item highlight
  navSubItems.forEach((s) => s.classList.toggle("active", s.dataset.section === "docs" && s.dataset.sub === docId));
  // Scroll to top
  const container = document.querySelector(".docs-panels");
  if (container) container.scrollTop = 0;
}

docsSubNav.forEach((btn) => {
  btn.addEventListener("click", () => {
    showDocPanel(btn.dataset.doc!);
  });
});

function activeSection(): string {
  return (document.querySelector(".help-nav-item.active") as HTMLElement)?.dataset.section || "guide";
}

function loadActiveSection() {
  const sec = activeSection();
  if (sec === "skills") loadSkills();
  else if (sec === "layouts") loadLayouts();
  else if (sec === "apps") loadApps();
  else if (sec === "settings") loadSettings();
  else if (sec === "docs") loadDocs();
  else if (sec === "support") loadSupport();
  else if (sec === "about") loadAbout();
}

// ── Init ─────────────────────────────────────────────────

export function initHelp() {
  document.getElementById("help-close")!.addEventListener("click", closeHelp);

  // User menu (bottom of help nav)
  document.getElementById("user-menu-platform")!.addEventListener("click", () => {
    closeHelp();
    window.yo.urlBarNavigate(window.yo.platformUrl);
  });
  document.getElementById("user-menu-logout")!.addEventListener("click", async () => {
    await window.yo.logout();
    // Hide help overlay without restoring panels (they should stay hidden for onboarding)
    overlay.classList.add("hidden");
    window.yo.panelsHide();
    showOnboarding(true);
  });

  // Settings
  initSettings();

  // Apps (unified: local apps + connections)
  initApps();

  // Layouts
  document.getElementById("layout-new-btn")!.addEventListener("click", newLayout);
  document.getElementById("layout-save-btn")!.addEventListener("click", saveLayout);
  document.getElementById("layout-cancel-btn")!.addEventListener("click", cancelLayout);
  document.getElementById("layout-back-link")!.addEventListener("click", cancelLayout);
  document.getElementById("layout-delete-btn")!.addEventListener("click", deleteLayout);
  layoutSearchInput.addEventListener("input", () => { layoutsPage = 0; renderLayoutsList(); });

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

  // Skills
  document.getElementById("skill-new-btn")!.addEventListener("click", () => openSkillEditor("", ""));
  document.getElementById("skill-save")!.addEventListener("click", saveSkill);
  document.getElementById("skill-cancel")!.addEventListener("click", closeSkillEditor);
  document.getElementById("skill-back-link")!.addEventListener("click", closeSkillEditor);
  document.getElementById("skill-delete")!.addEventListener("click", deleteSkill);
  document.getElementById("skill-generate")!.addEventListener("click", generateSkillPrompt);
  skillSearchInput.addEventListener("input", () => { skillsPage = 0; renderSkillsList(); });

  // Apps
  document.getElementById("app-detail-close")!.addEventListener("click", closeAppDetail);

  // DOM Picker
  document.getElementById("app-pick-btn")!.addEventListener("click", pickElement);
  document.getElementById("map-save-btn")!.addEventListener("click", saveMapping);
  document.getElementById("map-cancel-btn")!.addEventListener("click", () => {
    appMapCommand.classList.add("hidden");
  });
  const mapKeySelect = document.getElementById("map-command-key") as HTMLSelectElement;
  mapKeySelect.addEventListener("change", () => {
    document.getElementById("map-custom-key")!.classList.toggle("hidden", mapKeySelect.value !== "__custom__");
  });
  document.getElementById("app-preview-refresh")!.addEventListener("click", () => {
    appPreview.reload();
  });
}

// ── Layouts (Grid Builder) ──────────────────────────────────

let layoutsPage = 0;
let allLayouts: Array<{ name: string; splits: Array<{ panelId: string; col?: number; row?: number; colSpan?: number; rowSpan?: number }> }> = [];
const layoutsList = document.getElementById("layouts-list")!;
const layoutEditor = document.getElementById("layout-editor")!;
const layoutsToolbar = document.getElementById("layouts-toolbar")!;
const layoutSearchInput = document.getElementById("layout-search") as HTMLInputElement;
const layoutNameInput = document.getElementById("layout-new-name") as HTMLInputElement;
const layoutFormError = document.getElementById("layout-form-error")!;
const layoutDeleteBtn = document.getElementById("layout-delete-btn") as HTMLButtonElement;
const layoutEditorTitle: HTMLElement | null = document.getElementById("layout-editor-title");
let editingLayoutName: string | null = null;
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

  const apps = await window.yo.appsList();

  const picker = document.createElement("div");
  picker.className = "cell-panel-picker";
  picker.style.left = `${rect.left}px`;
  picker.style.top = `${rect.bottom + 4}px`;

  picker.innerHTML = [
    `<input class="cell-panel-search" placeholder="Search…" autocomplete="off" spellcheck="false" />`,
    `<div class="cell-panel-options">`,
    `<div class="cell-panel-option empty" data-id="">Empty</div>`,
    ...apps.map((a) => `<div class="cell-panel-option" data-id="${a.id}">${a.name}</div>`),
    `</div>`,
  ].join("");

  document.body.appendChild(picker);

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
    const panels = layout.splits.map((s) => s.panelId).filter(Boolean).join(" | ");
    card.innerHTML = `
      <div class="crud-card-info">
        <span class="crud-card-name">${layout.name}</span>
        <span class="crud-card-meta">${panels || "empty"}</span>
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
  const assignedCells = builderCells.filter((c) => c.panelId);
  if (assignedCells.length < 1) {
    layoutFormError.textContent = "Assign at least one panel to the grid.";
    layoutFormError.classList.remove("hidden");
    return;
  }

  if (editingLayoutName && editingLayoutName !== name) {
    await window.yo.layoutsDelete(editingLayoutName);
  }

  await window.yo.layoutsSaveGrid({
    name,
    cols: builderCols,
    rows: builderRows,
    colWidths: Array(builderCols).fill(1 / builderCols),
    rowHeights: Array(builderRows).fill(1 / builderRows),
    cells: assignedCells,
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

// ── Apps (unified: local apps + Pipedream connections) ───

let appsPage = 0;
const appsList = document.getElementById("apps-list")!;
const appDetail = document.getElementById("app-detail")!;
const appAddForm = document.getElementById("app-add-form")!;
const appDetailId = document.getElementById("app-detail-id") as HTMLInputElement;
const appDetailName = document.getElementById("app-detail-name") as HTMLInputElement;
const appDetailUrl = document.getElementById("app-detail-url") as HTMLInputElement;
const appForceWeb = document.getElementById("app-detail-force-web") as HTMLInputElement;
const appDoNotRecord = document.getElementById("app-detail-do-not-record") as HTMLInputElement;
const appSearchInput = document.getElementById("app-search") as HTMLInputElement;
const appConnectStatus = document.getElementById("app-connect-status")!;
const appCommandsList = document.getElementById("app-commands-list")!;
const appMapCommand = document.getElementById("app-map-command")!;
const appPreview = document.getElementById("app-preview") as HTMLElement & {
  src: string;
  partition: string;
  getWebContentsId: () => number;
  reload: () => void;
};
const appsToolbar = document.getElementById("apps-toolbar")!;
const appFormError = document.getElementById("app-form-error")!;

let currentAppId = "";

interface PanelApp {
  id: string;
  name: string;
  url: string;
  connectedSlug?: string;
  forceWeb?: boolean;
  doNotRecord?: boolean;
  commands?: Record<string, { selector: string; action: string; description: string }>;
}

let panelApps: PanelApp[] = [];

async function loadApps() {
  appDetail.classList.add("hidden");
  appAddForm.classList.add("hidden");
  appsList.classList.remove("hidden");
  appsToolbar.classList.remove("hidden");

  try {
    const apps = await window.yo.appsList();
    panelApps = apps.map((a) => ({ id: a.id, name: a.name, url: a.url, connectedSlug: a.connectedSlug, forceWeb: a.forceWeb, doNotRecord: a.doNotRecord, commands: a.commands }));
  } catch { panelApps = []; }

  renderAppsList();
}

function renderAppsList() {
  const query = appSearchInput.value.trim().toLowerCase();

  const filtered = query
    ? panelApps.filter((a) => a.name.toLowerCase().includes(query) || a.url.toLowerCase().includes(query))
    : panelApps;

  appsList.className = "app-grid";

  if (panelApps.length === 0) {
    appsList.innerHTML = `<div class="crud-empty">No apps yet. Click "+ New" to add one.</div>`;
    return;
  }
  if (filtered.length === 0) {
    appsList.innerHTML = `<div class="crud-empty">No apps matching "${query}"</div>`;
    return;
  }

  const { items: pageApps, state } = paginate(filtered, appsPage);
  appsPage = state.page;
  appsList.innerHTML = "";

  for (const app of pageApps) {
    const isInternal = app.url.startsWith("yo://");
    const faviconUrl = isInternal
      ? ""
      : `https://www.google.com/s2/favicons?domain=${new URL(app.url).hostname}&sz=64`;
    const initial = app.name.charAt(0).toUpperCase();

    const card = document.createElement("div");
    card.className = "app-card";
    card.innerHTML = `
      <div class="app-card-icon">
        ${faviconUrl
          ? `<img src="${faviconUrl}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" /><span class="app-card-initial" style="display:none">${initial}</span>`
          : `<span class="app-card-initial">${initial}</span>`}
      </div>
      <div class="app-card-name">${app.name}</div>
      <div class="app-card-id">${app.id}</div>`;

    card.addEventListener("click", () => openPanelAppDetail(app));
    appsList.appendChild(card);
  }

  appsList.appendChild(renderPaginationBar(state, (p) => { appsPage = p; renderAppsList(); }));
}


async function openPanelAppDetail(app: PanelApp) {
  currentAppId = app.id;
  appDetailId.value = app.id;
  appDetailName.value = app.name;
  appDetailUrl.value = app.url;
  appForceWeb.checked = !!app.forceWeb;
  appDoNotRecord.checked = !!app.doNotRecord;
  appConnectStatus.textContent = "";
  appMapCommand.classList.add("hidden");

  appPreview.partition = "persist:yo";
  appPreview.src = app.url;

  await refreshCommands();
  appsList.classList.add("hidden");
  appsToolbar.classList.add("hidden");
  appAddForm.classList.add("hidden");
  appDetail.classList.remove("hidden");
}

async function refreshCommands() {
  const apps = await window.yo.appsList();
  const app = apps.find((a) => a.id === currentAppId);
  const commands = app?.commands || {};
  const keys = Object.keys(commands);

  if (keys.length === 0) {
    appCommandsList.innerHTML = `<div class="inline-empty">No commands mapped. Click "Pick Element" to add one.</div>`;
    return;
  }

  appCommandsList.innerHTML = keys.map((key) => {
    const cmd = commands[key];
    return `<div class="command-row" data-key="${key}">
      <span class="command-key">${key}</span>
      <span class="command-desc">${cmd.description || cmd.action}</span>
      <span class="command-selector" title="${cmd.selector}">${cmd.selector.length > 40 ? cmd.selector.slice(0, 40) + "…" : cmd.selector}</span>
      <div class="command-actions">
        <button class="action-btn command-edit-btn" title="Edit">Edit</button>
        <button class="action-btn command-test-btn" title="Test">Test</button>
        <button class="action-btn danger command-remove-btn" title="Remove">×</button>
      </div>
    </div>`;
  }).join("");

  appCommandsList.querySelectorAll(".command-edit-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const key = (btn.closest(".command-row") as HTMLElement).dataset.key!;
      const cmd = commands[key];
      if (!cmd) return;
      openMappingForm(key, cmd.selector, cmd.action, cmd.description || "", (cmd as any).text);
    });
  });

  appCommandsList.querySelectorAll(".command-remove-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const key = (btn.closest(".command-row") as HTMLElement).dataset.key!;
      await window.yo.appsRemoveCommand(currentAppId, key);
      refreshCommands();
    });
  });

  appCommandsList.querySelectorAll(".command-test-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const key = (btn.closest(".command-row") as HTMLElement).dataset.key!;
      const wcId = getPreviewWebContentsId();
      const result = await window.yo.appsTestCommand(currentAppId, key, wcId);
      appConnectStatus.textContent = result ? `Test ${key}: ${result.slice(0, 80)}` : `Test ${key}: executed`;
      setTimeout(() => { appConnectStatus.textContent = ""; }, 3000);
    });
  });
}

function getPreviewWebContentsId(): number | undefined {
  try { return appPreview.getWebContentsId(); } catch { return undefined; }
}

async function pickElement() {
  if (!currentAppId) return;
  const wcId = getPreviewWebContentsId();
  if (!wcId) {
    appConnectStatus.textContent = "Preview not loaded yet.";
    return;
  }

  appConnectStatus.textContent = "Click an element in the preview...";

  const helpCloseBtn = document.getElementById("help-close") as HTMLButtonElement;
  const detailCloseBtn = document.getElementById("app-detail-close") as HTMLButtonElement;
  helpCloseBtn.disabled = true;
  detailCloseBtn.disabled = true;
  helpCloseBtn.style.opacity = "0.3";
  detailCloseBtn.style.opacity = "0.3";

  const picked = await new Promise<{
    selector: string; tag: string; text: string; isEditable: boolean; isClickable: boolean;
  } | null>((resolve) => {
    window.yo.onPickerResult((result) => {
      resolve(result);
    });
    window.yo.startPicker(wcId);
  });

  helpCloseBtn.disabled = false;
  detailCloseBtn.disabled = false;
  helpCloseBtn.style.opacity = "";
  detailCloseBtn.style.opacity = "";

  if (!picked) {
    appConnectStatus.textContent = "";
    appMapCommand.classList.add("hidden");
    return;
  }

  appConnectStatus.textContent = "";

  const action = picked.isEditable ? "setValue" : picked.isClickable ? "click" : "extractText";
  const info = `<${picked.tag}>` +
    `${picked.text ? ' "' + picked.text.slice(0, 60) + '"' : ""}` +
    `${picked.isEditable ? " [editable]" : ""}${picked.isClickable ? " [clickable]" : ""}`;

  document.getElementById("map-element-info")!.textContent = info;
  openMappingForm("", picked.selector, action, "", picked.text);
}

let mappingText = "";

function openMappingForm(key: string, selector: string, action: string, description: string, text?: string) {
  document.getElementById("map-selector")!.textContent = selector;
  mappingText = text ?? "";

  const keySelect = document.getElementById("map-command-key") as HTMLSelectElement;
  const customKeyInput = document.getElementById("map-custom-key") as HTMLInputElement;
  const actionSelect = document.getElementById("map-action") as HTMLSelectElement;
  const descInput = document.getElementById("map-description") as HTMLInputElement;

  // Check if key matches a preset option
  const presetOption = keySelect.querySelector(`option[value="${key}"]`);
  if (key && presetOption) {
    keySelect.value = key;
    customKeyInput.classList.add("hidden");
  } else if (key) {
    keySelect.value = "__custom__";
    customKeyInput.value = key;
    customKeyInput.classList.remove("hidden");
  } else {
    keySelect.value = "";
    customKeyInput.value = "";
    customKeyInput.classList.add("hidden");
  }

  actionSelect.value = action;
  descInput.value = description;
  appMapCommand.classList.remove("hidden");
}

async function saveMapping() {
  const keySelect = document.getElementById("map-command-key") as HTMLSelectElement;
  const customKeyInput = document.getElementById("map-custom-key") as HTMLInputElement;
  const actionSelect = document.getElementById("map-action") as HTMLSelectElement;
  const descInput = document.getElementById("map-description") as HTMLInputElement;
  const selector = document.getElementById("map-selector")!.textContent || "";

  let key = keySelect.value;
  if (key === "__custom__") {
    key = customKeyInput.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (!key) { customKeyInput.focus(); return; }
  }
  if (!key || !selector) return;

  const mapping: Record<string, string> = {
    selector,
    action: actionSelect.value,
    description: descInput.value.trim() || key,
  };
  if (mappingText) mapping.text = mappingText;
  await window.yo.appsSetCommand(currentAppId, key, mapping as any);

  appMapCommand.classList.add("hidden");
  appConnectStatus.textContent = `Mapped: ${key}`;
  setTimeout(() => { appConnectStatus.textContent = ""; }, 2000);
  refreshCommands();
}


function closeAppDetail() {
  appPreview.src = "about:blank";
  appMapCommand.classList.add("hidden");
  appDetail.classList.add("hidden");
  appsList.classList.remove("hidden");
  appsToolbar.classList.remove("hidden");
  loadApps();
}

function initApps() {
  const addNameInput = document.getElementById("app-add-name") as HTMLInputElement;
  const addUrlInput = document.getElementById("app-add-url") as HTMLInputElement;
  const addForceWeb = document.getElementById("app-add-force-web") as HTMLInputElement;
  const addDoNotRecord = document.getElementById("app-add-do-not-record") as HTMLInputElement;

  // + New opens the add form
  document.getElementById("apps-add-btn")!.addEventListener("click", () => {
    addNameInput.value = "";
    addUrlInput.value = "";
    addForceWeb.checked = false;
    addDoNotRecord.checked = false;
    appFormError.classList.add("hidden");
    appsList.classList.add("hidden");
    appsToolbar.classList.add("hidden");
    appAddForm.classList.remove("hidden");
    addNameInput.focus();
  });

  // Add form save — create then open for editing
  document.getElementById("app-add-save")!.addEventListener("click", async () => {
    let valid = true;
    const name = addNameInput.value.trim();
    const url = addUrlInput.value.trim();
    if (!name) { addNameInput.classList.add("invalid"); clearInvalid(addNameInput); valid = false; }
    if (!url) { addUrlInput.classList.add("invalid"); clearInvalid(addUrlInput); valid = false; }
    if (!valid) {
      appFormError.textContent = "Name and URL are required.";
      appFormError.classList.remove("hidden");
      return;
    }
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
    await window.yo.appsAdd(id, name, url);
    if (addForceWeb.checked) await window.yo.appsUpdateForceWeb(id, true);
    if (addDoNotRecord.checked) await window.yo.appsUpdateDoNotRecord(id, true);
    appAddForm.classList.add("hidden");
    const apps = await window.yo.appsList();
    panelApps = apps.map((a) => ({ id: a.id, name: a.name, url: a.url, connectedSlug: a.connectedSlug, forceWeb: a.forceWeb, doNotRecord: a.doNotRecord, commands: a.commands }));
    const created = panelApps.find((a) => a.id === id);
    if (created) openPanelAppDetail(created);
    else loadApps();
  });

  // Add form cancel (breadcrumb + button)
  document.getElementById("app-add-cancel")!.addEventListener("click", () => loadApps());
  document.getElementById("app-add-cancel-btn")!.addEventListener("click", () => loadApps());

  // Detail save — persist name, url, forceWeb and go back
  document.getElementById("app-detail-save")!.addEventListener("click", async () => {
    if (!currentAppId) return;
    const newId = appDetailId.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    if (newId && newId !== currentAppId) {
      const ok = await window.yo.appsUpdateId(currentAppId, newId);
      if (ok) currentAppId = newId;
    }
    const name = appDetailName.value.trim();
    const url = appDetailUrl.value.trim();
    if (name) await window.yo.appsUpdateName(currentAppId, name);
    if (url) await window.yo.appsUpdateUrl(currentAppId, url);
    await window.yo.appsUpdateForceWeb(currentAppId, appForceWeb.checked);
    await window.yo.appsUpdateDoNotRecord(currentAppId, appDoNotRecord.checked);
    closeAppDetail();
  });

  // Detail cancel
  document.getElementById("app-detail-cancel")!.addEventListener("click", () => closeAppDetail());

  // Delete panel app (from detail view)
  document.getElementById("app-detail-delete")!.addEventListener("click", async () => {
    if (!currentAppId) return;
    const confirmed = await confirmAction(`Delete app "${appDetailName.value}"?`);
    if (!confirmed) return;
    await window.yo.appsRemove(currentAppId);
    closeAppDetail();
  });

  appSearchInput.addEventListener("input", () => { appsPage = 0; renderAppsList(); });

  // Draggable split divider
  const divider = document.getElementById("app-builder-divider")!;
  const controls = document.querySelector(".app-builder-controls") as HTMLElement;
  let dragging = false;
  let startX = 0;
  let startW = 0;

  divider.addEventListener("mousedown", (e) => {
    dragging = true;
    startX = e.clientX;
    startW = controls.offsetWidth;
    divider.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const w = Math.max(200, Math.min(800, startW + (e.clientX - startX)));
    controls.style.width = w + "px";
  });

  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });
}

// ── Settings ─────────────────────────────────────────────

const settingsProvider = document.getElementById("settings-provider") as HTMLSelectElement;
const settingsModelSelect = document.getElementById("settings-model-select") as HTMLSelectElement;
const settingsModelCustom = document.getElementById("settings-model-custom") as HTMLInputElement;
const settingsApiKey = document.getElementById("settings-api-key") as HTMLInputElement;
const settingsBaseUrl = document.getElementById("settings-base-url") as HTMLInputElement;
const settingsBaseUrlLabel = document.getElementById("settings-base-url-label")!;
const settingsSaveBtn = document.getElementById("settings-save") as HTMLButtonElement;
const settingsStatus = document.getElementById("settings-status")!;

const toggleVoiceInput = document.getElementById("toggle-voice-input") as HTMLInputElement;
const voiceKeyWrap = document.getElementById("voice-key-wrap")!;
const settingsVoiceKey = document.getElementById("settings-voice-key") as HTMLInputElement;
const toggleRemote = document.getElementById("toggle-remote") as HTMLInputElement;
const toggleVscodeServer = document.getElementById("toggle-vscode-server") as HTMLInputElement;
const toggleShowTabs = document.getElementById("toggle-show-tabs") as HTMLInputElement;
const toggleShowUrlBar = document.getElementById("toggle-show-url-bar") as HTMLInputElement;
const toggleAutoUpdate = document.getElementById("toggle-auto-update") as HTMLInputElement;
const toggleMcpExpose = document.getElementById("toggle-mcp-expose") as HTMLInputElement;
const mcpExposeSettings = document.getElementById("mcp-expose-settings")!;
const mcpExposeStatus = document.getElementById("mcp-expose-status")!;
const mcpExposePort = document.getElementById("mcp-expose-port") as HTMLInputElement;
const mcpExposeTokensEl = document.getElementById("mcp-expose-tokens")!;
const settingsContextWindow = document.getElementById("settings-context-window") as HTMLInputElement;
const settingsBrowserHome = document.getElementById("settings-browser-home") as HTMLSelectElement;
const settingsBrowserHomeUrl = document.getElementById("settings-browser-home-url") as HTMLInputElement;
const browserHomeCustomRow = document.getElementById("browser-home-custom-row")!;
const settingsAgentMode = document.getElementById("settings-agent-mode") as HTMLSelectElement;
const settingsSubagentModel = document.getElementById("settings-subagent-model") as HTMLSelectElement;
const toolOverridesBody = document.getElementById("tool-overrides-body")!;

let settingsPresets: Record<string, { name: string; models: string[]; defaultModel: string; baseUrl?: string; keyPlaceholder: string }> = {};

async function refreshMcpExposeStatus() {
  const status = await window.yo.mcpExposeStatus();
  if (status.running) {
    mcpExposeStatus.textContent = `Running on http://127.0.0.1:${status.port}`;
    mcpExposeStatus.style.color = "#25C75E";
  } else {
    mcpExposeStatus.textContent = "Stopped";
    mcpExposeStatus.style.color = "#999";
  }
}

async function renderMcpTokens() {
  const tokens = await window.yo.mcpExposeGetTokens();
  mcpExposeTokensEl.innerHTML = "";
  if (tokens.length === 0) {
    mcpExposeTokensEl.innerHTML = '<span style="font-size:11px;color:#999;">No tokens yet. Generate one to connect an external tool.</span>';
    return;
  }
  for (const t of tokens) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:6px;padding:6px 10px;background:#1a1a1a;border-radius:6px;";

    const label = document.createElement("span");
    label.style.cssText = "flex:1;font-size:12px;color:#ccc;";
    label.textContent = t.label || "Untitled";

    const created = document.createElement("span");
    created.style.cssText = "font-size:11px;color:#999;font-family:'SF Mono','Fira Code',monospace;";
    created.textContent = new Date(t.createdAt).toLocaleDateString();

    const daysLeft = Math.ceil((new Date(t.expiresAt).getTime() - Date.now()) / 86400000);
    const expires = document.createElement("span");
    expires.style.cssText = `font-size:11px;font-family:'SF Mono','Fira Code',monospace;color:${daysLeft <= 7 ? "#ef4444" : "#999"};`;
    expires.textContent = `Expires ${new Date(t.expiresAt).toLocaleDateString()}`;

    const revoke = document.createElement("button");
    revoke.className = "action-btn danger";
    revoke.style.cssText = "font-size:10px;padding:2px 8px;";
    revoke.textContent = "Revoke";
    revoke.addEventListener("click", async () => {
      await window.yo.mcpExposeRevokeToken(t.token);
      await renderMcpTokens();
    });

    row.appendChild(label);
    row.appendChild(created);
    row.appendChild(expires);
    row.appendChild(revoke);
    mcpExposeTokensEl.appendChild(row);
  }
}

function initSettings() {
  settingsProvider.addEventListener("change", () => updateSettingsUI());
  settingsSaveBtn.addEventListener("click", saveSettings);

  // Service toggles — show relaunch bar when changed
  const showRelaunch = () => {
    const bar = document.getElementById("settings-relaunch")!;
    if (bar) bar.classList.remove("hidden");
  };
  // Voice input toggle + key
  toggleVoiceInput.addEventListener("change", () => {
    window.yo.setPreference("voiceEnabled", toggleVoiceInput.checked);
    voiceKeyWrap.classList.toggle("hidden", !toggleVoiceInput.checked);
    // Show/hide mic button immediately
    const micBtn = document.getElementById("yo-panel-mic");
    if (micBtn) micBtn.style.display = toggleVoiceInput.checked ? "" : "none";
  });
  const voiceKeySaveBtn = document.getElementById("voice-key-save")!;
  const voiceKeyStatus = document.getElementById("voice-key-status")!;
  voiceKeySaveBtn.addEventListener("click", () => {
    window.yo.setPreference("voiceApiKey", settingsVoiceKey.value.trim());
    voiceKeyStatus.textContent = "Saved";
    voiceKeyStatus.className = "settings-success";
    setTimeout(() => { voiceKeyStatus.textContent = ""; }, 2000);
  });

  toggleRemote.addEventListener("change", () => {
    window.yo.setPreference("remoteEnabled", toggleRemote.checked);
  });

  toggleVscodeServer.addEventListener("change", () => {
    window.yo.setPreference("enableVscodeServer", toggleVscodeServer.checked);
    showRelaunch();
  });
  toggleAutoUpdate.addEventListener("change", () => {
    window.yo.setPreference("autoUpdate", toggleAutoUpdate.checked);
    showRelaunch();
  });

  // MCP Expose toggle
  toggleMcpExpose.addEventListener("change", async () => {
    const enabled = toggleMcpExpose.checked;
    window.yo.setPreference("mcpExposeEnabled", enabled);
    mcpExposeSettings.classList.toggle("hidden", !enabled);
    if (enabled) {
      const result = await window.yo.mcpExposeStart();
      if (!result.ok) {
        mcpExposeStatus.textContent = `Error: ${result.error}`;
        mcpExposeStatus.style.color = "#ef4444";
      } else {
        await refreshMcpExposeStatus();
      }
    } else {
      await window.yo.mcpExposeStop();
      mcpExposeStatus.textContent = "Stopped";
      mcpExposeStatus.style.color = "#999";
    }
  });
  document.getElementById("mcp-expose-port-save")!.addEventListener("click", async () => {
    const port = parseInt(mcpExposePort.value, 10);
    if (port >= 1024 && port <= 65535) {
      window.yo.setPreference("mcpExposePort", port);
      if (toggleMcpExpose.checked) {
        await window.yo.mcpExposeStop();
        const result = await window.yo.mcpExposeStart();
        if (!result.ok) {
          mcpExposeStatus.textContent = `Error: ${result.error}`;
          mcpExposeStatus.style.color = "#ef4444";
        } else {
          await refreshMcpExposeStatus();
        }
      }
    }
  });
  document.getElementById("mcp-expose-gen-token")!.addEventListener("click", async () => {
    const labelInput = document.getElementById("mcp-expose-token-label") as HTMLInputElement;
    const label = labelInput.value.trim() || "default";
    await window.yo.mcpExposeGenToken(label);
    labelInput.value = "";
    await renderMcpTokens();
  });

  settingsContextWindow.addEventListener("change", () => {
    const val = parseInt(settingsContextWindow.value, 10);
    if (val >= 10 && val <= 200) {
      window.yo.setPreference("yoContextWindow", val);
    }
  });

  // Agent mode
  settingsAgentMode.addEventListener("change", () => {
    window.yo.setAgentMode(settingsAgentMode.value);
    // Sync the yo panel dropdown too
    const yoModeEl = document.getElementById("yo-mode-select") as HTMLSelectElement;
    if (yoModeEl) yoModeEl.value = settingsAgentMode.value;
  });

  // Sub-agent model
  settingsSubagentModel.addEventListener("change", () => {
    window.yo.setPreference("subAgentModel", settingsSubagentModel.value);
  });

  toggleShowTabs.addEventListener("change", () => {
    window.yo.setPreference("showTabs", toggleShowTabs.checked);
    // Immediately refresh tab visibility
    window.yo.tabList().then((state) => {
      const tabBar = document.getElementById("tab-bar");
      const tabNewBtn = document.getElementById("tab-new-btn");
      if (tabBar) tabBar.style.display = toggleShowTabs.checked ? "flex" : "none";
      if (tabNewBtn) tabNewBtn.style.display = toggleShowTabs.checked ? "" : "none";
    });
  });

  toggleShowUrlBar.addEventListener("change", () => {
    const show = toggleShowUrlBar.checked;
    window.yo.urlBarToggle(show);
    const urlBar = document.getElementById("url-bar");
    if (urlBar) urlBar.classList.toggle("hidden", !show);
    document.body.style.setProperty("--content-top", show ? "72px" : "38px");
  });

  // Browser homepage
  settingsBrowserHome.addEventListener("change", () => {
    const val = settingsBrowserHome.value;
    browserHomeCustomRow.classList.toggle("hidden", val !== "custom");
    if (val !== "custom") {
      window.yo.setPreference("browserHomepage", val);
    }
  });
  settingsBrowserHomeUrl.addEventListener("change", () => {
    const url = settingsBrowserHomeUrl.value.trim();
    if (url) {
      window.yo.setPreference("browserHomepage", "custom");
      window.yo.setPreference("browserHomepageUrl", url);
    }
  });

  // Relaunch button
  document.getElementById("settings-relaunch-btn")?.addEventListener("click", () => {
    window.yo.relaunch();
  });

  // Account dashboard — opens platform in a browser tab
  document.getElementById("account-dashboard-btn")?.addEventListener("click", () => {
    closeHelp();
    window.yo.urlBarNavigate(window.yo.platformUrl);
  });

  // Sign out
  document.getElementById("account-logout-btn")?.addEventListener("click", async () => {
    await window.yo.logout();
    // Hide help overlay without restoring panels (they should stay hidden for onboarding)
    overlay.classList.add("hidden");
    window.yo.panelsHide();
    showOnboarding(true);
  });
}

function updateSettingsUI(currentModel?: string) {
  const provider = settingsProvider.value;
  const preset = settingsPresets[provider];

  // API key placeholder
  if (preset) {
    settingsApiKey.placeholder = `${preset.keyPlaceholder}`;
  }

  // Model dropdown vs custom input
  if (preset && preset.models.length > 0) {
    settingsModelSelect.innerHTML = preset.models.map((m) =>
      `<option value="${m}" ${m === currentModel ? "selected" : ""}>${m}</option>`
    ).join("");
    settingsModelSelect.classList.remove("hidden");
    settingsModelCustom.classList.add("hidden");
  } else {
    settingsModelSelect.classList.add("hidden");
    settingsModelCustom.classList.remove("hidden");
    if (currentModel) settingsModelCustom.value = currentModel;
  }

  // Base URL — show for custom and providers with base URLs
  const showBaseUrl = provider === "custom" || provider === "openai" || provider === "google";
  settingsBaseUrl.classList.toggle("hidden", !showBaseUrl);
  settingsBaseUrlLabel.classList.toggle("hidden", !showBaseUrl);
  if (preset?.baseUrl && !settingsBaseUrl.value) {
    settingsBaseUrl.placeholder = preset.baseUrl;
  }
}

async function loadSettings() {
  settingsStatus.textContent = "";
  const [config, presets, accountInfo, authStatus] = await Promise.all([
    window.yo.getLLMConfig(),
    window.yo.getLLMPresets(),
    window.yo.getAccountInfo(),
    window.yo.getAuthStatus(),
  ]);
  settingsPresets = presets;

  settingsProvider.value = config.provider;
  settingsApiKey.value = config.apiKey;
  settingsBaseUrl.value = config.baseUrl || "";

  updateSettingsUI(config.model);

  // Account info
  const emailEl = document.getElementById("account-email")!;
  const nameEl = document.getElementById("account-name")!;
  const orgEl = document.getElementById("account-org")!;
  const tierEl = document.getElementById("account-tier")!;
  const statusEl = document.getElementById("account-status")!;

  if (accountInfo) {
    emailEl.textContent = accountInfo.email;
    nameEl.textContent = `${accountInfo.firstName} ${accountInfo.lastName}`;
    orgEl.textContent = accountInfo.orgName;
    tierEl.textContent = accountInfo.tier || "free";
    tierEl.className = `license-value ${accountInfo.tier !== "free" ? "active" : ""}`;

    const billingStatus = accountInfo.billingStatus || authStatus.status;
    if (billingStatus === "active") {
      statusEl.textContent = "Active";
      statusEl.className = "license-value active";
    } else if (authStatus.status === "trial" && authStatus.daysRemaining) {
      statusEl.textContent = `Trial (${authStatus.daysRemaining} days left)`;
      statusEl.className = "license-value";
    } else if (billingStatus === "expired" || authStatus.status === "expired") {
      statusEl.textContent = "Expired";
      statusEl.className = "license-value expired";
    } else {
      statusEl.textContent = billingStatus;
      statusEl.className = "license-value";
    }
  } else {
    emailEl.textContent = "Not signed in";
    nameEl.textContent = "—";
    orgEl.textContent = "—";
    tierEl.textContent = "—";
    statusEl.textContent = "—";
  }

  // Load toggle states
  toggleShowTabs.checked = await window.yo.getPreference("showTabs", true) as boolean;
  toggleShowUrlBar.checked = await window.yo.getPreference("showUrlBar", true) as boolean;
  toggleVoiceInput.checked = await window.yo.getPreference("voiceEnabled", false) as boolean;
  voiceKeyWrap.classList.toggle("hidden", !toggleVoiceInput.checked);
  settingsVoiceKey.value = await window.yo.getPreference("voiceApiKey", "") as string;
  toggleRemote.checked = await window.yo.getPreference("remoteEnabled", false) as boolean;
  toggleVscodeServer.checked = await window.yo.getPreference("enableVscodeServer", false) as boolean;
  toggleAutoUpdate.checked = await window.yo.getPreference("autoUpdate", true) as boolean;
  settingsContextWindow.value = String(await window.yo.getPreference("yoContextWindow", 40));

  // MCP Expose
  const mcpEnabled = await window.yo.getPreference("mcpExposeEnabled", false) as boolean;
  toggleMcpExpose.checked = mcpEnabled;
  mcpExposeSettings.classList.toggle("hidden", !mcpEnabled);
  mcpExposePort.value = String(await window.yo.getPreference("mcpExposePort", 7860));
  if (mcpEnabled) {
    await refreshMcpExposeStatus();
    await renderMcpTokens();
  }

  // Agent mode
  const currentMode = await window.yo.getAgentMode();
  settingsAgentMode.value = currentMode;

  // Sub-agent model — populate from current provider's preset
  const currentProvider = config.provider;
  const currentPreset = presets[currentProvider];
  settingsSubagentModel.innerHTML = '<option value="auto">Auto (cheapest)</option>';
  if (currentPreset) {
    for (const m of currentPreset.models) {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m.replace(/^claude-|^gpt-|^gemini-/i, "").replace(/-\d{8}$/, "");
      settingsSubagentModel.appendChild(opt);
    }
  }
  // Also allow "same as orchestrator"
  const sameOpt = document.createElement("option");
  sameOpt.value = "orchestrator";
  sameOpt.textContent = "Same as orchestrator";
  settingsSubagentModel.appendChild(sameOpt);

  const savedSubModel = await window.yo.getPreference("subAgentModel", "auto") as string;
  settingsSubagentModel.value = savedSubModel;

  // Tool overrides table
  const tools = await window.yo.getToolRegistry();
  toolOverridesBody.innerHTML = "";
  for (const tool of tools) {
    const tr = document.createElement("tr");
    tr.className = "tool-row";

    const tdName = document.createElement("td");
    tdName.className = "tool-td-name";
    tdName.textContent = tool.label;

    const tdDesc = document.createElement("td");
    tdDesc.className = "tool-td-desc";
    tdDesc.textContent = tool.description;

    const tdTier = document.createElement("td");
    tdTier.className = "tool-td-tier";
    const tierBadge = document.createElement("span");
    tierBadge.className = `tool-tier-badge tier-${tool.tier}`;
    tierBadge.textContent = tool.tier;
    tdTier.appendChild(tierBadge);

    const tdPerm = document.createElement("td");
    tdPerm.className = "tool-td-perm";
    const select = document.createElement("select");
    select.className = "tool-perm-select";
    select.innerHTML =
      `<option value="default"${tool.override === "default" ? " selected" : ""}>Default</option>` +
      `<option value="auto"${tool.override === "auto" ? " selected" : ""}>Auto</option>` +
      `<option value="ask"${tool.override === "ask" ? " selected" : ""}>Ask</option>`;
    select.addEventListener("change", () => {
      window.yo.setToolOverride(tool.name, select.value);
    });
    tdPerm.appendChild(select);

    tr.appendChild(tdName);
    tr.appendChild(tdDesc);
    tr.appendChild(tdTier);
    tr.appendChild(tdPerm);
    toolOverridesBody.appendChild(tr);
  }

  // Browser homepage
  const homePref = await window.yo.getPreference("browserHomepage", "claude") as string;
  settingsBrowserHome.value = homePref === "custom" ? "custom" : homePref;
  browserHomeCustomRow.classList.toggle("hidden", homePref !== "custom");
  if (homePref === "custom") {
    settingsBrowserHomeUrl.value = await window.yo.getPreference("browserHomepageUrl", "") as string;
  }
}

async function saveSettings() {
  const provider = settingsProvider.value;
  const preset = settingsPresets[provider];
  const model = (preset && preset.models.length > 0)
    ? settingsModelSelect.value
    : settingsModelCustom.value.trim();
  // Use existing key if the field wasn't changed
  const currentConfig = await window.yo.getLLMConfig();
  const apiKey = settingsApiKey.value.trim() || currentConfig.apiKey;

  if (!apiKey) {
    settingsStatus.textContent = "API key is required";
    settingsStatus.className = "settings-error";
    return;
  }

  settingsSaveBtn.disabled = true;
  settingsSaveBtn.textContent = "Saving...";
  settingsStatus.textContent = "";

  const config: { provider: string; model: string; apiKey: string; baseUrl?: string } = {
    provider,
    model,
    apiKey,
  };
  const baseUrl = settingsBaseUrl.value.trim();
  if (baseUrl) config.baseUrl = baseUrl;

  const result = await window.yo.saveLLMConfig(config);
  settingsSaveBtn.disabled = false;
  settingsSaveBtn.textContent = "Save";

  if (result.ok) {
    settingsStatus.textContent = "Saved!";
    settingsStatus.className = "settings-success";
  } else {
    settingsStatus.textContent = result.error || "Validation failed";
    settingsStatus.className = "settings-error";
  }
}

// ── App Mapping ─────────────────────────────────────────


// ── Skills ────────────────────────────────────────────────

let skillsPage = 0;
let allSkills: string[] = [];
const skillsListEl = document.getElementById("skills-list")!;
const skillsToolbar = document.getElementById("skills-toolbar")!;
const skillEditor = document.getElementById("skill-editor")!;
const skillNameInput = document.getElementById("skill-name") as HTMLInputElement;
const skillDescInput = document.getElementById("skill-desc") as HTMLTextAreaElement;
const skillPromptArea = document.getElementById("skill-prompt") as HTMLTextAreaElement;
const skillDeleteBtn = document.getElementById("skill-delete") as HTMLButtonElement;
const skillSearchInput = document.getElementById("skill-search") as HTMLInputElement;
const skillFormError = document.getElementById("skill-form-error")!;
let editingSkillName: string | null = null;

const skillEditorTitle: HTMLElement | null = document.getElementById("skill-editor-title");

async function loadSkills() {
  skillEditor.classList.add("hidden");
  skillFormError.classList.add("hidden");
  allSkills = await window.yo.skillsList();
  renderSkillsList();
}

function renderSkillsList() {
  const query = skillSearchInput.value.trim().toLowerCase();
  const filtered = query ? allSkills.filter((s) => s.toLowerCase().includes(query)) : allSkills;

  if (allSkills.length === 0) {
    skillsListEl.innerHTML = `<div class="crud-empty">No skills yet. Click "+ New" to create one.</div>`;
    return;
  }
  if (filtered.length === 0) {
    skillsListEl.innerHTML = `<div class="crud-empty">No skills matching "${query}"</div>`;
    return;
  }

  const { items, state } = paginate(filtered, skillsPage);
  skillsPage = state.page;
  skillsListEl.innerHTML = "";

  for (const name of items) {
    const cleanName = name.replace(/\.md$/i, "");
    const card = document.createElement("div");
    card.className = "crud-card";
    card.innerHTML = `
      <div class="crud-card-info">
        <span class="crud-card-name">${cleanName}</span>
      </div>
      <div class="crud-card-actions">
        <button class="crud-card-btn crud-edit-btn" title="Edit">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
        </button>
        <button class="crud-card-btn danger crud-delete-btn" title="Delete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
        </button>
      </div>`;

    card.querySelector(".crud-edit-btn")!.addEventListener("click", async (e) => {
      e.stopPropagation();
      const prompt = await window.yo.skillsRead(name);
      openSkillEditor(cleanName, prompt || "");
    });

    card.querySelector(".crud-delete-btn")!.addEventListener("click", async (e) => {
      e.stopPropagation();
      const confirmed = await confirmAction(`Delete skill "${cleanName}"?`);
      if (!confirmed) return;
      await window.yo.skillsRemove(name);
      loadSkills();
    });

    card.addEventListener("click", async () => {
      const prompt = await window.yo.skillsRead(name);
      openSkillEditor(cleanName, prompt || "");
    });

    skillsListEl.appendChild(card);
  }
  skillsListEl.appendChild(renderPaginationBar(state, (p) => { skillsPage = p; renderSkillsList(); }));
}

function openSkillEditor(name: string, prompt: string) {
  editingSkillName = name || null;
  skillNameInput.value = name;
  skillDescInput.value = "";
  skillPromptArea.value = prompt;
  skillDeleteBtn.style.display = name ? "" : "none";
  if (skillEditorTitle) skillEditorTitle.textContent = name ? name : "New Skill";
  skillFormError.classList.add("hidden");

  skillsListEl.classList.add("hidden");
  skillsToolbar.classList.add("hidden");
  skillEditor.classList.remove("hidden");
  skillNameInput.focus();
}

function closeSkillEditor() {
  skillEditor.classList.add("hidden");
  skillsListEl.classList.remove("hidden");
  skillsToolbar.classList.remove("hidden");
  editingSkillName = null;
  loadSkills();
}

async function saveSkill() {
  let valid = true;
  const name = skillNameInput.value.trim().replace(/\.md$/i, "");
  const prompt = skillPromptArea.value.trim();

  if (!name) { skillNameInput.classList.add("invalid"); clearInvalid(skillNameInput); valid = false; }
  if (!prompt) { skillPromptArea.classList.add("invalid"); clearInvalid(skillPromptArea); valid = false; }
  if (!valid) {
    skillFormError.textContent = "Please fill in all required fields.";
    skillFormError.classList.remove("hidden");
    return;
  }

  if (editingSkillName && editingSkillName !== name) {
    await window.yo.skillsRemove(editingSkillName);
  }
  await window.yo.skillsWrite(name, prompt);
  editingSkillName = name;
  closeSkillEditor();
}

async function deleteSkill() {
  if (!editingSkillName) return;
  const confirmed = await confirmAction(`Delete skill "${editingSkillName}"?`);
  if (!confirmed) return;
  await window.yo.skillsRemove(editingSkillName);
  closeSkillEditor();
}

async function generateSkillPrompt() {
  const name = skillNameInput.value.trim();
  const desc = skillDescInput.value.trim();
  if (!desc) { skillDescInput.focus(); return; }

  const btn = document.getElementById("skill-generate") as HTMLButtonElement;
  btn.textContent = "Working...";
  btn.disabled = true;

  try {
    const result = await window.yo.skillsGenerate(name || "unnamed", desc);
    if (result) {
      skillPromptArea.value = result;
    }
  } catch {}

  btn.textContent = "Generate";
  btn.disabled = false;
}

// ── About ─────────────────────────────────────────────────

// ── Docs ──────────────────────────────────────────────────

function loadDocs() {
  // Docs sub-nav is handled above (docsSubNav click handlers)
  // Nothing dynamic to load — all content is static HTML
}

// ── Support ───────────────────────────────────────────────
const DISCORD_INVITE = "https://discord.gg/7wR9amSs";

let supportInitialized = false;

function loadSupport() {
  if (supportInitialized) return;
  supportInitialized = true;

  const discordLink = document.getElementById("support-discord-link")!;
  discordLink.addEventListener("click", () => {
    window.yo.openExternal(DISCORD_INVITE);
  });

  const form = document.getElementById("support-form") as HTMLFormElement;
  const subjectInput = document.getElementById("support-subject") as HTMLInputElement;
  const descInput = document.getElementById("support-description") as HTMLTextAreaElement;
  const submitBtn = document.getElementById("support-submit-btn") as HTMLButtonElement;
  const statusEl = document.getElementById("support-status")!;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const subject = subjectInput.value.trim();
    const description = descInput.value.trim();
    if (!subject || !description) return;

    submitBtn.disabled = true;
    submitBtn.textContent = "Sending...";
    statusEl.textContent = "";
    statusEl.className = "support-status";

    const result = await window.yo.submitSupportTicket({ subject, description });

    if (result.ok) {
      statusEl.textContent = "Ticket submitted! We'll get back to you soon.";
      statusEl.className = "support-status success";
      subjectInput.value = "";
      descInput.value = "";
    } else {
      statusEl.textContent = result.error || "Failed to submit ticket. Try Discord instead.";
      statusEl.className = "support-status error";
    }

    submitBtn.disabled = false;
    submitBtn.textContent = "Submit";
  });
}

// ── About ─────────────────────────────────────────────────
async function loadAbout() {
  // Version from package.json via main process
  const versionEl = document.getElementById("about-version");
  if (versionEl) {
    const ver = await window.yo.getAppVersion();
    versionEl.textContent = `Version ${ver}`;
  }

  // Terms of Use
  const termsEl = document.querySelector("#policy-terms .policy-content");
  if (termsEl) termsEl.innerHTML = TERMS_OF_USE;

  // Privacy Policy
  const privacyEl = document.querySelector("#policy-privacy .policy-content");
  if (privacyEl) privacyEl.innerHTML = PRIVACY_POLICY;

  // Refund Policy
  const refundEl = document.querySelector("#policy-refund .policy-content");
  if (refundEl) refundEl.innerHTML = REFUND_POLICY;
}

const TERMS_OF_USE = `
<p><strong>Effective Date:</strong> January 1, 2026</p>
<p>These Terms of Use ("Terms") govern your access to and use of .Yo, a desktop application and related services ("Service") provided by Glyphh AI LLC ("Company", "we", "us"). By installing, accessing, or using the Service, you agree to be bound by these Terms.</p>

<p><strong>1. Eligibility</strong></p>
<p>You must be at least 13 years old to use the Service. If you are under 18, you represent that your parent or legal guardian has reviewed and agreed to these Terms on your behalf.</p>

<p><strong>2. Account and License</strong></p>
<p>Use of the Service requires a valid license key. You are responsible for keeping your license key confidential. Each license is personal and non-transferable. You may activate your license on up to two (2) machines simultaneously. Sharing, reselling, or distributing your license key is prohibited and may result in immediate revocation.</p>

<p><strong>3. Acceptable Use</strong></p>
<p>You agree not to:</p>
<ul>
  <li>Reverse engineer, decompile, or disassemble the Service</li>
  <li>Use the Service to violate any applicable law or regulation</li>
  <li>Attempt to gain unauthorized access to the Service or its related systems</li>
  <li>Use the Service to transmit malware, spam, or any harmful content</li>
  <li>Interfere with the operation of the Service or other users' use of the Service</li>
  <li>Resell, sublicense, or redistribute the Service without written permission</li>
</ul>

<p><strong>4. Intellectual Property</strong></p>
<p>The Service, including all software, designs, trademarks, and content, is the intellectual property of Glyphh AI LLC. Your license grants a limited, non-exclusive, non-transferable, revocable right to use the Service for personal or internal business purposes only.</p>

<p><strong>5. Third-Party Services</strong></p>
<p>.Yo integrates with third-party AI services (e.g., Anthropic, OpenAI, Google AI). Your use of those services is governed by their respective terms and privacy policies. You are responsible for providing your own API keys and complying with third-party terms. Glyphh AI LLC is not responsible for the availability, accuracy, or conduct of third-party services.</p>

<p><strong>6. User Content</strong></p>
<p>You retain ownership of all content you create, capture, or process using the Service. We do not claim any ownership over your data. You are solely responsible for the content you process through the Service and for ensuring that your use complies with applicable laws and third-party rights.</p>

<p><strong>7. Service Availability</strong></p>
<p>We strive to maintain continuous availability but do not guarantee uninterrupted access. The Service may be temporarily unavailable for maintenance, updates, or due to circumstances beyond our control. We reserve the right to modify, suspend, or discontinue any part of the Service at any time with reasonable notice.</p>

<p><strong>8. Limitation of Liability</strong></p>
<p>TO THE MAXIMUM EXTENT PERMITTED BY LAW, GLYPHH AI LLC SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF DATA, PROFITS, OR REVENUE, ARISING OUT OF OR RELATED TO YOUR USE OF THE SERVICE. OUR TOTAL LIABILITY SHALL NOT EXCEED THE AMOUNT YOU PAID US IN THE TWELVE (12) MONTHS PRECEDING THE CLAIM.</p>

<p><strong>9. Disclaimer of Warranties</strong></p>
<p>THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED. WE DISCLAIM ALL WARRANTIES INCLUDING, BUT NOT LIMITED TO, IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT.</p>

<p><strong>10. Termination</strong></p>
<p>We may terminate or suspend your access to the Service at any time for violation of these Terms. Upon termination, your license is revoked and you must cease all use of the Service. Sections 4, 6, 8, 9, and 11 survive termination.</p>

<p><strong>11. Governing Law</strong></p>
<p>These Terms are governed by the laws of the State of Delaware, without regard to conflict of law principles. Any disputes shall be resolved in the state or federal courts located in Delaware.</p>

<p><strong>12. Changes to Terms</strong></p>
<p>We may update these Terms from time to time. Continued use of the Service after changes constitutes acceptance of the revised Terms. Material changes will be communicated through the application or via email.</p>

<p><strong>13. Contact</strong></p>
<p>For questions about these Terms, contact us at support@yosup.dev.</p>
`;

const PRIVACY_POLICY = `
<p><strong>Effective Date:</strong> January 1, 2026</p>
<p>This Privacy Policy describes how Glyphh AI LLC ("Company", "we", "us") collects, uses, and protects your information when you use .Yo ("Service").</p>

<p><strong>1. Information We Collect</strong></p>
<p><strong>Account Information:</strong> When you register or purchase a license, we collect your email address, license key, and payment information (processed by Stripe). We do not store your full payment card details.</p>
<p><strong>Usage Data:</strong> We may collect anonymized, aggregated data about how the Service is used (e.g., feature usage, error reports) to improve the product. This data cannot be used to identify you personally.</p>
<p><strong>Device Information:</strong> For license activation and validation, we generate a machine fingerprint (a one-way hash of hardware identifiers). This hash cannot be used to identify your specific hardware.</p>

<p><strong>2. Information We Do NOT Collect</strong></p>
<ul>
  <li>We do not collect, transmit, or store the content of your AI conversations</li>
  <li>We do not collect your API keys (these are stored locally on your machine)</li>
  <li>We do not collect your captured context, library items, or skills</li>
  <li>We do not track your browsing activity within the Service's embedded panels</li>
  <li>We do not sell or share your personal information with third parties for advertising</li>
</ul>

<p><strong>3. Local-First Architecture</strong></p>
<p>.Yo is designed with a local-first architecture. Your data — including captured context, skills, layouts, preferences, and API keys — is stored exclusively on your local machine in the <code>~/yo/</code> directory. If you enable Cloud Sync (Basic plan and above), your library data is encrypted and synced to our servers. You can disable Cloud Sync at any time, and request deletion of cloud-stored data.</p>

<p><strong>4. How We Use Information</strong></p>
<ul>
  <li>To provide, maintain, and improve the Service</li>
  <li>To process payments and manage your subscription</li>
  <li>To validate your license and prevent unauthorized use</li>
  <li>To communicate with you about the Service (updates, security alerts)</li>
  <li>To comply with legal obligations</li>
</ul>

<p><strong>5. Third-Party Services</strong></p>
<p>When you use .Yo with third-party AI providers (Anthropic, OpenAI, Google AI, etc.), your prompts and data are sent directly from your machine to those providers using your own API keys. We do not proxy, intercept, or store this data. Please review the privacy policies of those providers.</p>
<p>We use Stripe for payment processing. Stripe's handling of your payment information is governed by <a href="https://stripe.com/privacy" style="color:#25C75E">Stripe's Privacy Policy</a>.</p>

<p><strong>6. Data Security</strong></p>
<p>We implement industry-standard security measures to protect the information we collect, including encryption in transit (TLS) and at rest. However, no method of transmission or storage is 100% secure, and we cannot guarantee absolute security.</p>

<p><strong>7. Data Retention</strong></p>
<p>We retain account and license information for the duration of your subscription plus 90 days. Payment records are retained as required by law. You may request deletion of your account data at any time by contacting us.</p>

<p><strong>8. Your Rights</strong></p>
<p>Depending on your jurisdiction, you may have the right to:</p>
<ul>
  <li>Access the personal data we hold about you</li>
  <li>Request correction of inaccurate data</li>
  <li>Request deletion of your data</li>
  <li>Object to or restrict processing of your data</li>
  <li>Data portability</li>
</ul>
<p>To exercise these rights, contact us at support@yosup.dev.</p>

<p><strong>9. Children's Privacy</strong></p>
<p>The Service is not intended for children under 13. We do not knowingly collect personal information from children under 13. If we become aware that we have collected such information, we will take steps to delete it.</p>

<p><strong>10. International Transfers</strong></p>
<p>If you are accessing the Service from outside the United States, your information may be transferred to and processed in the United States. By using the Service, you consent to such transfer.</p>

<p><strong>11. Changes to This Policy</strong></p>
<p>We may update this Privacy Policy from time to time. We will notify you of material changes through the application or via email. Continued use of the Service after changes constitutes acceptance.</p>

<p><strong>12. Contact</strong></p>
<p>For privacy-related questions or requests, contact us at support@yosup.dev.</p>
`;

const REFUND_POLICY = `
<p><strong>Effective Date:</strong> January 1, 2026</p>
<p>This Refund Policy applies to paid subscriptions for .Yo offered by Glyphh AI LLC.</p>

<p><strong>1. Free Tier</strong></p>
<p>The free tier of .Yo is available at no cost and requires no payment. No refund applies.</p>

<p><strong>2. Paid Subscriptions (Basic, Advanced)</strong></p>
<p>Paid plans are billed on a monthly subscription basis. You may cancel your subscription at any time.</p>

<p><strong>3. Refund Eligibility</strong></p>
<p>We offer a full refund within 14 days of your first subscription payment ("Refund Window") if you are not satisfied with the Service. To request a refund during this window, contact us at support@yosup.dev with your license key and the email associated with your account.</p>

<p><strong>4. After the Refund Window</strong></p>
<p>After the 14-day Refund Window, subscription payments are non-refundable. When you cancel your subscription, you retain access to paid features through the end of your current billing period. No partial refunds are issued for unused time within a billing cycle.</p>

<p><strong>5. Plan Changes</strong></p>
<p>If you upgrade from Basic to Advanced, you will be charged the prorated difference for the remainder of your billing cycle. If you downgrade, the change takes effect at the start of your next billing cycle. No refunds are issued for downgrades.</p>

<p><strong>6. Service Disruption</strong></p>
<p>If the Service experiences a significant outage or disruption lasting more than 72 continuous hours, you may be eligible for a prorated credit at our discretion. Contact support@yosup.dev to report service disruptions.</p>

<p><strong>7. Revoked Licenses</strong></p>
<p>If your license is revoked due to a violation of our Terms of Use, no refund will be issued.</p>

<p><strong>8. How to Cancel</strong></p>
<p>You can cancel your subscription at any time through the Settings section of the .Yo application. Alternatively, contact support@yosup.dev. Cancellation takes effect at the end of your current billing period.</p>

<p><strong>9. Contact</strong></p>
<p>For billing or refund questions, contact us at support@yosup.dev.</p>
`;

// Export policy HTML for use in onboarding
export { TERMS_OF_USE, PRIVACY_POLICY, REFUND_POLICY };
