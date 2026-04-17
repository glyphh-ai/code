/**
 * Renderer — titlebar + grid handles + boot gate.
 *
 * All user commands (yo/dip/drip) happen inside app panels
 * via the interceptor, or from the command bar. The renderer
 * manages window chrome and session state display.
 */

import { initHelp, openHelp, openSettings, closeHelp, isHelpOpen } from "./help.js";
import { showOnboarding } from "./onboarding.js";

type TabInfo = { id: string; name: string; favicon?: string; layoutFavicons?: string[] };

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
      // Skills
      skillsList: () => Promise<string[]>;
      skillsRead: (name: string) => Promise<string | null>;
      skillsWrite: (name: string, prompt: string) => Promise<boolean>;
      skillsRemove: (name: string) => Promise<boolean>;
      skillsGenerate: (name: string, description: string) => Promise<string>;
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
      sessionClear: () => Promise<boolean>;
      onSessionChanged: (callback: (info: { hasContent: boolean; label: string; fileName: string }) => void) => void;
      // Preferences + boot
      relaunch: () => void;
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
      onEmbedderStatus: (callback: (status: { state: string; progress?: number; message?: string }) => void) => void;
      onShowWelcome: (callback: () => void) => void;
      onOpenSettings: (callback: () => void) => void;
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
      // LLM config
      getLLMConfig: () => Promise<{ provider: string; model: string; apiKey: string; baseUrl: string | null }>;
      getLLMPresets: () => Promise<Record<string, { name: string; models: string[]; defaultModel: string; baseUrl?: string; keyPlaceholder: string }>>;
      saveLLMConfig: (config: { provider: string; model: string; apiKey: string; baseUrl?: string }) => Promise<{ ok: boolean; error?: string }>;
      // Tabs
      tabList: () => Promise<{ tabs: TabInfo[]; activeId: string; visible: boolean }>;
      tabSwitch: (id: string) => void;
      tabClose: (id: string) => void;
      tabNew: () => void;
      onTabState: (callback: (state: { tabs: TabInfo[]; activeId: string; visible: boolean }) => void) => void;
      // URL bar
      urlBarNavigate: (url: string) => void;
      urlBarBack: () => void;
      urlBarForward: () => void;
      urlBarRefresh: () => void;
      panelNavBack: (panelId: string) => void;
      panelNavForward: (panelId: string) => void;
      panelNavRefresh: (panelId: string) => void;
      panelNavTo: (panelId: string, url: string) => void;
      urlBarToggle: (show: boolean) => void;
      onUrlUpdate: (cb: (info: { url: string; favicon: string; canGoBack?: boolean; canGoForward?: boolean }) => void) => void;
      onTabFavicon: (cb: (info: { id: string; favicon: string }) => void) => void;
      onPanelUrlUpdate: (cb: (info: { id: string; url: string; favicon: string }) => void) => void;
      // License info
      getLicenseInfo: () => Promise<{ status: string; key?: string; tier?: string; daysRemaining?: number }>;
      getCheckoutUrlForPlan: (plan: string) => Promise<string | null>;
      getBillingPortalUrl: () => Promise<string | null>;
      openExternal: (url: string) => void;
      // Support
      submitSupportTicket: (ticket: { subject: string; description: string }) => Promise<{ ok: boolean; error?: string }>;
      // Yo agent panel
      yoPanelOpen: (query: string) => void;
      yoPanelSend: (message: string) => void;
      yoPanelDismiss: () => void;
      yoPanelStop: () => void;
      onYoPanelOpen: (cb: (query: string) => void) => void;
      onYoPanelToken: (cb: (delta: string) => void) => void;
      onYoPanelToolUse: (cb: (id: string, name: string, input: unknown) => void) => void;
      onYoPanelToolResult: (cb: (id: string, detail: string) => void) => void;
      onYoPanelDone: (cb: (fullText: string) => void) => void;
      onYoPanelError: (cb: (err: string) => void) => void;
      onYoPanelClose: (cb: () => void) => void;
      // Yo panel resize
      yoPanelResize: (width: number) => void;
      yoPanelWidthSave: (width: number) => void;
      yoPanelGetWidth: () => Promise<number>;
      // Yo chat history
      yoChatsList: () => Promise<Array<{ id: string; title: string; created: string; messageCount: number }>>;
      yoChatsLoad: (id: string) => Promise<Array<{ role: string; text: string }> | null>;
      yoChatsDelete: (id: string) => Promise<boolean>;
      yoChatNew: () => Promise<boolean>;
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

// -- Tab bar --

const tabBar = document.getElementById("tab-bar")!;
const tabNewBtn = document.getElementById("tab-new-btn")!;

