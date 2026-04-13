/**
 * Renderer — titlebar + grid handles + boot gate + sup browser.
 *
 * All user commands (yo/sup/dip/wassup) happen inside app panels
 * via the interceptor, or from the command bar. The renderer
 * manages window chrome, session state display, and the sup browser.
 */

import { initHelp, openHelp, closeHelp, isHelpOpen } from "./help.js";
import { showOnboarding } from "./onboarding.js";

declare global {
  interface Window {
    yo: {
      windowClose: () => void;
      windowMinimize: () => void;
      windowMaximize: () => void;
      panelsHide: () => void;
      panelsShow: () => void;
      capturePanels: () => Promise<Array<{ dataUrl: string; bounds: { x: number; y: number; width: number; height: number } }>>;
      panelsRefresh: (id?: string) => void;
      panelsZoom: (factor: number) => void;
      panelsGetZoom: () => Promise<number>;
      // Library
      libraryList: () => Promise<string[]>;
      libraryRead: (name: string) => Promise<string | null>;
      libraryWrite: (name: string, content: string) => Promise<boolean>;
      libraryRemove: (name: string) => Promise<boolean>;
      // Skills
      skillsList: () => Promise<string[]>;
      skillsRead: (name: string) => Promise<string | null>;
      skillsWrite: (name: string, prompt: string) => Promise<boolean>;
      skillsRemove: (name: string) => Promise<boolean>;
      // Apps
      appsList: () => Promise<Array<{ id: string; name: string; url: string; connected: boolean; commands: Record<string, { selector: string; action: string; description: string }>; meta?: { description: string; capabilities: string[] } }>>;
      appsAdd: (id: string, name: string, url: string) => Promise<unknown>;
      appsRemove: (id: string) => Promise<boolean>;
      appsUpdateName: (id: string, name: string) => Promise<boolean>;
      appsUpdateId: (oldId: string, newId: string) => Promise<boolean>;
      appsConnect: (id: string, webContentsId?: number) => Promise<{ ok: boolean; error?: string; commandCount?: number }>;
      appsSetCommand: (id: string, commandKey: string, mapping: { selector: string; action: string; description: string; script?: string }) => Promise<boolean>;
      appsRemoveCommand: (id: string, commandKey: string) => Promise<boolean>;
      appsTestCommand: (id: string, commandKey: string, webContentsId?: number) => Promise<string>;
      // Layouts
      layoutsList: () => Promise<Array<{ name: string; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; splits: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }> }>>;
      layoutsSave: (name: string, panelIds: string[]) => Promise<boolean>;
      layoutsSaveGrid: (grid: { name: string; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }> }) => Promise<boolean>;
      layoutsDelete: (name: string) => Promise<boolean>;
      // Grid resize
      gridDragEnd: (type: "col" | "row", index: number, fraction: number) => void;
      // Session
      sessionInfo: () => Promise<{ hasContent: boolean; label: string }>;
      sessionLoadFile: (name: string) => Promise<boolean>;
      sessionClear: () => Promise<boolean>;
      onSessionChanged: (callback: (info: { hasContent: boolean; label: string }) => void) => void;
      librarySearchAi: (query: string) => Promise<string[]>;
      // Preferences + boot
      setPreference: (key: string, value: unknown) => void;
      onboardingComplete: () => Promise<void>;
      startPicker: (webContentsId: number) => void;
      onPickerResult: (callback: (result: unknown) => void) => void;
      checkLicense: () => Promise<{ status: string; daysRemaining?: number }>;
      activateLicense: (key: string) => Promise<boolean>;
      validateApiKey: (key: string) => Promise<{ valid: boolean; error?: string }>;
      getApiKey: () => Promise<string | null>;
      buyLicense: () => Promise<string | null>;
      onBoot: (callback: (data: { license: { status: string; daysRemaining?: number }; apiKey: boolean; needsOnboarding: boolean; hideWelcome?: boolean }) => void) => void;
      onShowWelcome: (callback: () => void) => void;
      onFocusInput: (callback: () => void) => void;
      onSplitState: (callback: (info: {
        panelIds: string[];
        cols: number;
        rows: number;
        colWidths: number[];
        rowHeights: number[];
        cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }>;
      } | null) => void) => void;
      // Command execution
      execCommand: (cmd: string) => Promise<string>;
    };
  }
}

const gridHandles = document.getElementById("grid-handles")!;
const screenshotContainer = document.getElementById("panel-screenshots")!;

// ── Panel screenshot helpers (freeze-frame when hiding panels) ──

