/**
 * Help overlay — combined docs + settings (layouts, panels, apps).
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

export function openSettings() {
  // Switch to settings tab
  navItems.forEach((n) => n.classList.remove("active"));
  sections.forEach((s) => s.classList.remove("active"));
  const settingsNav = document.querySelector('.help-nav-item[data-section="settings"]') as HTMLElement;
  const settingsSec = document.querySelector('.help-section[data-section="settings"]') as HTMLElement;
  if (settingsNav) settingsNav.classList.add("active");
  if (settingsSec) settingsSec.classList.add("active");
  openHelp();
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

// ── Settings sub-navigation ─────────────────────────────

const settingsSubNav = document.querySelectorAll<HTMLButtonElement>(".settings-nav-item");
const settingsSubPanels = document.querySelectorAll<HTMLDivElement>(".settings-panel");

settingsSubNav.forEach((btn) => {
  btn.addEventListener("click", () => {
    settingsSubNav.forEach((n) => n.classList.remove("active"));
    settingsSubPanels.forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    const target = document.querySelector(`.settings-panel[data-sub="${btn.dataset.sub}"]`);
    if (target) target.classList.add("active");
  });
});

function activeSection(): string {
  return (document.querySelector(".help-nav-item.active") as HTMLElement).dataset.section!;
}

function loadActiveSection() {
  const sec = activeSection();
  if (sec === "skills") loadSkills();
  else if (sec === "layouts") loadLayouts();
  else if (sec === "apps") loadApps();
  else if (sec === "settings") loadSettings();
  else if (sec === "support") loadSupport();
  else if (sec === "about") loadAbout();
}

// ── Init ─────────────────────────────────────────────────

export function initHelp() {
  document.getElementById("help-close")!.addEventListener("click", closeHelp);

  // Settings
  initSettings();

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

  // Skills
  document.getElementById("skill-new-btn")!.addEventListener("click", () => openSkillEditor("", ""));
  document.getElementById("skill-save")!.addEventListener("click", saveSkill);
  document.getElementById("skill-cancel")!.addEventListener("click", closeSkillEditor);
  document.getElementById("skill-delete")!.addEventListener("click", deleteSkill);
  document.getElementById("skill-generate")!.addEventListener("click", generateSkillPrompt);

  // Apps
  document.getElementById("app-add-btn")!.addEventListener("click", addApp);
  document.getElementById("app-connect-btn")!.addEventListener("click", connectApp);
  document.getElementById("app-pick-btn")!.addEventListener("click", pickElement);
  document.getElementById("app-detail-close")!.addEventListener("click", closeAppDetail);
  document.getElementById("map-save-btn")!.addEventListener("click", saveMapping);
  document.getElementById("map-cancel-btn")!.addEventListener("click", () => {
    appMapCommand.classList.add("hidden");
  });

  // Search
  appSearchInput.addEventListener("input", () => renderAppsList());

  // Rename on blur / enter
  appDetailName.addEventListener("blur", () => {
    const name = appDetailName.value.trim();
    if (currentAppId && name) window.yo.appsUpdateName(currentAppId, name);
  });
  appDetailName.addEventListener("keydown", (e) => {
    if (e.key === "Enter") appDetailName.blur();
  });

  // ID rename on blur / enter
  const appDetailId = document.getElementById("app-detail-id") as HTMLInputElement;
  appDetailId.addEventListener("blur", async () => {
    const newId = appDetailId.value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+$/, "");
    if (currentAppId && newId && newId !== currentAppId) {
      const ok = await window.yo.appsUpdateId(currentAppId, newId);
      if (ok) {
        currentAppId = newId;
        appDetailId.value = newId;
      } else {
        appDetailId.value = currentAppId; // revert
      }
    }
  });
  appDetailId.addEventListener("keydown", (e) => {
    if (e.key === "Enter") appDetailId.blur();
  });

  // Delete from detail screen
  document.getElementById("app-detail-delete")!.addEventListener("click", async () => {
    if (!currentAppId) return;
    await window.yo.appsRemove(currentAppId);
    closeAppDetail();
  });

  // Export from detail screen
  document.getElementById("app-detail-export")!.addEventListener("click", () => {
    const app = allApps.find((a) => a.id === currentAppId);
    if (app) exportAppConfig(app);
  });

  // Import from toolbar
  const importBtn = document.getElementById("app-import-btn")!;
  const importFile = document.getElementById("app-import-file") as HTMLInputElement;
  importBtn.addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", async () => {
    const file = importFile.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const config = JSON.parse(text);
      if (!config.id || !config.name || !config.url) {
        appConnectStatus.textContent = "Invalid app config: missing id, name, or url";
        return;
      }
      await window.yo.appsImport(config);
      loadApps();
    } catch {
      appConnectStatus.textContent = "Failed to parse app config file";
    }
    importFile.value = "";
  });

  document.getElementById("app-preview-refresh")!.addEventListener("click", () => {
    appPreview.reload();
  });

  const mapCommandKey = document.getElementById("map-command-key") as HTMLSelectElement;
  mapCommandKey.addEventListener("change", () => {
    const custom = document.getElementById("map-custom-key") as HTMLInputElement;
    if (mapCommandKey.value === "__custom__") {
      custom.classList.remove("hidden");
      custom.focus();
    } else {
      custom.classList.add("hidden");
    }
  });
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
  const items = await window.yo.layoutsList();
  if (items.length === 0) {
    layoutsList.innerHTML = `<div class="inline-empty">No layouts yet. Create one to arrange panels your way.</div>`;
    return;
  }
  layoutsList.innerHTML = items
    .map(
      (layout) => `
    <div class="item-row" data-name="${layout.name}">
      <span class="item-name">${layout.name}</span>
      <span class="item-meta">${layout.splits.map((s) => s.panelId).join(" | ")}</span>
      <div class="action-btns">
        <button class="action-btn edit-btn">Edit</button>
        <button class="action-btn danger delete-btn">Delete</button>
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
    // Restore full grid state from saved layout
    builderCols = layout.cols || 2;
    builderRows = layout.rows || 1;
    initBuilderCells();
    // Place panels in their saved grid positions
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

// ── Apps ─────────────────────────────────────────────────

const appsList = document.getElementById("apps-list")!;
const appDetail = document.getElementById("app-detail")!;
const appDetailName = document.getElementById("app-detail-name") as HTMLInputElement;
const appDetailUrl = document.getElementById("app-detail-url")!;
const appSearchInput = document.getElementById("app-search") as HTMLInputElement;
const appConnectStatus = document.getElementById("app-connect-status")!;
const appCommandsList = document.getElementById("app-commands-list")!;
const appMapCommand = document.getElementById("app-map-command")!;
const appPreview = document.getElementById("app-preview") as HTMLElement & {
  src: string;
  partition: string;
  useragent: string;
  getWebContentsId: () => number;
  executeJavaScript: (code: string) => Promise<unknown>;
  reload: () => void;
};

let currentAppId = "";

interface AppData {
  id: string;
  name: string;
  url: string;
  connected: boolean;
  commands: Record<string, { selector: string; action: string; description: string }>;
  meta?: { description: string; capabilities: string[] };
}

let allApps: AppData[] = [];

function exportAppConfig(app: AppData): void {
  const blob = new Blob([JSON.stringify(app, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${app.id}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function loadApps() {
  appDetail.classList.add("hidden");
  appsList.classList.remove("hidden");
  allApps = await window.yo.appsList();
  renderAppsList();
}

function renderAppsList() {
  const query = appSearchInput.value.trim().toLowerCase();
  const apps = query
    ? allApps.filter((a) => a.id.includes(query) || a.name.toLowerCase().includes(query) || a.url.toLowerCase().includes(query))
    : allApps;
  if (allApps.length === 0) {
    appsList.innerHTML = `<div class="inline-empty">No apps yet. Add a web app to connect it to yo/dip.</div>`;
    return;
  }
  if (apps.length === 0) {
    appsList.innerHTML = `<div class="inline-empty">No apps matching "${query}"</div>`;
    return;
  }
  appsList.innerHTML = apps.map((app) => `
    <div class="app-card" data-id="${app.id}">
      <div class="app-card-header">
        <span class="app-card-name">${app.name}</span>
        <span class="app-card-status ${app.connected ? "connected" : ""}">${app.connected ? "connected" : "not connected"}</span>
      </div>
      <div class="app-card-url">${app.url}</div>
      <div class="app-card-commands">
        ${Object.keys(app.commands).length > 0
          ? Object.keys(app.commands).map((k) => `<span class="app-cmd-chip">${k}</span>`).join("")
          : '<span class="app-cmd-none">no commands mapped</span>'}
      </div>
      <div class="action-btns">
        <button class="action-btn app-card-edit">Configure</button>
        <button class="action-btn app-card-export">Export</button>
        <button class="action-btn danger app-card-delete">Delete</button>
      </div>
    </div>`).join("");

  appsList.querySelectorAll(".app-card").forEach((card) => {
    const id = (card as HTMLElement).dataset.id!;
    card.querySelector(".app-card-edit")!.addEventListener("click", (e) => {
      e.stopPropagation();
      openAppDetail(id);
    });
    card.querySelector(".app-card-export")!.addEventListener("click", (e) => {
      e.stopPropagation();
      const app = allApps.find((a) => a.id === id);
      if (app) exportAppConfig(app);
    });
    card.querySelector(".app-card-delete")!.addEventListener("click", async (e) => {
      e.stopPropagation();
      await window.yo.appsRemove(id);
      loadApps();
    });
    card.addEventListener("click", () => openAppDetail(id));
  });
}

async function addApp() {
  const nameInput = document.getElementById("app-new-name") as HTMLInputElement;
  const urlInput = document.getElementById("app-new-url") as HTMLInputElement;
  const url = urlInput.value.trim();
  if (!url) return;
  const name = nameInput.value.trim() || url.replace(/https?:\/\//, "").split(/[./]/)[0];
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
  await window.yo.appsAdd(id, name, url);
  nameInput.value = "";
  urlInput.value = "";
  loadApps();
  openAppDetail(id);
}

async function openAppDetail(id: string) {
  currentAppId = id;
  const apps: AppData[] = await window.yo.appsList();
  const app = apps.find((a) => a.id === id);
  if (!app) return;

  (document.getElementById("app-detail-id") as HTMLInputElement).value = app.id;
  appDetailName.value = app.name;
  appDetailUrl.textContent = app.url;
  appConnectStatus.textContent = "";
  appMapCommand.classList.add("hidden");

  // Load app in the embedded webview preview (strip Electron token so sites don't flag it)
  appPreview.partition = `persist:panel-${id}`;
  appPreview.useragent = navigator.userAgent.replace(/Electron\/\S+\s*/g, "").replace(/\s+/g, " ").trim();
  appPreview.src = app.url;

  renderCommands(app);
  appsList.classList.add("hidden");
  appDetail.classList.remove("hidden");
}