function renderTabs(tabs: TabInfo[], activeId: string) {
  tabBar.innerHTML = "";
  for (const tab of tabs) {
    const el = document.createElement("div");
    el.className = "tab" + (tab.id === activeId ? " tab-active" : "");
    el.dataset.id = tab.id;

    // Stacked favicons for layout tabs, single favicon otherwise
    if (tab.layoutFavicons && tab.layoutFavicons.length > 0) {
      const stack = document.createElement("span");
      stack.className = "tab-favicon-stack";
      for (let i = 0; i < Math.min(tab.layoutFavicons.length, 4); i++) {
        const img = document.createElement("img");
        img.className = "tab-favicon-stacked";
        img.width = 12;
        img.height = 12;
        img.src = tab.layoutFavicons[i];
        img.onerror = () => { img.style.display = "none"; };
        img.style.marginLeft = i > 0 ? "-6px" : "0";
        img.style.zIndex = String(10 - i);
        stack.appendChild(img);
      }
      el.appendChild(stack);
    } else {
      const favicon = document.createElement("img");
      favicon.className = "tab-favicon";
      favicon.width = 14;
      favicon.height = 14;
      favicon.src = tab.favicon || "";
      favicon.onerror = () => { favicon.src = ""; };
      el.appendChild(favicon);
    }

    // Label
    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = tab.name;
    label.addEventListener("click", () => window.yo.tabSwitch(tab.id));
    el.appendChild(label);

    // Close
    const close = document.createElement("button");
    close.className = "tab-close";
    close.title = "Close tab";
    close.innerHTML = "&times;";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      window.yo.tabClose(tab.id);
    });
    el.appendChild(close);

    tabBar.appendChild(el);
  }
  // Re-append the + button so it stays after the last tab
  tabBar.appendChild(tabNewBtn);
}

tabNewBtn.addEventListener("click", () => window.yo.tabNew());

const emptyState = document.getElementById("empty-state")!;

function updateEmptyState(tabs: TabInfo[]) {
  if (tabs.length === 0) {
    emptyState.classList.remove("hidden");
  } else {
    emptyState.classList.add("hidden");
  }
}

window.yo.onTabState((state: { tabs: TabInfo[]; activeId: string; visible: boolean }) => {
  renderTabs(state.tabs, state.activeId);
  tabBar.style.display = state.visible ? "flex" : "none";
  tabNewBtn.style.display = state.visible ? "" : "none";
  updateEmptyState(state.tabs);
  // Close help overlay whenever panels switch — help should never stay open over panels
  if (isHelpOpen()) closeHelp();
});

// Load initial tab state
window.yo.tabList().then((state) => {
  renderTabs(state.tabs, state.activeId);
  tabBar.style.display = state.visible ? "flex" : "none";
  tabNewBtn.style.display = state.visible ? "" : "none";
  updateEmptyState(state.tabs);
});

// -- URL bar --

const urlBar = document.getElementById("url-bar")!;
const urlBarInput = document.getElementById("url-bar-input") as HTMLInputElement;
const urlBarFavicon = document.getElementById("url-bar-favicon") as HTMLImageElement;

function setUrlBarVisible(show: boolean) {
  urlBar.classList.toggle("hidden", !show);
  document.body.style.setProperty("--content-top", show ? "72px" : "38px");
}

// Load initial URL bar visibility
window.yo.getPreference("showUrlBar", true).then((show) => {
  setUrlBarVisible(show as boolean);
});

// Nav buttons
const urlBarBack = document.getElementById("url-bar-back") as HTMLButtonElement;
const urlBarForward = document.getElementById("url-bar-forward") as HTMLButtonElement;
const urlBarRefresh = document.getElementById("url-bar-refresh") as HTMLButtonElement;

urlBarBack.addEventListener("click", () => window.yo.urlBarBack());
urlBarForward.addEventListener("click", () => window.yo.urlBarForward());
urlBarRefresh.addEventListener("click", () => window.yo.urlBarRefresh());

// Navigate on Enter
urlBarInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const url = urlBarInput.value.trim();
    if (url) {
      window.yo.urlBarNavigate(url);
      urlBarInput.blur();
    }
  }
  if (e.key === "Escape") {
    urlBarInput.blur();
  }
});

// Select all on focus for easy replacement
urlBarInput.addEventListener("focus", () => {
  urlBarInput.select();
});

// Receive URL updates from main (active panel navigated)
window.yo.onUrlUpdate((info: { url: string; favicon: string; canGoBack?: boolean; canGoForward?: boolean }) => {
  urlBarInput.value = info.url;
  urlBarFavicon.src = info.favicon || "";
  urlBarFavicon.onerror = () => { urlBarFavicon.src = ""; };
  urlBarBack.disabled = !info.canGoBack;
  urlBarForward.disabled = !info.canGoForward;
});

// -- Cmd+K command overlay --

// Cmd+K from panel -> open yo agent panel
window.yo.onFocusInput(() => {
  if (!isYoPanelOpen()) {
    window.yo.yoPanelOpen("");
    openYoPanel("");
  } else {
    yoPanelInput.focus();
  }
});



// -- Global keyboard shortcuts --

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (isYoPanelOpen()) window.yo.yoPanelDismiss();
    else if (isHelpOpen()) closeHelp();
  }

  // Cmd+K to open yo agent panel
  if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    if (isYoPanelOpen()) {
      yoPanelInput.focus();
      yoPanelInput.select();
    } else {
      window.yo.yoPanelOpen("");
      openYoPanel("");
    }
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


// yo help trigger from main process
window.yo.onShowWelcome(() => openHelp());
window.yo.onOpenSettings(() => openSettings());

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
  cellBounds?: Array<{ panelId: string; x: number; y: number; width: number }>;
};