async function showPanelScreenshots(): Promise<void> {
  const captures = await window.yo.capturePanels();
  for (const cap of captures) {
    const div = document.createElement("div");
    div.className = "panel-screenshot";
    div.style.left = `${cap.bounds.x}px`;
    div.style.top = `${cap.bounds.y}px`;
    div.style.width = `${cap.bounds.width}px`;
    div.style.height = `${cap.bounds.height}px`;
    div.style.backgroundImage = `url(${cap.dataUrl})`;
    screenshotContainer.appendChild(div);
  }
}

function clearPanelScreenshots(): void {
  screenshotContainer.innerHTML = "";
}

// ── Window controls ────────────────────────────────────────

document.getElementById("btn-close")!.addEventListener("click", () => window.yo.windowClose());
document.getElementById("btn-minimize")!.addEventListener("click", () => window.yo.windowMinimize());
document.getElementById("btn-maximize")!.addEventListener("click", () => window.yo.windowMaximize());

// ── Titlebar label → open help ─────────────────────────────

document.getElementById("titlebar-label")!.addEventListener("click", () => openHelp());

// ── Context pill ─────────────────────────────────────────

const contextPill = document.getElementById("context-pill")!;

function updateContextPill(info: { hasContent: boolean; label: string }) {
  if (info.hasContent && info.label) {
    contextPill.textContent = info.label;
    contextPill.classList.remove("hidden");
  } else {
    contextPill.classList.add("hidden");
  }
}

window.yo.onSessionChanged(updateContextPill);

// Click pill → clear context
contextPill.addEventListener("click", async () => {
  await window.yo.sessionClear();
  updateContextPill({ hasContent: false, label: "" });
});

// Load initial state
window.yo.sessionInfo().then(updateContextPill);

// ── Command input ─────────────────────────────────────────

const commandInput = document.getElementById("command-input") as HTMLInputElement;
let resultTimer: ReturnType<typeof setTimeout> | null = null;

function showResult(text: string) {
  if (resultTimer) clearTimeout(resultTimer);
  commandInput.value = text;
  commandInput.classList.add("result");
  resultTimer = setTimeout(() => {
    commandInput.value = "";
    commandInput.classList.remove("result");
    resultTimer = null;
  }, 2500);
}

