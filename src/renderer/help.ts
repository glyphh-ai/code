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

function activeSection(): string {
  return (document.querySelector(".help-nav-item.active") as HTMLElement).dataset.section!;
}

function loadActiveSection() {
  const sec = activeSection();
  if (sec === "skills") loadSkills();
  else if (sec === "layouts") loadLayouts();
  else if (sec === "apps") loadApps();
  else if (sec === "settings") loadSettings();
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

  // Skills — inline creation
  document.getElementById("skill-create-btn")!.addEventListener("click", createNewSkill);
  skillNewName.addEventListener("keydown", (e) => {
    if (e.key === "Enter") createNewSkill();
  });

  // Skill detail
  document.getElementById("skill-detail-save")!.addEventListener("click", saveSkillDetail);
  document.getElementById("skill-detail-delete")!.addEventListener("click", deleteSkillDetail);
  document.getElementById("skill-detail-close")!.addEventListener("click", closeSkillDetail);
  document.getElementById("skill-llm-send")!.addEventListener("click", sendSkillLlm);
  skillLlmInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendSkillLlm(); }
  });

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
    layoutsList.innerHTML = `<div class="empty-state">No layouts yet. Create one to arrange panels your way.</div>`;
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
    appsList.innerHTML = `<div class="empty-state">No apps yet. Add a web app to connect it to yo/dip.</div>`;
    return;
  }
  if (apps.length === 0) {
    appsList.innerHTML = `<div class="empty-state">No apps matching "${query}"</div>`;
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
        <button class="action-btn danger app-card-delete">Delete</button>
      </div>
    </div>`).join("");

  appsList.querySelectorAll(".app-card").forEach((card) => {
    const id = (card as HTMLElement).dataset.id!;
    card.querySelector(".app-card-edit")!.addEventListener("click", (e) => {
      e.stopPropagation();
      openAppDetail(id);
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
const toggleMcpServer = document.getElementById("toggle-mcp-server") as HTMLInputElement;

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
  toggleMcpServer.addEventListener("change", () => {
    window.yo.setPreference("enableMcpServer", toggleMcpServer.checked);
    showRelaunch();
  });

  // Relaunch button
  document.getElementById("settings-relaunch-btn")?.addEventListener("click", () => {
    window.yo.relaunch();
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
  const [config, presets] = await Promise.all([
    window.yo.getLLMConfig(),
    window.yo.getLLMPresets(),
  ]);
  settingsPresets = presets;

  settingsProvider.value = config.provider;
  settingsApiKey.value = config.apiKey;
  settingsBaseUrl.value = config.baseUrl || "";

  updateSettingsUI(config.model);

  // Load service toggle states
  toggleVscodeServer.checked = await window.yo.getPreference("enableVscodeServer", false) as boolean;
  toggleMcpServer.checked = await window.yo.getPreference("enableMcpServer", false) as boolean;
}

async function saveSettings() {
  const provider = settingsProvider.value;
  const preset = settingsPresets[provider];
  const model = (preset && preset.models.length > 0)
    ? settingsModelSelect.value
    : settingsModelCustom.value.trim();
  const apiKey = settingsApiKey.value.trim();

  if (!apiKey) {
    settingsStatus.textContent = "API key is required";
    settingsStatus.className = "settings-error";
    return;
  }

  settingsSaveBtn.disabled = true;
  settingsSaveBtn.textContent = "Validating...";
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

const skillsList = document.getElementById("skills-list")!;
const skillSection = skillsList.closest(".help-section") as HTMLElement;
const skillToolbar = skillsList.previousElementSibling as HTMLElement; // .tab-toolbar
const skillDetail = document.getElementById("skill-detail")!;
const skillDetailName = document.getElementById("skill-detail-name") as HTMLInputElement;
const skillDetailContent = document.getElementById("skill-detail-content") as HTMLTextAreaElement;
const skillLlmLog = document.getElementById("skill-llm-log")!;
const skillLlmInput = document.getElementById("skill-llm-input") as HTMLTextAreaElement;
const skillNewName = document.getElementById("skill-new-name") as HTMLInputElement;
let currentSkillFile = "";  // file name of skill being viewed in detail

async function loadSkills() {
  skillDetail.classList.add("hidden");
  skillsList.classList.remove("hidden");
  skillToolbar.classList.remove("hidden");
  const skills = await window.yo.skillsList();
  if (skills.length === 0) {
    skillsList.innerHTML = `<div class="help-item-empty">No skills yet. Click "Create with AI" to make one.</div>`;
    return;
  }
  skillsList.innerHTML = "";
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
        <button class="help-item-action danger skill-delete" title="Delete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>`;

    row.addEventListener("click", () => openSkillDetail(name));

    row.querySelector(".skill-delete")!.addEventListener("click", async (e) => {
      e.stopPropagation();
      await window.yo.skillsRemove(name);
      loadSkills();
    });

    skillsList.appendChild(row);
  }
}