function getContentTop(): number {
  if (urlBar.classList.contains("hidden")) return 38;
  // In grid mode, global URL bar is visibility:hidden — grid starts at titlebar
  if (currentGrid && currentGrid.panelIds.length > 1) return 38;
  return 72;
}

/** Available width for panels (accounts for yo panel inset) */
function getAvailableWidth(): number {
  if (isYoPanelOpen()) {
    return window.innerWidth - yoPanel.offsetWidth;
  }
  return window.innerWidth;
}

let currentGrid: GridInfo | null = null;
let isDragging = false;
let dragType: "col" | "row" = "col";
let dragIndex = 0;

// Per-panel URL tracking for cell URL bars
const panelUrlCache: Record<string, string> = {};
const panelFaviconCache: Record<string, string> = {};

const cellUrlContainer = document.getElementById("cell-url-bars")!;

function renderCellUrlBars() {
  cellUrlContainer.innerHTML = "";
  if (!currentGrid || !currentGrid.cellBounds || currentGrid.cellBounds.length < 2) return;
  if (urlBar.classList.contains("hidden")) return; // only when URL bars enabled

  for (const cb of currentGrid.cellBounds) {
    const bar = document.createElement("div");
    bar.className = "cell-url-bar";
    bar.style.left = `${cb.x}px`;
    bar.style.top = `${cb.y}px`;
    bar.style.width = `${cb.width}px`;

    const pid = cb.panelId;

    // Back button
    const backBtn = document.createElement("button");
    backBtn.className = "cell-nav-btn";
    backBtn.title = "Back";
    backBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M15 18l-6-6 6-6"/></svg>';
    backBtn.addEventListener("click", () => window.yo.panelNavBack(pid));
    bar.appendChild(backBtn);

    // Forward button
    const fwdBtn = document.createElement("button");
    fwdBtn.className = "cell-nav-btn";
    fwdBtn.title = "Forward";
    fwdBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M9 18l6-6-6-6"/></svg>';
    fwdBtn.addEventListener("click", () => window.yo.panelNavForward(pid));
    bar.appendChild(fwdBtn);

    // Refresh button
    const refreshBtn = document.createElement("button");
    refreshBtn.className = "cell-nav-btn";
    refreshBtn.title = "Refresh";
    refreshBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>';
    refreshBtn.addEventListener("click", () => window.yo.panelNavRefresh(pid));
    bar.appendChild(refreshBtn);

    const fav = document.createElement("img");
    fav.className = "cell-url-bar-favicon";
    fav.width = 12;
    fav.height = 12;
    fav.src = panelFaviconCache[cb.panelId] || "";
    fav.onerror = () => { fav.src = ""; };
    bar.appendChild(fav);

    const input = document.createElement("input");
    input.className = "cell-url-bar-text";
    input.type = "text";
    input.value = panelUrlCache[cb.panelId] || "";
    input.title = panelUrlCache[cb.panelId] || cb.panelId;
    input.spellcheck = false;
    input.addEventListener("focus", () => input.select());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const url = input.value.trim();
        if (url) {
          window.yo.panelNavTo(pid, url);
          input.blur();
        }
      }
      if (e.key === "Escape") {
        input.value = panelUrlCache[cb.panelId] || "";
        input.blur();
      }
    });
    bar.appendChild(input);

    cellUrlContainer.appendChild(bar);
  }
}

// Listen for per-panel URL + favicon updates (for cell URL bars)
window.yo.onPanelUrlUpdate((info) => {
  panelUrlCache[info.id] = info.url;
  panelFaviconCache[info.id] = info.favicon;
  renderCellUrlBars();
});

window.yo.onSplitState((info) => {
  currentGrid = info;
  renderGridHandles();

  const isGrid = info && info.panelIds.length > 1;
  if (isGrid && !urlBar.classList.contains("hidden")) {
    // In grid mode: hide global URL bar, show per-cell URL bars
    urlBar.style.visibility = "hidden";
  } else {
    urlBar.style.visibility = "";
  }
  renderCellUrlBars();
});

function renderGridHandles() {
  gridHandles.innerHTML = "";
  if (!currentGrid || currentGrid.panelIds.length < 2) return;

  const grid = currentGrid;

  // Column border handles — use available width (accounts for yo panel)
  const availW = getAvailableWidth();
  let cumCol = 0;
  for (let i = 0; i < grid.cols - 1; i++) {
    cumCol += grid.colWidths[i];
    const handle = document.createElement("div");
    handle.className = "grid-col-handle";
    handle.style.left = `${Math.round(cumCol * availW)}px`;
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
    handle.style.top = `${getContentTop() + cumRow * (window.innerHeight - getContentTop())}px`;
    handle.dataset.type = "row";
    handle.dataset.index = String(i);
    gridHandles.appendChild(handle);
    handle.addEventListener("mousedown", (e) => startDrag(e, "row", i));
  }
}