commandInput.addEventListener("keydown", async (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const value = commandInput.value.trim();
    if (!value) return;

    commandInput.value = "";
    commandInput.blur();

    try {
      const result = await window.yo.execCommand(value);
      if (result === "__SUP_BROWSE__") {
        openSupBrowser();
      } else if (result) {
        showResult(result);
      }
    } catch (err) {
      showResult(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (e.key === "Escape") {
    e.preventDefault();
    if (resultTimer) {
      clearTimeout(resultTimer);
      resultTimer = null;
    }
    commandInput.value = "";
    commandInput.classList.remove("result");
    commandInput.blur();
  }
});

// Cmd+K from panel → focus command input
window.yo.onFocusInput(() => commandInput.focus());

// ── Sup browser (library file picker) ─────────────────────

const supBrowser = document.getElementById("sup-browser")!;
const supSearch = document.getElementById("sup-search") as HTMLInputElement;
const supList = document.getElementById("sup-list")!;
const supPreview = document.getElementById("sup-preview")!;
const supPreviewName = document.getElementById("sup-preview-name")!;
const supPreviewContent = document.getElementById("sup-preview-content")!;

let supFiles: string[] = [];
let supPage = 0;
const SUP_PAGE_SIZE = 15;
let supSearchTimer: ReturnType<typeof setTimeout> | null = null;

function openSupBrowser() {
  window.yo.panelsHide();
  supBrowser.classList.remove("hidden");
  supPreview.classList.add("hidden");
  supList.classList.remove("hidden");
  supSearch.value = "";
  supPage = 0;
  loadSupFiles();
  supSearch.focus();
}

function closeSupBrowser() {
  supBrowser.classList.add("hidden");
  window.yo.panelsShow();
}

async function loadSupFiles(filter?: string[]) {
  if (filter) {
    supFiles = filter;
  } else {
    supFiles = await window.yo.libraryList();
  }
  supPage = 0;
  renderSupList();
}

function renderSupList() {
  if (supFiles.length === 0) {
    supList.innerHTML = `<div class="sup-empty">Library is empty. Use <b>yo</b> to capture content first.</div>`;
    return;
  }

  const start = supPage * SUP_PAGE_SIZE;
  const pageFiles = supFiles.slice(start, start + SUP_PAGE_SIZE);
  const totalPages = Math.ceil(supFiles.length / SUP_PAGE_SIZE);

  let html = pageFiles.map((name) => `
    <div class="sup-file-row" data-name="${name}">
      <span class="sup-file-name">${name}.md</span>
      <span class="sup-file-meta">click to view</span>
    </div>`).join("");

  if (totalPages > 1) {
    html += `<div style="display:flex;align-items:center;justify-content:center;gap:12px;padding:12px;">
      <button class="action-btn sup-prev" ${supPage === 0 ? "disabled" : ""}>&larr; Prev</button>
      <span style="font-size:11px;color:#555;">${supPage + 1} / ${totalPages}</span>
      <button class="action-btn sup-next" ${supPage >= totalPages - 1 ? "disabled" : ""}>Next &rarr;</button>
    </div>`;
  }

  supList.innerHTML = html;

  supList.querySelectorAll(".sup-file-row").forEach((row) => {
    row.addEventListener("click", () => viewSupFile((row as HTMLElement).dataset.name!));
  });

  const prevBtn = supList.querySelector(".sup-prev");
  const nextBtn = supList.querySelector(".sup-next");
  prevBtn?.addEventListener("click", () => { supPage--; renderSupList(); });
  nextBtn?.addEventListener("click", () => { supPage++; renderSupList(); });
}

async function viewSupFile(name: string) {
  const content = await window.yo.libraryRead(name);
  supPreviewName.textContent = name + ".md";
  supPreviewContent.textContent = content || "(empty)";
  supPreview.dataset.name = name;
  supList.classList.add("hidden");
  supPreview.classList.remove("hidden");
}

async function loadSupFile(name: string) {
  await window.yo.sessionLoadFile(name);
  closeSupBrowser();
  showResult(`Loaded: ${name}.md \u2014 copied to clipboard`);
}

document.getElementById("sup-close")!.addEventListener("click", closeSupBrowser);
document.getElementById("sup-load-btn")!.addEventListener("click", () => {
  const name = supPreview.dataset.name;
  if (name) loadSupFile(name);
});
document.getElementById("sup-preview-close")!.addEventListener("click", () => {
  supPreview.classList.add("hidden");
  supList.classList.remove("hidden");
});

// Search: debounce + AI search
supSearch.addEventListener("input", () => {
  if (supSearchTimer) clearTimeout(supSearchTimer);
  const q = supSearch.value.trim();

  if (!q) {
    loadSupFiles();
    return;
  }

  // Quick local filter first (instant)
  window.yo.libraryList().then((all) => {
    const lower = q.toLowerCase();
    const filtered = all.filter((f) => f.toLowerCase().includes(lower));
    if (filtered.length > 0) {
      loadSupFiles(filtered);
    }
  });

  // AI search after debounce (for natural language queries)
  supSearchTimer = setTimeout(async () => {
    const results = await window.yo.librarySearchAi(q);
    if (results.length > 0 && supSearch.value.trim() === q) {
      loadSupFiles(results);
    }
  }, 600);
});

supSearch.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeSupBrowser();
  }
});

// Click overlay background → close
supBrowser.addEventListener("click", (e) => {
  if (e.target === supBrowser) closeSupBrowser();
});

// ── Global keyboard shortcuts ──────────────────────────────

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (isSupBrowserOpen()) closeSupBrowser();
    else if (isHelpOpen()) closeHelp();
  }

  // Cmd+K to focus command input
  if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    commandInput.focus();
  }

  // Cmd+R / Ctrl+R to refresh panels
  if (e.key === "r" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    window.yo.panelsRefresh();
  }

  // Cmd+Plus / Cmd+Minus to zoom panels
  if ((e.key === "=" || e.key === "+") && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    window.yo.panelsGetZoom().then((z) => window.yo.panelsZoom(z + 0.1));
  }
  if (e.key === "-" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    window.yo.panelsGetZoom().then((z) => window.yo.panelsZoom(z - 0.1));
  }
  if (e.key === "0" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    window.yo.panelsZoom(1.0);
  }
});

function isSupBrowserOpen(): boolean {
  return !supBrowser.classList.contains("hidden");
}

// yo help trigger from main process
window.yo.onShowWelcome(() => openHelp());

// Initialize help overlay
initHelp();

// ── Grid drag handles ───────────────────────────────────

type GridInfo = {
  panelIds: string[];
  cols: number;
  rows: number;
  colWidths: number[];
  rowHeights: number[];
  cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }>;
};

const CONTENT_TOP = 38;
let currentGrid: GridInfo | null = null;
let isDragging = false;
let dragType: "col" | "row" = "col";
let dragIndex = 0;

window.yo.onSplitState((info) => {
  currentGrid = info;
  renderGridHandles();
});