function closeAppDetail() {
  // Unload the preview and reset state
  appPreview.src = "about:blank";
  appMapCommand.classList.add("hidden");
  appDetail.classList.add("hidden");
  appsList.classList.remove("hidden");
  loadApps();
}

function getPreviewWebContentsId(): number | undefined {
  try {
    return appPreview.getWebContentsId();
  } catch {
    return undefined;
  }
}

function renderCommands(app: AppData) {
  const standardKeys = ["grab"];
  const customKeys = Object.keys(app.commands).filter((k) => !standardKeys.includes(k));

  let html = '<div class="commands-section"><h4>Standard Commands</h4><p class="commands-hint"><b>grab</b> extracts the main content from the page. All other commands are custom per-app.</p>';
  for (const key of standardKeys) {
    const cmd = app.commands[key];
    html += `
      <div class="command-row ${cmd ? "mapped" : "unmapped"}">
        <span class="command-key">${key}</span>
        ${cmd
          ? `<span class="command-desc">${cmd.description}</span>
             <span class="command-selector">${cmd.selector.slice(0, 50)}</span>
             <div class="action-btns command-actions">
               <button class="action-btn test-cmd" data-key="${key}">Test</button>
               <button class="action-btn danger remove-cmd" data-key="${key}">Remove</button>
             </div>`
          : `<span class="command-desc unmapped-label">not mapped</span>`
        }
      </div>`;
  }
  html += "</div>";

  if (customKeys.length > 0) {
    html += '<div class="commands-section"><h4>App Commands</h4>';
    for (const key of customKeys) {
      const cmd = app.commands[key];
      html += `
        <div class="command-row mapped">
          <span class="command-key">${key}</span>
          <span class="command-desc">${cmd.description}</span>
          <span class="command-selector">${cmd.selector.slice(0, 50)}</span>
          <div class="action-btns command-actions">
            <button class="action-btn test-cmd" data-key="${key}">Test</button>
            <button class="action-btn danger remove-cmd" data-key="${key}">Remove</button>
          </div>
        </div>`;
    }
    html += "</div>";
  }

  if (app.meta) {
    html += `<div class="app-meta">
      <span class="app-meta-desc">${app.meta.description}</span>
      ${app.meta.capabilities.length > 0
        ? `<div class="app-meta-caps">${app.meta.capabilities.map((c) => `<span class="cap-chip">${c}</span>`).join("")}</div>`
        : ""}
    </div>`;
  }

  appCommandsList.innerHTML = html;

  // Test buttons — run against the embedded webview
  appCommandsList.querySelectorAll(".test-cmd").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const key = (btn as HTMLElement).dataset.key!;
      const result = await window.yo.appsTestCommand(currentAppId, key, getPreviewWebContentsId());
      appConnectStatus.textContent = `Test ${key}: ${result.slice(0, 200)}`;
      appConnectStatus.className = "app-status-msg";
    });
  });

  // Remove buttons
  appCommandsList.querySelectorAll(".remove-cmd").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const key = (btn as HTMLElement).dataset.key!;
      await window.yo.appsRemoveCommand(currentAppId, key);
      openAppDetail(currentAppId);
    });
  });
}