// Reposition handles on window resize
window.addEventListener("resize", () => {
  if (!currentGrid) return;
  const aw = getAvailableWidth();
  // Column handles
  if (currentGrid.cols > 1) {
    let cc = 0;
    const colHandles = gridHandles.querySelectorAll(".grid-col-handle");
    for (let i = 0; i < colHandles.length; i++) {
      cc += currentGrid.colWidths[i];
      (colHandles[i] as HTMLElement).style.left = `${Math.round(cc * aw)}px`;
    }
  }
  // Row handles
  if (currentGrid.rows > 1) {
    let cr = 0;
    const rowHandles = gridHandles.querySelectorAll(".grid-row-handle");
    for (let i = 0; i < rowHandles.length; i++) {
      cr += currentGrid.rowHeights[i];
      (rowHandles[i] as HTMLElement).style.top =
        `${getContentTop() + cr * (window.innerHeight - getContentTop())}px`;
    }
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
    const aw = getAvailableWidth();
    const fraction = e.clientX / aw;
    const clamped = Math.max(0.05, Math.min(0.95, fraction));
    const handles = gridHandles.querySelectorAll(".grid-col-handle");
    if (handles[dragIndex]) {
      (handles[dragIndex] as HTMLElement).style.left = `${Math.round(clamped * aw)}px`;
    }
  } else {
    const contentHeight = window.innerHeight - getContentTop();
    const fraction = (e.clientY - getContentTop()) / contentHeight;
    const clamped = Math.max(0.05, Math.min(0.95, fraction));
    const handles = gridHandles.querySelectorAll(".grid-row-handle");
    if (handles[dragIndex]) {
      (handles[dragIndex] as HTMLElement).style.top =
        `${getContentTop() + clamped * contentHeight}px`;
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
      const fraction = parseFloat(handle.style.left) / getAvailableWidth();
      window.yo.gridDragEnd("col", dragIndex, fraction);
    }
  } else {
    const handle = gridHandles.querySelectorAll(".grid-row-handle")[dragIndex] as HTMLElement;
    if (handle) {
      const contentHeight = window.innerHeight - getContentTop();
      const top = parseFloat(handle.style.top) - getContentTop();
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

// -- Yo agent slide-out panel --

const yoPanel = document.getElementById("yo-panel")!;
const yoPanelMessages = document.getElementById("yo-panel-messages")!;
const yoPanelInput = document.getElementById("yo-panel-input") as HTMLTextAreaElement;
const yoPanelSendBtn = document.getElementById("yo-panel-send")!;
const yoPanelCloseBtn = document.querySelector(".yo-panel-close")!;
const yoPanelResize = document.getElementById("yo-panel-resize")!;
const yoHistoryToggle = document.getElementById("yo-history-toggle")!;
const yoHistoryPanel = document.getElementById("yo-history")!;
const yoHistoryList = document.getElementById("yo-history-list")!;
const yoChatNewBtn = document.getElementById("yo-chat-new")!;

let yoResponseEl: HTMLElement | null = null;  // the single assistant response element
let yoStatusEl: HTMLElement | null = null;    // spinner + tool status line (persists until response)
let yoLastAssistantText = "";
let yoToolsUsed = false;  // once a tool fires, suppress streamed text until done
let yoThinking = false;   // true while agent is processing

function setYoThinking(thinking: boolean) {
  yoThinking = thinking;
  yoPanelSendBtn.textContent = thinking ? "\u25A0" : "\u2191";
  yoPanelSendBtn.classList.toggle("yo-stop", thinking);
}

function hideYoWelcome() {
  const w = document.getElementById("yo-panel-welcome");
  if (w) w.remove();
}

function showYoWelcome() {
  hideYoWelcome();
  const w = document.createElement("div");
  w.id = "yo-panel-welcome";
  w.className = "yo-panel-welcome";
  w.innerHTML = `<div class="yo-welcome-logo"><span class="yo-welcome-dot">.</span>Yo <span class="yo-welcome-dot">.</span>Sup</div>
    <div class="yo-welcome-tagline">Your AI workspace agent</div>
    <div class="yo-welcome-hints">
      <div class="yo-welcome-hint">find that reddit thread about pricing</div>
      <div class="yo-welcome-hint">open gmail and claude side by side</div>
      <div class="yo-welcome-hint">create a skill called summarize</div>
      <div class="yo-welcome-hint">what did I capture yesterday?</div>
    </div>`;
  yoPanelMessages.appendChild(w);
  w.querySelectorAll(".yo-welcome-hint").forEach((hint) => {
    hint.addEventListener("click", () => {
      const text = hint.textContent || "";
      hideYoWelcome();
      addYoUserMessage(text);
      showYoStatus("");
      setYoThinking(true);
      window.yo.yoPanelSend(text);
    });
  });
}

async function openYoPanel(query: string) {
  const savedWidth = await window.yo.yoPanelGetWidth();
  yoPanel.style.width = `${savedWidth}px`;
  yoPanel.classList.remove("hidden");
  void yoPanel.offsetHeight;
  yoPanel.classList.add("open");
  yoToolsUsed = false;
  yoTimelineEl = null;
  yoSpinnerEl = null;
  if (query) {
    hideYoWelcome();
    addYoUserMessage(query);
    showYoStatus("");
    setYoThinking(true);
  } else {
    showYoWelcome();
  }
  yoPanelInput.value = "";
  autoGrowYoInput();
  // Focus after slide animation; re-render grid handles (available width changed)
  setTimeout(() => { yoPanelInput.focus(); yoPanelInput.select(); renderGridHandles(); }, 220);
}

function closeYoPanel() {
  yoPanel.classList.remove("open");
  setTimeout(() => {
    yoPanel.classList.add("hidden");
    yoPanelMessages.innerHTML = "";
    yoResponseEl = null;
    yoStatusEl = null;
    yoLastAssistantText = "";
    yoTimelineEl = null;
    yoSpinnerEl = null;
    renderGridHandles(); // available width restored
  }, 200);
}

function isYoPanelOpen(): boolean {
  return yoPanel.classList.contains("open");
}

function addYoUserMessage(text: string) {
  const el = document.createElement("div");
  el.className = "yo-msg yo-msg-user";
  el.textContent = text;
  yoPanelMessages.appendChild(el);
  yoPanelMessages.scrollTop = yoPanelMessages.scrollHeight;
}

// ── Yo panel rendering ──────────────────────────
//
// Delegation title as header, sub-tool steps accumulate
// below with dots + vertical line. Big braille spinner
// on the active step. Text streams under the timeline.

const DELEGATION_DESC: Record<string, string> = {
  delegate_navigator:  "Navigating panels",
  delegate_researcher: "Searching notes & files",
  delegate_manager:    "Managing workspace",
  delegate_skill:      "Running skill",
};

const DIRECT_TOOL_DESC: Record<string, string> = {
  inject_text: "Pasting into input",
  run_command: "Running command",
  save_memory: "Saving to memory",
};

const BRAILLE = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827"];
const PHRASES = ["thinking", "cooking", "vibing", "brewing", "conjuring", "channeling"];

let yoSpinnerInterval: ReturnType<typeof setInterval> | null = null;
let yoSpinnerEl: HTMLElement | null = null;
let yoTimelineEl: HTMLElement | null = null;    // shared timeline for result items

function yoScroll() {
  yoPanelMessages.scrollTop = yoPanelMessages.scrollHeight;
}

function startSpinner(el: HTMLElement) {
  let fi = 0;
  const s = el.querySelector(".yo-ag-spinner") as HTMLElement;
  if (!s) return;
  if (yoSpinnerInterval) clearInterval(yoSpinnerInterval);
  yoSpinnerInterval = setInterval(() => {
    fi = (fi + 1) % BRAILLE.length;
    s.textContent = BRAILLE[fi];
  }, 80);
}

function stopSpinner() {
  if (yoSpinnerInterval) { clearInterval(yoSpinnerInterval); yoSpinnerInterval = null; }
}

/** Show or reuse the spinner row with a random funny phrase */
function ensureSpinner() {
  if (yoSpinnerEl) return;
  const phrase = PHRASES[Math.floor(Math.random() * PHRASES.length)];
  yoSpinnerEl = document.createElement("div");
  yoSpinnerEl.className = "yo-ag-active";
  yoSpinnerEl.innerHTML =
    `<span class="yo-ag-spinner">\u280B</span>` +
    `<span class="yo-ag-phrase">${phrase}...</span>`;
  yoPanelMessages.appendChild(yoSpinnerEl);
  startSpinner(yoSpinnerEl);
}

/** Remove the spinner row */
function removeSpinner() {
  stopSpinner();
  if (yoSpinnerEl) { yoSpinnerEl.remove(); yoSpinnerEl = null; }
}

/** Ensure a timeline container exists for result items */
function ensureTimeline() {
  if (yoTimelineEl) return;
  yoTimelineEl = document.createElement("div");
  yoTimelineEl.className = "yo-ag-timeline";
  yoPanelMessages.appendChild(yoTimelineEl);
}

// Per-tool rows: map tool_use id → row element so onToolResult can finalize it
const yoToolRows = new Map<string, HTMLElement>();

/** Human-readable summary of what a tool is doing, derived from its input. */
function toolInputSummary(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  if (name === "delegate_skill") {
    const parts: string[] = [];
    if (typeof obj.skill_name === "string") parts.push(obj.skill_name);
    if (typeof obj.instruction === "string") parts.push(obj.instruction);
    return parts.join(": ");
  }
  if (name.startsWith("delegate_") && typeof obj.instruction === "string") {
    return obj.instruction;
  }
  if (name === "inject_text" && typeof obj.text === "string") return obj.text;
  if (name === "run_command" && typeof obj.command === "string") return obj.command;
  if (name === "save_memory") {
    if (typeof obj.content === "string") return obj.content;
    if (typeof obj.text === "string") return obj.text;
  }
  const firstStr = Object.values(obj).find((v) => typeof v === "string");
  return typeof firstStr === "string" ? firstStr : "";
}

/** Start a per-tool row: dot (pulsing), bold name, subtitle describing the action. */
function startToolRow(id: string, name: string, input: unknown) {
  ensureTimeline();
  const block = document.createElement("div");
  block.className = "yo-result-block yo-active";

  const header = document.createElement("div");
  header.className = "yo-result-header";

  const dot = document.createElement("span");
  dot.className = "yo-ag-dot";
  header.appendChild(dot);

  const headings = document.createElement("div");
  headings.className = "yo-result-headings";

  const nameEl = document.createElement("span");
  nameEl.className = "yo-result-name";
  nameEl.textContent = DELEGATION_DESC[name] || DIRECT_TOOL_DESC[name] || name.replace(/_/g, " ");
  headings.appendChild(nameEl);

  const subtitleText = toolInputSummary(name, input);
  if (subtitleText) {
    const sub = document.createElement("span");
    sub.className = "yo-result-subtitle";
    sub.textContent = subtitleText;
    headings.appendChild(sub);
  }
  header.appendChild(headings);
  block.appendChild(header);

  yoTimelineEl!.appendChild(block);
  yoToolRows.set(id, block);
  yoScroll();
}

/** Finalize a tool row: stop pulsing and attach expandable detail if present. */
function finishToolRow(id: string, detail: string) {
  const block = yoToolRows.get(id);
  yoToolRows.delete(id);
  if (!block) return;
  block.classList.remove("yo-active");
  block.classList.add("yo-done");

  const trimmed = detail.trim();
  if (trimmed) {
    const content = document.createElement("div");
    content.className = "yo-result-content";
    content.textContent = trimmed;
    block.appendChild(content);

    const showLess = document.createElement("button");
    showLess.type = "button";
    showLess.className = "yo-result-show-less";
    showLess.textContent = "Show less";
    block.appendChild(showLess);

    block.classList.add("yo-has-detail");

    requestAnimationFrame(() => {
      if (content.scrollHeight > content.clientHeight + 1) {
        content.classList.add("yo-overflow");
      }
    });

    // Collapsed → click anywhere on the row expands.
    // Expanded → only the Show less button collapses (so scrolling/selecting
    // text inside the panel doesn't accidentally close it).
    block.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (block.classList.contains("yo-expanded")) {
        if (target.closest(".yo-result-show-less")) {
          block.classList.remove("yo-expanded");
        }
      } else {
        block.classList.add("yo-expanded");
      }
    });
  }
  yoScroll();
}

/** Close the timeline (done state) */
function finishTimeline() {
  removeSpinner();
  if (yoTimelineEl) {
    yoTimelineEl.classList.add("done");
    yoTimelineEl = null;
  }
}

/** Show initial thinking indicator */
function showYoStatus(_toolText: string) {
  if (yoStatusEl) return;
  yoStatusEl = document.createElement("div");
  yoStatusEl.className = "yo-msg yo-msg-status";
  const phrase = PHRASES[Math.floor(Math.random() * PHRASES.length)];
  yoStatusEl.innerHTML =
    `<span class="yo-ag-spinner">\u280B</span>` +
    `<span class="yo-ag-phrase">${phrase}...</span>`;
  yoPanelMessages.appendChild(yoStatusEl);
  startSpinner(yoStatusEl);
}

function clearYoStatus() {
  stopSpinner();
  if (yoStatusEl) { yoStatusEl.remove(); yoStatusEl = null; }
}

function showYoToolUse(id: string, name: string, input: unknown) {
  yoToolsUsed = true;

  // Keep the spinner alive through tool execution — create it if it isn't
  // already showing. It only clears when text streaming starts or the run ends.
  if (!yoStatusEl) showYoStatus("");

  // Finalize any in-progress streaming text
  if (yoResponseEl) {
    yoResponseEl = null;
    yoLastAssistantText = "";
  }

  startToolRow(id, name, input);

  // Keep the spinner pinned below the latest tool row.
  if (yoStatusEl) yoPanelMessages.appendChild(yoStatusEl);
}

function showYoToolResult(id: string, detail: string) {
  finishToolRow(id, detail);
}

function appendYoToken(delta: string) {
  if (!yoResponseEl) {
    if (yoStatusEl) clearYoStatus();
    finishTimeline();

    yoResponseEl = document.createElement("div");
    yoResponseEl.className = "yo-msg yo-msg-assistant";
    yoPanelMessages.appendChild(yoResponseEl);
    yoLastAssistantText = "";
  }
  yoLastAssistantText += delta;
  yoResponseEl.textContent = yoLastAssistantText;
  yoScroll();
}

function finalizeYoMessage(fullText: string) {
  clearYoStatus();
  setYoThinking(false);
  finishTimeline();

  const text = fullText || yoLastAssistantText;

  if (yoResponseEl) {
    yoResponseEl.innerHTML = formatYoText(text);
  } else {
    yoResponseEl = document.createElement("div");
    yoResponseEl.className = "yo-msg yo-msg-assistant";
    yoResponseEl.innerHTML = formatYoText(text);
    yoPanelMessages.appendChild(yoResponseEl);
  }

  yoLastAssistantText = text;
  yoResponseEl = null;
  yoScroll();
}

/** Format agent text — numbered lists become task items */
function formatYoText(text: string): string {
  if (!text) return "";
  let safe = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  safe = safe.replace(
    /^(\d+)\.\s+(.+)$/gm,
    '<div class="yo-task-item"><span class="yo-task-check">\u2713</span><span class="yo-task-text">$2</span></div>'
  );
  return safe;
}

function showYoError(err: string) {
  clearYoStatus();
  setYoThinking(false);
  finishTimeline();
  if (yoResponseEl) { yoResponseEl.remove(); yoResponseEl = null; }
  const el = document.createElement("div");
  el.className = "yo-msg yo-msg-error";
  el.textContent = err;
  yoPanelMessages.appendChild(el);
  yoScroll();
}

function autoGrowYoInput() {
  yoPanelInput.style.height = "44px";
  yoPanelInput.style.height = Math.min(yoPanelInput.scrollHeight, 160) + "px";
}

function sendYoPanelMessage() {
  const text = yoPanelInput.value.trim();
  if (!text) return;
  hideYoWelcome();
  yoPanelInput.value = "";
  autoGrowYoInput();
  yoToolsUsed = false;
  yoTimelineEl = null;
  yoSpinnerEl = null;
  addYoUserMessage(text);
  showYoStatus("");
  setYoThinking(true);
  window.yo.yoPanelSend(text);
}

// Auto-grow textarea as user types
yoPanelInput.addEventListener("input", autoGrowYoInput);

// IPC listeners
window.yo.onYoPanelOpen((query) => openYoPanel(query));
window.yo.onYoPanelToken((delta) => appendYoToken(delta));
window.yo.onYoPanelToolUse((id, name, input) => showYoToolUse(id, name, input));
window.yo.onYoPanelToolResult((id, detail) => showYoToolResult(id, detail));
window.yo.onYoPanelDone((fullText) => finalizeYoMessage(fullText));
window.yo.onYoPanelError((err) => showYoError(err));
window.yo.onYoPanelClose(() => closeYoPanel());

// Input handlers
yoPanelSendBtn.addEventListener("click", () => {
  if (yoThinking) {
    window.yo.yoPanelStop();
    clearYoStatus();
    setYoThinking(false);
  } else {
    sendYoPanelMessage();
  }
});
yoPanelInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendYoPanelMessage();
  }
});