function renderGridHandles() {
  gridHandles.innerHTML = "";
  if (!currentGrid || currentGrid.panelIds.length < 2) return;

  const grid = currentGrid;

  // Column border handles
  let cumCol = 0;
  for (let i = 0; i < grid.cols - 1; i++) {
    cumCol += grid.colWidths[i];
    const handle = document.createElement("div");
    handle.className = "grid-col-handle";
    handle.style.left = `${cumCol * 100}%`;
    handle.dataset.type = "col";
    handle.dataset.index = String(i);
    gridHandles.appendChild(handle);
    handle.addEventListener("mousedown", (e) => startDrag(e, "col", i));
  }

  // Row border handles
  let cumRow = 0;
  for (let i = 0; i < grid.rows - 1; i++) {
    cumRow += grid.rowHeights[i];
    const handle = document.createElement("div");
    handle.className = "grid-row-handle";
    handle.style.top = `${CONTENT_TOP + cumRow * (window.innerHeight - CONTENT_TOP)}px`;
    handle.dataset.type = "row";
    handle.dataset.index = String(i);
    gridHandles.appendChild(handle);
    handle.addEventListener("mousedown", (e) => startDrag(e, "row", i));
  }
}

// Reposition row handles on window resize
window.addEventListener("resize", () => {
  if (!currentGrid || currentGrid.rows <= 1) return;
  let cumRow = 0;
  const rowHandles = gridHandles.querySelectorAll(".grid-row-handle");
  for (let i = 0; i < rowHandles.length; i++) {
    cumRow += currentGrid.rowHeights[i];
    (rowHandles[i] as HTMLElement).style.top =
      `${CONTENT_TOP + cumRow * (window.innerHeight - CONTENT_TOP)}px`;
  }
});

// ── Drag protocol ─────────────────────────────────────────

async function startDrag(e: MouseEvent, type: "col" | "row", index: number) {
  e.preventDefault();
  isDragging = true;
  dragType = type;
  dragIndex = index;

  const handle = e.currentTarget as HTMLElement;
  handle.classList.add("dragging");

  // Capture freeze-frame before hiding panels
  await showPanelScreenshots();
  window.yo.panelsHide();

  const overlay = document.getElementById("drag-overlay")!;
  overlay.classList.remove("hidden");
  overlay.className = type === "col" ? "drag-col" : "drag-row";
}

document.addEventListener("mousemove", (e) => {
  if (!isDragging || !currentGrid) return;

  if (dragType === "col") {
    const fraction = e.clientX / window.innerWidth;
    const clamped = Math.max(0.05, Math.min(0.95, fraction));
    const handles = gridHandles.querySelectorAll(".grid-col-handle");
    if (handles[dragIndex]) {
      (handles[dragIndex] as HTMLElement).style.left = `${clamped * 100}%`;
    }
  } else {
    const contentHeight = window.innerHeight - CONTENT_TOP;
    const fraction = (e.clientY - CONTENT_TOP) / contentHeight;
    const clamped = Math.max(0.05, Math.min(0.95, fraction));
    const handles = gridHandles.querySelectorAll(".grid-row-handle");
    if (handles[dragIndex]) {
      (handles[dragIndex] as HTMLElement).style.top =
        `${CONTENT_TOP + clamped * contentHeight}px`;
    }
  }
});

document.addEventListener("mouseup", () => {
  if (!isDragging) return;
  isDragging = false;

  gridHandles.querySelectorAll(".dragging").forEach((el) => el.classList.remove("dragging"));

  const overlay = document.getElementById("drag-overlay")!;
  overlay.classList.add("hidden");
  overlay.className = "";

  // Clear screenshots before restoring real panels
  clearPanelScreenshots();

  if (dragType === "col") {
    const handle = gridHandles.querySelectorAll(".grid-col-handle")[dragIndex] as HTMLElement;
    if (handle) {
      const fraction = parseFloat(handle.style.left) / 100;
      window.yo.gridDragEnd("col", dragIndex, fraction);
    }
  } else {
    const handle = gridHandles.querySelectorAll(".grid-row-handle")[dragIndex] as HTMLElement;
    if (handle) {
      const contentHeight = window.innerHeight - CONTENT_TOP;
      const top = parseFloat(handle.style.top) - CONTENT_TOP;
      const fraction = top / contentHeight;
      window.yo.gridDragEnd("row", dragIndex, fraction);
    }
  }
});

// ── Boot gate ───────────────────────────────────────────────

window.yo.onBoot((data) => {
  if (data.needsOnboarding) {
    showOnboarding(data.license.daysRemaining);
  } else if (!data.hideWelcome) {
    openHelp();
  }
});