function toggleSectionChrome(section: HTMLElement, show: boolean) {
  const h2 = section.querySelector("h2");
  const desc = section.querySelector(".section-desc");
  if (h2) h2.style.display = show ? "" : "none";
  if (desc) (desc as HTMLElement).style.display = show ? "" : "none";
}

async function openSkillDetail(fileName: string) {
  currentSkillFile = fileName;
  const prompt = await window.yo.skillsRead(fileName);
  if (prompt === null) return;

  skillDetailName.value = fileName.replace(/\.md$/i, "");
  skillDetailContent.value = prompt;
  skillLlmLog.innerHTML = `<div class="llm-empty">Ask AI to refine, expand, or rewrite the prompt.</div>`;

  skillsList.classList.add("hidden");
  skillToolbar.classList.add("hidden");
  toggleSectionChrome(skillSection, false);
  skillDetail.classList.remove("hidden");
}

function closeSkillDetail() {
  skillDetail.classList.add("hidden");
  skillsList.classList.remove("hidden");
  skillToolbar.classList.remove("hidden");
  toggleSectionChrome(skillSection, true);
  currentSkillFile = "";
  loadSkills();
}

async function saveSkillDetail() {
  const name = skillDetailName.value.trim();
  const content = skillDetailContent.value.trim();
  if (!name) { skillDetailName.focus(); return; }
  if (!content) { skillDetailContent.focus(); return; }

  const newFile = name.endsWith(".md") ? name : `${name}.md`;
  if (currentSkillFile && currentSkillFile !== name && currentSkillFile !== newFile) {
    await window.yo.skillsRemove(currentSkillFile);
  }
  await window.yo.skillsWrite(newFile, content);
  currentSkillFile = newFile;
}

async function deleteSkillDetail() {
  if (currentSkillFile) {
    await window.yo.skillsRemove(currentSkillFile);
  }
  closeSkillDetail();
}

async function sendSkillLlm() {
  const userMsg = skillLlmInput.value.trim();
  if (!userMsg) return;

  const currentContent = skillDetailContent.value;
  skillLlmInput.value = "";
  const sendBtn = document.getElementById("skill-llm-send") as HTMLButtonElement;
  sendBtn.disabled = true;

  // Clear empty state
  const emptyEl = skillLlmLog.querySelector(".llm-empty");
  if (emptyEl) emptyEl.remove();

  // Show user message
  const userDiv = document.createElement("div");
  userDiv.className = "llm-msg user";
  userDiv.textContent = userMsg;
  skillLlmLog.appendChild(userDiv);

  // Show loading
  const loadingDiv = document.createElement("div");
  loadingDiv.className = "llm-msg ai loading";
  loadingDiv.textContent = "Thinking...";
  skillLlmLog.appendChild(loadingDiv);
  skillLlmLog.scrollTop = skillLlmLog.scrollHeight;

  try {
    const result = await window.yo.execCommand(
      `yo . Refine this skill prompt based on the user's request.\n\nCurrent prompt:\n${currentContent}\n\nUser request: ${userMsg}\n\nIMPORTANT: The skill prompt MUST include an explicit instruction to output plain text without markdown formatting. Skill output gets pasted into real apps (email, chat, docs) where markdown syntax looks broken. Always include a line like: "Output plain text only. Do not use markdown formatting."\n\nRespond with ONLY the updated prompt text, nothing else.`
    );
    loadingDiv.remove();
    const aiDiv = document.createElement("div");
    aiDiv.className = "llm-msg ai";
    aiDiv.textContent = "Updated the prompt.";
    skillLlmLog.appendChild(aiDiv);

    if (result) {
      skillDetailContent.value = result;
    }
  } catch {
    loadingDiv.textContent = "Failed — try again.";
    loadingDiv.classList.remove("loading");
  } finally {
    sendBtn.disabled = false;
    skillLlmLog.scrollTop = skillLlmLog.scrollHeight;
  }
}

async function createNewSkill() {
  const name = skillNewName.value.trim();
  if (!name) { skillNewName.focus(); return; }
  const fileName = name.endsWith(".md") ? name : `${name}.md`;
  // Create with empty prompt, then open detail for editing
  await window.yo.skillsWrite(fileName, "");
  skillNewName.value = "";
  openSkillDetail(fileName);
}