yoPanelCloseBtn.addEventListener("click", () => {
  window.yo.yoPanelDismiss();
});

// -- Yo panel resize --

let yoPanelDragging = false;

yoPanelResize.addEventListener("mousedown", (e) => {
  e.preventDefault();
  yoPanelDragging = true;
  yoPanelResize.classList.add("dragging");
  yoPanel.style.transition = "none"; // disable slide animation during drag
});

document.addEventListener("mousemove", (e) => {
  if (!yoPanelDragging) return;
  const newWidth = Math.max(280, Math.min(window.innerWidth * 0.6, window.innerWidth - e.clientX));
  yoPanel.style.width = `${newWidth}px`;
  window.yo.yoPanelResize(newWidth);
});

document.addEventListener("mouseup", () => {
  if (!yoPanelDragging) return;
  yoPanelDragging = false;
  yoPanelResize.classList.remove("dragging");
  yoPanel.style.transition = "";
  // Persist width
  const width = parseInt(yoPanel.style.width, 10);
  if (width) window.yo.yoPanelWidthSave(width);
});

// -- Yo chat history --

async function loadYoHistory() {
  const chats = await window.yo.yoChatsList();
  yoHistoryList.innerHTML = "";
  if (chats.length === 0) {
    const empty = document.createElement("div");
    empty.className = "yo-history-empty";
    empty.textContent = "no conversations yet";
    yoHistoryList.appendChild(empty);
    return;
  }
  for (const chat of chats) {
    const item = document.createElement("div");
    item.className = "yo-history-item";

    const title = document.createElement("span");
    title.className = "yo-history-title";
    title.textContent = chat.title || chat.id;

    const date = document.createElement("span");
    date.className = "yo-history-date";
    if (chat.created) {
      const d = new Date(chat.created);
      const now = new Date();
      if (d.toDateString() === now.toDateString()) {
        date.textContent = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      } else {
        date.textContent = d.toLocaleDateString([], { month: "short", day: "numeric" });
      }
    }

    const del = document.createElement("button");
    del.className = "yo-history-delete";
    del.textContent = "\u00d7";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      await window.yo.yoChatsDelete(chat.id);
      loadYoHistory();
    });

    item.appendChild(title);
    item.appendChild(date);
    item.appendChild(del);
    item.addEventListener("click", async () => {
      const messages = await window.yo.yoChatsLoad(chat.id);
      if (messages) {
        yoPanelMessages.innerHTML = "";
        yoResponseEl = null;
        yoStatusEl = null;
        yoLastAssistantText = "";
        yoHistoryPanel.classList.add("hidden");

        // Render conversation messages
        for (const msg of messages) {
          const el = document.createElement("div");
          if (msg.role === "user") {
            el.className = "yo-msg yo-msg-user";
            el.textContent = msg.text;
          } else {
            el.className = "yo-msg yo-msg-assistant";
            el.innerHTML = formatYoText(msg.text);
            yoLastAssistantText = msg.text;
          }
          yoPanelMessages.appendChild(el);
        }
        yoScroll();
      }
    });
    yoHistoryList.appendChild(item);
  }
}