async function connectApp() {
  if (!currentAppId) return;
  appConnectStatus.textContent = "Analyzing page DOM...";
  appConnectStatus.className = "app-status-msg connecting";

  // Use the embedded webview for analysis
  const result = await window.yo.appsConnect(currentAppId, getPreviewWebContentsId());
  if (result.ok) {
    appConnectStatus.textContent = `Connected! Mapped ${result.commandCount} commands.`;
    appConnectStatus.className = "app-status-msg success";
    // Refresh command list without reloading preview
    const apps: AppData[] = await window.yo.appsList();
    const app = apps.find((a) => a.id === currentAppId);
    if (app) renderCommands(app);
  } else {
    appConnectStatus.textContent = `Failed: ${result.error}`;
    appConnectStatus.className = "app-status-msg error";
  }
}

// DOM Picker — injects into webContents via main process, result comes back via IPC
async function pickElement() {
  if (!currentAppId) return;
  appConnectStatus.textContent = "Click an element in the preview...";
  appConnectStatus.className = "app-status-msg connecting";

  const wcId = getPreviewWebContentsId();
  if (!wcId) {
    appConnectStatus.textContent = "Preview not loaded yet.";
    appConnectStatus.className = "app-status-msg error";
    return;
  }

  // Wait for picker result via IPC (main process injects script + listens for console-message)
  const picked = await new Promise<{
    selector: string; tag: string; text: string; isEditable: boolean; isClickable: boolean;
  } | null>((resolve) => {
    window.yo.onPickerResult((result) => {
      resolve(result as typeof picked);
    });
    window.yo.startPicker(wcId);
  });

  if (!picked) {
    appConnectStatus.textContent = "Cancelled.";
    appConnectStatus.className = "app-status-msg";
    appMapCommand.classList.add("hidden");
    return;
  }

  appConnectStatus.textContent = "";

  // Show mapping form
  document.getElementById("map-selector")!.textContent = picked.selector || "unknown";
  document.getElementById("map-element-info")!.textContent =
    `<${picked.tag || "?"}>` +
    `${picked.text ? ' "' + picked.text.slice(0, 60) + '"' : ""}` +
    `${picked.isEditable ? " [editable]" : ""}${picked.isClickable ? " [clickable]" : ""}`;

  const actionSelect = document.getElementById("map-action") as HTMLSelectElement;
  if (picked.isEditable) actionSelect.value = "setValue";
  else if (picked.isClickable) actionSelect.value = "click";
  else actionSelect.value = "extractText";

  appMapCommand.classList.remove("hidden");
  (document.getElementById("map-command-key") as HTMLSelectElement).value = "";
  (document.getElementById("map-description") as HTMLInputElement).value = "";
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

const toggleVscodeServer = document.getElementById("toggle-vscode-server") as HTMLInputElement;
const toggleShowTabs = document.getElementById("toggle-show-tabs") as HTMLInputElement;
const toggleShowUrlBar = document.getElementById("toggle-show-url-bar") as HTMLInputElement;
const toggleAutoUpdate = document.getElementById("toggle-auto-update") as HTMLInputElement;
const settingsContextWindow = document.getElementById("settings-context-window") as HTMLInputElement;
const settingsBrowserHome = document.getElementById("settings-browser-home") as HTMLSelectElement;
const settingsBrowserHomeUrl = document.getElementById("settings-browser-home-url") as HTMLInputElement;
const browserHomeCustomRow = document.getElementById("browser-home-custom-row")!;
const settingsAgentMode = document.getElementById("settings-agent-mode") as HTMLSelectElement;
const settingsSubagentModel = document.getElementById("settings-subagent-model") as HTMLSelectElement;
const toolOverridesBody = document.getElementById("tool-overrides-body")!;

let settingsPresets: Record<string, { name: string; models: string[]; defaultModel: string; baseUrl?: string; keyPlaceholder: string }> = {};

function initSettings() {
  settingsProvider.addEventListener("change", () => updateSettingsUI());
  settingsSaveBtn.addEventListener("click", saveSettings);

  // Service toggles — show relaunch bar when changed
  const showRelaunch = () => {
    const bar = document.getElementById("settings-relaunch")!;
    if (bar) bar.classList.remove("hidden");
  };
  toggleVscodeServer.addEventListener("change", () => {
    window.yo.setPreference("enableVscodeServer", toggleVscodeServer.checked);
    showRelaunch();
  });
  toggleAutoUpdate.addEventListener("change", () => {
    window.yo.setPreference("autoUpdate", toggleAutoUpdate.checked);
    showRelaunch();
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

  // License button — checkout for new users, billing portal for existing
  document.getElementById("license-upgrade-btn")?.addEventListener("click", async () => {
    const btn = document.getElementById("license-upgrade-btn") as HTMLButtonElement;
    const origText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Opening...";
    const info = await window.yo.getLicenseInfo();
    let url: string | null = null;
    if (info.status === "licensed") {
      url = await window.yo.getBillingPortalUrl();
    } else {
      url = await window.yo.getCheckoutUrlForPlan("pro");
    }
    if (!url) {
      const statusEl = document.getElementById("settings-status")!;
      statusEl.textContent = "Could not reach api.yosup.dev — check your connection";
      statusEl.className = "settings-error";
    }
    btn.disabled = false;
    btn.textContent = origText;
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
  const [config, presets, licenseInfo] = await Promise.all([
    window.yo.getLLMConfig(),
    window.yo.getLLMPresets(),
    window.yo.getLicenseInfo(),
  ]);
  settingsPresets = presets;

  settingsProvider.value = config.provider;
  settingsApiKey.value = config.apiKey;
  settingsBaseUrl.value = config.baseUrl || "";

  updateSettingsUI(config.model);

  // License info
  const statusEl = document.getElementById("license-status")!;
  const keyEl = document.getElementById("license-key")!;

  const isLicensed = licenseInfo.status === "licensed";

  if (isLicensed) {
    statusEl.textContent = "Licensed";
    statusEl.className = "license-value active";
  } else if (licenseInfo.status === "trial" && licenseInfo.daysRemaining) {
    statusEl.textContent = `Trial (${licenseInfo.daysRemaining} days left)`;
    statusEl.className = "license-value";
  } else {
    statusEl.textContent = "Expired";
    statusEl.className = "license-value expired";
  }
  keyEl.textContent = licenseInfo.key || "None";

  // License key input
  const licenseKeyInput = document.getElementById("license-key-input") as HTMLInputElement;
  const licenseActivateBtn = document.getElementById("license-activate-btn") as HTMLButtonElement;
  const licenseActivateStatus = document.getElementById("license-activate-status")!;

  licenseActivateBtn.addEventListener("click", async () => {
    const key = licenseKeyInput.value.trim();
    if (!key) return;
    licenseActivateBtn.disabled = true;
    licenseActivateBtn.textContent = "Activating...";
    licenseActivateStatus.textContent = "";
    const ok = await window.yo.activateLicense(key);
    if (ok) {
      licenseActivateStatus.textContent = "License activated!";
      licenseActivateStatus.className = "license-activate-status success";
      licenseKeyInput.value = "";
      // Refresh the display
      const updated = await window.yo.getLicenseInfo();
      statusEl.textContent = "Licensed";
      statusEl.className = "license-value active";
      keyEl.textContent = updated.key || key.slice(0, 4) + "..." + key.slice(-4);
      upgradeBtn.textContent = "Manage Subscription";
      // Hide the activate form
      if (inputRow) inputRow.style.display = "none";
      setTimeout(() => { licenseActivateStatus.style.display = "none"; }, 2000);
    } else {
      licenseActivateStatus.textContent = "Invalid key or could not reach server";
      licenseActivateStatus.className = "license-activate-status error";
    }
    licenseActivateBtn.disabled = false;
    licenseActivateBtn.textContent = "Activate";
  });

  // Hide activate form when already licensed
  const inputRow = document.querySelector(".license-input-row") as HTMLElement | null;
  if (inputRow) inputRow.style.display = isLicensed ? "none" : "";
  licenseActivateStatus.style.display = isLicensed ? "none" : "";

  // Context-aware button labels
  const upgradeBtn = document.getElementById("license-upgrade-btn") as HTMLButtonElement;
  const cancelBtn = document.getElementById("license-cancel-btn") as HTMLButtonElement;
  if (isLicensed) {
    upgradeBtn.textContent = "Manage Subscription";
    cancelBtn.style.display = "none";  // manage sub handles cancel too
  } else {
    upgradeBtn.textContent = "Get License";
    cancelBtn.style.display = "none";
  }

  // Load toggle states
  toggleShowTabs.checked = await window.yo.getPreference("showTabs", true) as boolean;
  toggleShowUrlBar.checked = await window.yo.getPreference("showUrlBar", true) as boolean;
  toggleVscodeServer.checked = await window.yo.getPreference("enableVscodeServer", false) as boolean;
  toggleAutoUpdate.checked = await window.yo.getPreference("autoUpdate", true) as boolean;
  settingsContextWindow.value = String(await window.yo.getPreference("yoContextWindow", 40));

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

async function saveMapping() {
  const keySelect = document.getElementById("map-command-key") as HTMLSelectElement;
  const customKeyInput = document.getElementById("map-custom-key") as HTMLInputElement;
  const actionSelect = document.getElementById("map-action") as HTMLSelectElement;
  const descInput = document.getElementById("map-description") as HTMLInputElement;
  const selector = document.getElementById("map-selector")!.textContent || "";

  let commandKey = keySelect.value;
  if (commandKey === "__custom__") {
    commandKey = customKeyInput.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
  }
  if (!commandKey || !selector) return;

  const description = descInput.value.trim() || commandKey;

  await window.yo.appsSetCommand(currentAppId, commandKey, {
    selector,
    action: actionSelect.value,
    description,
  });

  appMapCommand.classList.add("hidden");
  appConnectStatus.textContent = `Mapped: ${commandKey}`;
  appConnectStatus.className = "app-status-msg success";
  // Refresh command list without reloading preview
  const apps: AppData[] = await window.yo.appsList();
  const app = apps.find((a) => a.id === currentAppId);
  if (app) renderCommands(app);
}

// ── Skills ────────────────────────────────────────────────

const skillsListEl = document.getElementById("skills-list")!;
const skillsToolbar = document.getElementById("skills-toolbar")!;
const skillEditor = document.getElementById("skill-editor")!;
const skillNameInput = document.getElementById("skill-name") as HTMLInputElement;
const skillDescInput = document.getElementById("skill-desc") as HTMLInputElement;
const skillPromptArea = document.getElementById("skill-prompt") as HTMLTextAreaElement;
const skillDeleteBtn = document.getElementById("skill-delete") as HTMLButtonElement;
let editingSkillName: string | null = null;

async function loadSkills() {
  skillEditor.classList.add("hidden");
  skillsListEl.classList.remove("hidden");
  skillsToolbar.classList.remove("hidden");
  const skills = await window.yo.skillsList();
  if (skills.length === 0) {
    skillsListEl.innerHTML = `<div class="help-item-empty">No skills yet. Click "+ New" to create one.</div>`;
    return;
  }
  skillsListEl.innerHTML = "";
  for (const name of skills) {
    const row = document.createElement("div");
    row.className = "help-item-row";
    const cleanName = name.replace(/\.md$/i, "");
    row.innerHTML = `
      <div class="help-item-icon">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
      </div>
      <span class="help-item-name">${cleanName}</span>
      <div class="help-item-actions">
        <button class="action-btn skill-edit" title="Edit">Edit</button>
      </div>`;

    row.querySelector(".skill-edit")!.addEventListener("click", async (e) => {
      e.stopPropagation();
      const prompt = await window.yo.skillsRead(name);
      openSkillEditor(cleanName, prompt || "");
    });

    skillsListEl.appendChild(row);
  }
}

function openSkillEditor(name: string, prompt: string) {
  editingSkillName = name || null;
  skillNameInput.value = name;
  skillDescInput.value = "";
  skillPromptArea.value = prompt;
  skillDeleteBtn.style.display = name ? "block" : "none";

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
  const name = skillNameInput.value.trim();
  const prompt = skillPromptArea.value.trim();
  if (!name || !prompt) return;

  const fileName = name.endsWith(".md") ? name : `${name}.md`;
  // If renaming, delete old
  if (editingSkillName && editingSkillName !== name) {
    const oldFile = editingSkillName.endsWith(".md") ? editingSkillName : `${editingSkillName}.md`;
    await window.yo.skillsRemove(oldFile);
  }
  await window.yo.skillsWrite(fileName, prompt);
  closeSkillEditor();
}

async function deleteSkill() {
  if (editingSkillName) {
    const fileName = editingSkillName.endsWith(".md") ? editingSkillName : `${editingSkillName}.md`;
    await window.yo.skillsRemove(fileName);
  }
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
<p>For questions about these Terms, contact us at legal@glyphh.ai.</p>
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
<p>To exercise these rights, contact us at privacy@glyphh.ai.</p>

<p><strong>9. Children's Privacy</strong></p>
<p>The Service is not intended for children under 13. We do not knowingly collect personal information from children under 13. If we become aware that we have collected such information, we will take steps to delete it.</p>

<p><strong>10. International Transfers</strong></p>
<p>If you are accessing the Service from outside the United States, your information may be transferred to and processed in the United States. By using the Service, you consent to such transfer.</p>

<p><strong>11. Changes to This Policy</strong></p>
<p>We may update this Privacy Policy from time to time. We will notify you of material changes through the application or via email. Continued use of the Service after changes constitutes acceptance.</p>

<p><strong>12. Contact</strong></p>
<p>For privacy-related questions or requests, contact us at privacy@glyphh.ai.</p>
`;

const REFUND_POLICY = `
<p><strong>Effective Date:</strong> January 1, 2026</p>
<p>This Refund Policy applies to paid subscriptions for .Yo offered by Glyphh AI LLC.</p>

<p><strong>1. Free Tier</strong></p>
<p>The free tier of .Yo is available at no cost and requires no payment. No refund applies.</p>

<p><strong>2. Paid Subscriptions (Basic, Advanced)</strong></p>
<p>Paid plans are billed on a monthly subscription basis. You may cancel your subscription at any time.</p>

<p><strong>3. Refund Eligibility</strong></p>
<p>We offer a full refund within 14 days of your first subscription payment ("Refund Window") if you are not satisfied with the Service. To request a refund during this window, contact us at billing@glyphh.ai with your license key and the email associated with your account.</p>

<p><strong>4. After the Refund Window</strong></p>
<p>After the 14-day Refund Window, subscription payments are non-refundable. When you cancel your subscription, you retain access to paid features through the end of your current billing period. No partial refunds are issued for unused time within a billing cycle.</p>

<p><strong>5. Plan Changes</strong></p>
<p>If you upgrade from Basic to Advanced, you will be charged the prorated difference for the remainder of your billing cycle. If you downgrade, the change takes effect at the start of your next billing cycle. No refunds are issued for downgrades.</p>

<p><strong>6. Service Disruption</strong></p>
<p>If the Service experiences a significant outage or disruption lasting more than 72 continuous hours, you may be eligible for a prorated credit at our discretion. Contact billing@glyphh.ai to report service disruptions.</p>

<p><strong>7. Revoked Licenses</strong></p>
<p>If your license is revoked due to a violation of our Terms of Use, no refund will be issued.</p>

<p><strong>8. How to Cancel</strong></p>
<p>You can cancel your subscription at any time through the Settings section of the .Yo application. Alternatively, contact billing@glyphh.ai. Cancellation takes effect at the end of your current billing period.</p>

<p><strong>9. Contact</strong></p>
<p>For billing or refund questions, contact us at billing@glyphh.ai.</p>
`;

// Export policy HTML for use in onboarding
export { TERMS_OF_USE, PRIVACY_POLICY, REFUND_POLICY };
