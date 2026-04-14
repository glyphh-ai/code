/**
 * Renderer — titlebar + grid handles + boot gate + sup browser.
 *
 * All user commands (yo/sup/dip/wassup) happen inside app panels
 * via the interceptor, or from the command bar. The renderer
 * manages window chrome and session state display.
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
      sessionInfo: () => Promise<{ hasContent: boolean; label: string; fileName: string }>;
      sessionLoadFile: (name: string) => Promise<boolean>;
      sessionClear: () => Promise<boolean>;
      onSessionChanged: (callback: (info: { hasContent: boolean; label: string; fileName: string }) => void) => void;
      libraryListMeta: () => Promise<Array<{ name: string; modified: number; size: number }>>;
      librarySearchAi: (query: string) => Promise<string[]>;
      // Preferences + boot
      setPreference: (key: string, value: unknown) => void;
      getPreference: (key: string, defaultVal?: unknown) => Promise<unknown>;
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
      // Downloads
      onDownloadStart: (cb: (info: { filename: string; totalBytes: number; savePath: string }) => void) => void;
      onDownloadProgress: (cb: (info: { filename: string; receivedBytes: number; totalBytes: number }) => void) => void;
      onDownloadDone: (cb: (info: { filename: string; savePath: string; state: string }) => void) => void;
      downloadShow: (filePath: string) => void;
      // Drip effects
      onDripEffect: (callback: (effect: string) => void) => void;
      // Sup browser (from terminal)
      onOpenSupBrowser: (callback: () => void) => void;
      // LLM config
      getLLMConfig: () => Promise<{ provider: string; model: string; apiKey: string; baseUrl: string | null }>;
      getLLMPresets: () => Promise<Record<string, { name: string; models: string[]; defaultModel: string; baseUrl?: string; keyPlaceholder: string }>>;
      saveLLMConfig: (config: { provider: string; model: string; apiKey: string; baseUrl?: string }) => Promise<{ ok: boolean; error?: string }>;
    };
  }
}

const gridHandles = document.getElementById("grid-handles")!;
const screenshotContainer = document.getElementById("panel-screenshots")!;

// -- Panel screenshot helpers (freeze-frame when hiding panels) --

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

// -- Window controls --

document.getElementById("btn-close")!.addEventListener("click", () => window.yo.windowClose());
document.getElementById("btn-minimize")!.addEventListener("click", () => window.yo.windowMinimize());
document.getElementById("btn-maximize")!.addEventListener("click", () => window.yo.windowMaximize());

// -- Titlebar label -> open help --

document.getElementById("titlebar-label")!.addEventListener("click", () => openHelp());

// -- Context pill --

const contextPill = document.getElementById("context-pill")!;
const contextPillName = document.getElementById("context-pill-name")!;
const contextPillEdit = document.getElementById("context-pill-edit")!;
let currentContextFileName = "";

function updateContextPill(info: { hasContent: boolean; label: string; fileName: string }) {
  if (info.hasContent && info.label) {
    // Show clean name — strip .md extension if present
    const cleanName = info.label.replace(/\.md$/i, "");
    contextPillName.textContent = cleanName;
    currentContextFileName = info.fileName || "";
    contextPill.classList.remove("hidden");
  } else {
    contextPill.classList.add("hidden");
    currentContextFileName = "";
  }
}

window.yo.onSessionChanged(updateContextPill);

// Click pill name -> open sup browser with current file selected
contextPillName.addEventListener("click", () => {
  openSupBrowser(currentContextFileName);
});

// Click edit icon -> open sup browser with current file selected
contextPillEdit.addEventListener("click", (e) => {
  e.stopPropagation();
  openSupBrowser(currentContextFileName);
});

// Click X -> clear context
const contextPillClear = document.getElementById("context-pill-clear")!;
contextPillClear.addEventListener("click", (e) => {
  e.stopPropagation();
  window.yo.sessionClear();
});

// Load initial state
window.yo.sessionInfo().then(updateContextPill);

// -- Cmd+K command overlay --

const cmdkOverlay = document.getElementById("cmdk-overlay")!;
const cmdkInput = document.getElementById("cmdk-input") as HTMLInputElement;
let resultTimer: ReturnType<typeof setTimeout> | null = null;

function openCmdK() {
  if (!cmdkOverlay.classList.contains("hidden")) return;
  window.yo.panelsHide();
  cmdkOverlay.classList.remove("hidden");
  cmdkInput.value = "";
  cmdkInput.classList.remove("result");
  cmdkInput.focus();
}

function closeCmdK() {
  if (resultTimer) { clearTimeout(resultTimer); resultTimer = null; }
  cmdkOverlay.classList.add("hidden");
  cmdkInput.value = "";
  cmdkInput.classList.remove("result");
  window.yo.panelsShow();
}

function isCmdKOpen(): boolean {
  return !cmdkOverlay.classList.contains("hidden");
}

function showResult(text: string) {
  if (resultTimer) clearTimeout(resultTimer);
  cmdkInput.value = text;
  cmdkInput.classList.add("result");
  resultTimer = setTimeout(() => {
    closeCmdK();
  }, 2000);
}

cmdkInput.addEventListener("keydown", async (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const value = cmdkInput.value.trim();
    if (!value) return;

    cmdkInput.value = "";

    try {
      const result = await window.yo.execCommand(value);
      if (result === "__SUP_BROWSE__") {
        closeCmdK();
        openSupBrowser();
      } else if (result) {
        showResult(result);
      } else {
        closeCmdK();
      }
    } catch (err) {
      showResult(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (e.key === "Escape") {
    e.preventDefault();
    closeCmdK();
  }
});

// Click overlay background -> close
cmdkOverlay.addEventListener("click", (e) => {
  if (e.target === cmdkOverlay) closeCmdK();
});

// Cmd+K from panel -> open overlay
window.yo.onFocusInput(() => openCmdK());

// -- Sup browser (library file picker) --

const supBrowser = document.getElementById("sup-browser")!;
const supSearch = document.getElementById("sup-search") as HTMLInputElement;
const supList = document.getElementById("sup-list")!;
const supPreview = document.getElementById("sup-preview")!;
const supPreviewName = document.getElementById("sup-preview-name")!;
const supPreviewContent = document.getElementById("sup-preview-content")!;

interface SupFileMeta { name: string; modified: number; size: number }
let supFiles: string[] = [];
let supFileMeta: Map<string, SupFileMeta> = new Map();
let supPage = 0;
const SUP_PAGE_SIZE = 15;
let supSearchTimer: ReturnType<typeof setTimeout> | null = null;

function openSupBrowser(selectFileName?: string) {
  window.yo.panelsHide();
  supBrowser.classList.remove("hidden");
  supPreview.classList.add("hidden");
  supList.classList.remove("hidden");
  supSearch.value = "";
  supPage = 0;
  loadSupFiles().then(() => {
    if (selectFileName) {
      viewSupFile(selectFileName);
    }
  });
  if (!selectFileName) supSearch.focus();
}

function closeSupBrowser() {
  supBrowser.classList.add("hidden");
  window.yo.panelsShow();
}

function formatRelativeDate(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function loadSupFiles(filter?: string[]) {
  // Always fetch metadata for date/size display
  const allMeta = await window.yo.libraryListMeta();
  supFileMeta = new Map(allMeta.map((m) => [m.name, m]));

  if (filter) {
    supFiles = filter;
  } else {
    supFiles = allMeta.map((m) => m.name);
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

  let html = pageFiles.map((name) => {
    const meta = supFileMeta.get(name);
    const dateStr = meta ? formatRelativeDate(meta.modified) : "";
    const sizeStr = meta ? formatSize(meta.size) : "";
    return `
    <div class="sup-file-row" data-name="${name}">
      <div class="sup-file-top">
        <span class="sup-file-name">${name}</span>
        <div class="sup-file-actions">
          <button class="sup-action-btn sup-action-load" title="Set as context" data-name="${name}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12l7-7 7 7"/></svg>
          </button>
          <button class="sup-action-btn sup-action-delete" title="Delete" data-name="${name}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          </button>
        </div>
      </div>
      <div class="sup-file-meta-row">
        <span class="sup-file-date">${dateStr}</span>
        <span class="sup-file-size">${sizeStr}</span>
      </div>
    </div>`;
  }).join("");

  if (totalPages > 1) {
    html += `<div style="display:flex;align-items:center;justify-content:center;gap:12px;padding:12px;">
      <button class="action-btn sup-prev" ${supPage === 0 ? "disabled" : ""}>&larr; Prev</button>
      <span style="font-size:11px;color:#555;">${supPage + 1} / ${totalPages}</span>
      <button class="action-btn sup-next" ${supPage >= totalPages - 1 ? "disabled" : ""}>Next &rarr;</button>
    </div>`;
  }

  supList.innerHTML = html;

  // Click row → view file preview
  supList.querySelectorAll(".sup-file-row").forEach((row) => {
    row.addEventListener("click", (e) => {
      // Don't trigger if an action button was clicked
      if ((e.target as HTMLElement).closest(".sup-action-btn")) return;
      viewSupFile((row as HTMLElement).dataset.name!);
    });
  });

  // Load as context buttons
  supList.querySelectorAll(".sup-action-load").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const name = (btn as HTMLElement).dataset.name!;
      loadSupFile(name);
    });
  });

  // Delete buttons
  supList.querySelectorAll(".sup-action-delete").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const name = (btn as HTMLElement).dataset.name!;
      window.yo.libraryRemove(name).then((ok) => {
        if (ok) loadSupFiles();
      });
    });
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

// Click overlay background -> close
supBrowser.addEventListener("click", (e) => {
  if (e.target === supBrowser) closeSupBrowser();
});


// -- Global keyboard shortcuts --

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (isCmdKOpen()) closeCmdK();
    else if (isSupBrowserOpen()) closeSupBrowser();
    else if (isHelpOpen()) closeHelp();
  }

  // Cmd+K to open command overlay
  if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    openCmdK();
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

// -- Grid drag handles --

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

// -- Drag protocol --

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

// -- Download toast --

const dlToast = document.getElementById("download-toast")!;
const dlFilename = document.getElementById("download-filename")!;
const dlStatus = document.getElementById("download-status")!;
const dlProgressBar = document.getElementById("download-progress-bar")!;
const dlFill = document.getElementById("download-progress-fill")!;
const dlShowBtn = document.getElementById("download-show")!;
const dlDismiss = document.getElementById("download-dismiss")!;

let dlSavePath = "";
let dlDismissTimer: ReturnType<typeof setTimeout> | null = null;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

window.yo.onDownloadStart(({ filename, totalBytes }) => {
  dlFilename.textContent = filename;
  dlStatus.textContent = totalBytes > 0 ? formatBytes(totalBytes) : "downloading...";
  dlFill.style.width = "0%";
  dlProgressBar.classList.remove("hidden");
  dlShowBtn.classList.add("hidden");
  dlToast.classList.remove("hidden");
  dlSavePath = "";
  if (dlDismissTimer) { clearTimeout(dlDismissTimer); dlDismissTimer = null; }
});

window.yo.onDownloadProgress(({ receivedBytes, totalBytes }) => {
  if (totalBytes > 0) {
    const pct = Math.min(100, (receivedBytes / totalBytes) * 100);
    dlFill.style.width = `${pct}%`;
    dlStatus.textContent = `${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)}`;
  } else {
    dlStatus.textContent = formatBytes(receivedBytes);
  }
});

window.yo.onDownloadDone(({ savePath, state }) => {
  if (state === "completed") {
    dlFill.style.width = "100%";
    dlStatus.textContent = "Done";
    dlSavePath = savePath;
    dlShowBtn.classList.remove("hidden");
    dlDismissTimer = setTimeout(() => dlToast.classList.add("hidden"), 8000);
  } else {
    dlStatus.textContent = state === "cancelled" ? "Cancelled" : "Failed";
    dlDismissTimer = setTimeout(() => dlToast.classList.add("hidden"), 4000);
  }
});

dlShowBtn.addEventListener("click", () => {
  if (dlSavePath) window.yo.downloadShow(dlSavePath);
});

dlDismiss.addEventListener("click", () => {
  dlToast.classList.add("hidden");
  if (dlDismissTimer) { clearTimeout(dlDismissTimer); dlDismissTimer = null; }
});

// -- Drip effects --

const DRIP_COLORS = ["#ff0", "#f0f", "#0ff", "#f44", "#4f4", "#ff6600", "#ff00ff", "#00ffcc"];

function dripFireworks() {
  const overlay = document.createElement("div");
  overlay.className = "drip-overlay";
  document.body.appendChild(overlay);

  const bursts = [
    { x: window.innerWidth * 0.5, y: window.innerHeight * 0.4 },
    { x: window.innerWidth * 0.25, y: window.innerHeight * 0.35 },
    { x: window.innerWidth * 0.75, y: window.innerHeight * 0.35 },
  ];

  interface Particle { el: HTMLElement; x: number; y: number; vx: number; vy: number; life: number }
  const particles: Particle[] = [];

  bursts.forEach((burst, bi) => {
    setTimeout(() => {
      for (let i = 0; i < 50; i++) {
        const el = document.createElement("div");
        const size = 3 + Math.random() * 5;
        el.style.cssText = `position:absolute;border-radius:50%;width:${size}px;height:${size}px;background:${DRIP_COLORS[Math.floor(Math.random() * DRIP_COLORS.length)]};`;
        overlay.appendChild(el);
        const angle = Math.random() * Math.PI * 2;
        const speed = 2 + Math.random() * 6;
        particles.push({
          el, x: burst.x, y: burst.y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 3,
          life: 1,
        });
      }
    }, bi * 300);
  });

  function animate() {
    let alive = false;
    for (const p of particles) {
      if (p.life <= 0) continue;
      alive = true;
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.08;
      p.life -= 0.012;
      p.el.style.left = `${p.x}px`;
      p.el.style.top = `${p.y}px`;
      p.el.style.opacity = String(Math.max(0, p.life));
    }
    if (alive) requestAnimationFrame(animate);
    else overlay.remove();
  }
  requestAnimationFrame(animate);
}

function playDrip(effect: string) {
  switch (effect) {
    case "fireworks": dripFireworks(); break;
    default: dripFireworks(); break;
  }
}

window.yo.onDripEffect(playDrip);

// -- Boot gate --

window.yo.onBoot((data) => {
  if (data.needsOnboarding) {
    showOnboarding(data.license.daysRemaining);
  } else if (!data.hideWelcome) {
    openHelp();
  }
});