yoHistoryToggle.addEventListener("click", () => {
  const isHidden = yoHistoryPanel.classList.contains("hidden");
  if (isHidden) {
    loadYoHistory();
    yoHistoryPanel.classList.remove("hidden");
  } else {
    yoHistoryPanel.classList.add("hidden");
  }
});

yoChatNewBtn.addEventListener("click", async () => {
  await window.yo.yoChatNew();
  yoPanelMessages.innerHTML = "";
  yoResponseEl = null;
  yoStatusEl = null;
  yoLastAssistantText = "";
  yoHistoryPanel.classList.add("hidden");
  yoPanelInput.focus();
});

// -- Boot gate --

// Splash — waits for embedder to be ready before dismissing
const splashShownAt = Date.now();
const SPLASH_MIN_MS = 2000;
let booted = false;
let bootData: any = null;


function dismissSplash(): void {
  if (!booted) return;
  const elapsed = Date.now() - splashShownAt;
  const remaining = Math.max(0, SPLASH_MIN_MS - elapsed);
  setTimeout(() => {
    // Show panels first (behind splash z-index:9999) so they're ready when splash fades
    window.yo.panelsShow();
    const splash = document.getElementById("splash");
    if (splash) {
      splash.classList.add("fade-out");
      setTimeout(() => splash.remove(), 600);
    }
  }, remaining);
  if (bootData?.needsOnboarding) {
    showOnboarding(bootData.license.daysRemaining);
  }
}

// Embedder status updates drive the splash status text (cosmetic only, doesn't gate splash)
(window as any).yo.onEmbedderStatus?.((status: { state: string; progress?: number; message?: string }) => {
  const el = document.getElementById("splash-status");
  if (!el) return;
  if (status.state === "downloading") {
    const pct = status.progress != null ? ` ${Math.round(status.progress)}%` : "";
    el.textContent = `downloading brain${pct}`;
    el.classList.remove("done");
  } else if (status.state === "loading") {
    el.textContent = "loading model...";
    el.classList.remove("done");
  } else if (status.state === "ready") {
    el.textContent = "ready";
    el.classList.add("done");
  } else if (status.state === "error") {
    el.textContent = status.message || "model failed — continuing without embeddings";
  }
});

window.yo.onBoot((data) => {
  booted = true;
  bootData = data;
  dismissSplash();

  // Show tutorial on first launch (skip if going through onboarding — handled by yo-onboarding-done)
  if (!data.needsOnboarding) {
    window.yo.getPreference("hasSeenTutorial", false).then((seen) => {
      if (!seen) showTutorial();
    });
  }
});

// After onboarding activation, show tutorial
window.addEventListener("yo-onboarding-done", () => {
  showTutorial();
});

// ── First-time tutorial ──────────────────────────────────

const TUTORIAL_SEQUENCES = [
  ".yo find that reddit thread about pricing",
  ".sup . formalize",
  ".dip split claude gpt",
];

function showTutorial() {
  const overlay = document.getElementById("tutorial-overlay")!;
  overlay.classList.remove("hidden");
  // BrowserViews are native — they paint over HTML. Hide them so tutorial is visible.
  window.yo.panelsHide();
  let step = 0;
  let typeTimer: ReturnType<typeof setTimeout> | null = null;

  function typeText(stepIdx: number) {
    const el = document.getElementById(`tutorial-typed-${stepIdx}`)!;
    if (!el) return;
    const text = TUTORIAL_SEQUENCES[stepIdx];
    let i = 0;
    el.textContent = "";
    function tick() {
      if (i < text.length) {
        el!.textContent = text.slice(0, i + 1);
        i++;
        typeTimer = setTimeout(tick, 40 + Math.random() * 30);
      }
    }
    typeTimer = setTimeout(tick, 400);
  }

  function goToStep(idx: number) {
    if (typeTimer) clearTimeout(typeTimer);
    step = idx;
    overlay.querySelectorAll(".tutorial-step").forEach((s, i) => {
      s.classList.toggle("active", i === idx);
    });
    overlay.querySelectorAll(".tutorial-nav-dot").forEach((d, i) => {
      d.classList.toggle("active", i === idx);
    });

    // Clear previous typed text
    const typed = document.getElementById(`tutorial-typed-${idx}`);
    if (typed) typed.textContent = "";

    const nextBtn = document.getElementById("tutorial-next") as HTMLButtonElement;
    nextBtn.textContent = idx === TUTORIAL_SEQUENCES.length - 1 ? "Get Started" : "Next";

    typeText(idx);
  }

  document.getElementById("tutorial-next")!.addEventListener("click", () => {
    if (step < TUTORIAL_SEQUENCES.length - 1) {
      goToStep(step + 1);
    } else {
      closeTutorial();
    }
  });

  document.getElementById("tutorial-close")!.addEventListener("click", closeTutorial);

  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeTutorial();
  });

  function closeTutorial() {
    if (typeTimer) clearTimeout(typeTimer);
    window.yo.setPreference("hasSeenTutorial", true);
    overlay.classList.add("hidden");
    // Restore panels now that tutorial is dismissed
    window.yo.panelsShow();
  }

  // Start first step
  goToStep(0);
}
