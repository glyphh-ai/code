/**
 * Renderer — titlebar + grid handles + boot gate.
 *
 * All user commands (yo/dip/drip) happen inside app panels
 * via the interceptor, or from the command bar. The renderer
 * manages window chrome and session state display.
 */

import { initHelp, openHelp, openSettings, closeHelp, isHelpOpen } from "./help.js";
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
      tabList: () => Promise<{ tabs: Array<{ id: string; name: string }>; activeId: string; visible: boolean }>;
      tabSwitch: (id: string) => void;
      tabClose: (id: string) => void;
      tabNew: () => void;
      onTabState: (callback: (state: { tabs: Array<{ id: string; name: string }>; activeId: string; visible: boolean }) => void) => void;
      // License info
      getLicenseInfo: () => Promise<{ status: string; key?: string; tier?: string; daysRemaining?: number }>;
      getCheckoutUrlForPlan: (plan: string) => Promise<string | null>;
      getBillingPortalUrl: () => Promise<string | null>;
      openExternal: (url: string) => void;
      // MCP API keys
      mcpKeysCreate: (label: string, duration: string) => Promise<{ ok: boolean; token?: string; label?: string; expiresAt?: string | null; error?: string }>;
      mcpKeysList: () => Promise<{ ok: boolean; keys?: Array<{ token: string; tokenFull: string; label: string; createdAt: string; expiresAt: string | null }>; error?: string }>;
      mcpKeysRevoke: (token: string) => Promise<{ ok: boolean; revoked?: boolean; error?: string }>;
      // Support
      submitSupportTicket: (ticket: { subject: string; description: string }) => Promise<{ ok: boolean; error?: string }>;
      // Yo agent panel
      yoPanelSend: (message: string) => void;
      yoPanelDismiss: () => void;
      onYoPanelOpen: (cb: (query: string) => void) => void;
      onYoPanelToken: (cb: (delta: string) => void) => void;
      onYoPanelToolUse: (cb: (tool: string) => void) => void;
      onYoPanelDone: (cb: (fullText: string) => void) => void;
      onYoPanelError: (cb: (err: string) => void) => void;
      onYoPanelClose: (cb: () => void) => void;
      // Yo chat history
      yoChatsList: () => Promise<Array<{ id: string; title: string; created: string; messageCount: number }>>;
      yoChatsLoad: (id: string) => Promise<boolean>;
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

function renderTabs(tabs: Array<{ id: string; name: string }>, activeId: string) {
  tabBar.innerHTML = "";
  for (const tab of tabs) {
    const el = document.createElement("div");
    el.className = "tab" + (tab.id === activeId ? " tab-active" : "");
    el.dataset.id = tab.id;
    el.innerHTML = `<span class="tab-label">${tab.name}</span><button class="tab-close" title="Close tab">&times;</button>`;
    el.querySelector(".tab-label")!.addEventListener("click", () => {
      window.yo.tabSwitch(tab.id);
    });
    el.querySelector(".tab-close")!.addEventListener("click", (e) => {
      e.stopPropagation();
      window.yo.tabClose(tab.id);
    });
    tabBar.appendChild(el);
  }
}

tabNewBtn.addEventListener("click", () => window.yo.tabNew());

window.yo.onTabState((state: { tabs: Array<{ id: string; name: string }>; activeId: string; visible: boolean }) => {
  renderTabs(state.tabs, state.activeId);
  tabBar.style.display = state.visible ? "flex" : "none";
  tabNewBtn.style.display = state.visible ? "" : "none";
  // Close help overlay whenever panels switch — help should never stay open over panels
  if (isHelpOpen()) closeHelp();
});

// Load initial tab state
window.yo.tabList().then((state) => {
  renderTabs(state.tabs, state.activeId);
  tabBar.style.display = state.visible ? "flex" : "none";
  tabNewBtn.style.display = state.visible ? "" : "none";
});

// -- Cmd+K command overlay --

const cmdkOverlay = document.getElementById("cmdk-overlay")!;
const cmdkInput = document.getElementById("cmdk-input") as HTMLInputElement;
let resultTimer: ReturnType<typeof setTimeout> | null = null;

async function openCmdK() {
  if (!cmdkOverlay.classList.contains("hidden")) return;
  await showPanelScreenshots();
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
  clearPanelScreenshots();
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
      if (result) {
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

// .yo help link in Cmd+K
document.getElementById("cmdk-help-link")!.addEventListener("click", () => {
  closeCmdK();
  openHelp();
});

// Cmd+K from panel -> open overlay
window.yo.onFocusInput(() => openCmdK());



// -- Global keyboard shortcuts --

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (isYoPanelOpen()) window.yo.yoPanelDismiss();
    else if (isCmdKOpen()) closeCmdK();
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

// -- Yo agent slide-out panel --

const yoPanel = document.getElementById("yo-panel")!;
const yoPanelMessages = document.getElementById("yo-panel-messages")!;
const yoPanelInput = document.getElementById("yo-panel-input") as HTMLTextAreaElement;
const yoPanelSendBtn = document.getElementById("yo-panel-send")!;
const yoPanelCloseBtn = document.querySelector(".yo-panel-close")!;
const yoHistoryToggle = document.getElementById("yo-history-toggle")!;
const yoHistoryPanel = document.getElementById("yo-history")!;
const yoHistoryList = document.getElementById("yo-history-list")!;
const yoChatNewBtn = document.getElementById("yo-chat-new")!;

let yoResponseEl: HTMLElement | null = null;  // the single assistant response element
let yoStatusEl: HTMLElement | null = null;    // spinner + tool status line (persists until response)
let yoLastAssistantText = "";
let yoToolsUsed = false;  // once a tool fires, suppress streamed text until done

function openYoPanel(query: string) {
  yoPanel.classList.remove("hidden");
  void yoPanel.offsetHeight;
  yoPanel.classList.add("open");
  yoToolsUsed = false;
  if (query) {
    addYoUserMessage(query);
    showYoStatus("");
  }
  yoPanelInput.value = "";
  autoGrowYoInput();
  setTimeout(() => yoPanelInput.focus(), 220);
}

function closeYoPanel() {
  yoPanel.classList.remove("open");
  setTimeout(() => {
    yoPanel.classList.add("hidden");
    yoPanelMessages.innerHTML = "";
    yoResponseEl = null;
    yoStatusEl = null;
    yoLastAssistantText = "";
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

let yoSpinnerInterval: ReturnType<typeof setInterval> | null = null;

/** Show or update the single persistent braille spinner + status line */
function showYoStatus(toolText: string) {
  if (!yoStatusEl) {
    yoStatusEl = document.createElement("div");
    yoStatusEl.className = "yo-msg yo-msg-status";
    yoPanelMessages.appendChild(yoStatusEl);
  }
  // Update label text, keep the same spinner running
  (yoStatusEl as any).__label = toolText || "";
  if (!yoSpinnerInterval) {
    const frames = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827"];
    const words = ["chilling...", "vibing...", "yozing...", "cooking...", "thinking...", "brewing...", "manifesting...", "marinating..."];
    let fi = 0;
    let curWord = words[Math.floor(Math.random() * words.length)];
    let lastSwap = Date.now();
    const tick = () => {
      if (!yoStatusEl) return;
      fi = (fi + 1) % frames.length;
      const label = (yoStatusEl as any).__label;
      const display = label || curWord;
      yoStatusEl.textContent = `${frames[fi]} ${display}`;
      if (!label && Date.now() - lastSwap > 3000) {
        let next = words[Math.floor(Math.random() * words.length)];
        while (next === curWord && words.length > 1) next = words[Math.floor(Math.random() * words.length)];
        curWord = next;
        lastSwap = Date.now();
      }
      yoPanelMessages.scrollTop = yoPanelMessages.scrollHeight;
    };
    tick();
    yoSpinnerInterval = setInterval(tick, 100);
  } else {
    // Spinner already running, just force an immediate label update
    const frames = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827"];
    const label = (yoStatusEl as any).__label;
    yoStatusEl.textContent = `${frames[0]} ${label}`;
  }
}

/** Remove the status spinner (called when streaming text begins) */
function clearYoStatus() {
  if (yoSpinnerInterval) {
    clearInterval(yoSpinnerInterval);
    yoSpinnerInterval = null;
  }
  if (yoStatusEl) {
    yoStatusEl.remove();
    yoStatusEl = null;
  }
}

function appendYoToken(delta: string) {
  // Once tools have fired, suppress streamed text — the agent is "thinking out loud"
  // between tool calls. Only the spinner should be visible. Final text comes via onDone.
  if (yoToolsUsed) return;

  // First token — remove spinner, create response element
  if (!yoResponseEl) {
    clearYoStatus();
    yoResponseEl = document.createElement("div");
    yoResponseEl.className = "yo-msg yo-msg-assistant";
    yoPanelMessages.appendChild(yoResponseEl);
    yoLastAssistantText = "";
  }
  yoLastAssistantText += delta;
  yoResponseEl.textContent = yoLastAssistantText;
  yoPanelMessages.scrollTop = yoPanelMessages.scrollHeight;
}

function showYoToolUse(tool: string) {
  yoToolsUsed = true;
  // If there was streamed text before this tool call, discard it (pre-tool thinking)
  if (yoResponseEl) {
    yoResponseEl.remove();
    yoResponseEl = null;
    yoLastAssistantText = "";
  }
  const label = tool === "search_memory" ? "searching memory..." :
                tool === "search_files" ? "searching files..." :
                tool === "read_file" ? "reading file..." :
                tool === "grab_panel" ? "grabbing panel..." :
                `using ${tool}...`;
  showYoStatus(label);
}

function finalizeYoMessage(fullText: string) {
  clearYoStatus();
  const text = fullText || yoLastAssistantText;

  // If there's already a streaming element showing the text, just keep it
  if (yoResponseEl) {
    yoResponseEl.textContent = text;
  } else {
    // No streaming element — create one for the final text
    yoResponseEl = document.createElement("div");
    yoResponseEl.className = "yo-msg yo-msg-assistant";
    yoResponseEl.textContent = text;
    yoPanelMessages.appendChild(yoResponseEl);
  }

  yoLastAssistantText = text;
  yoResponseEl = null;
  yoPanelMessages.scrollTop = yoPanelMessages.scrollHeight;
}

function showYoError(err: string) {
  clearYoStatus();
  if (yoResponseEl) { yoResponseEl.remove(); yoResponseEl = null; }
  const el = document.createElement("div");
  el.className = "yo-msg yo-msg-error";
  el.textContent = err;
  yoPanelMessages.appendChild(el);
  yoPanelMessages.scrollTop = yoPanelMessages.scrollHeight;
}

function autoGrowYoInput() {
  yoPanelInput.style.height = "44px";
  yoPanelInput.style.height = Math.min(yoPanelInput.scrollHeight, 160) + "px";
}

function sendYoPanelMessage() {
  const text = yoPanelInput.value.trim();
  if (!text) return;
  yoPanelInput.value = "";
  autoGrowYoInput();
  yoToolsUsed = false;
  addYoUserMessage(text);
  showYoStatus("");
  window.yo.yoPanelSend(text);
}

// Auto-grow textarea as user types
yoPanelInput.addEventListener("input", autoGrowYoInput);

// IPC listeners
window.yo.onYoPanelOpen((query) => openYoPanel(query));
window.yo.onYoPanelToken((delta) => appendYoToken(delta));
window.yo.onYoPanelToolUse((tool) => showYoToolUse(tool));
window.yo.onYoPanelDone((fullText) => finalizeYoMessage(fullText));
window.yo.onYoPanelError((err) => showYoError(err));
window.yo.onYoPanelClose(() => closeYoPanel());

// Input handlers
yoPanelSendBtn.addEventListener("click", sendYoPanelMessage);
yoPanelInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendYoPanelMessage();
  }
});

yoPanelCloseBtn.addEventListener("click", () => {
  window.yo.yoPanelDismiss();
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
      const ok = await window.yo.yoChatsLoad(chat.id);
      if (ok) {
        yoPanelMessages.innerHTML = "";
        yoResponseEl = null;
        yoStatusEl = null;
        yoLastAssistantText = "";
        yoHistoryPanel.classList.add("hidden");
        // Show a loaded indicator
        const loaded = document.createElement("div");
        loaded.className = "yo-msg yo-msg-assistant";
        loaded.textContent = `loaded: ${chat.title}`;
        loaded.style.color = "#555";
        loaded.style.fontStyle = "italic";
        yoPanelMessages.appendChild(loaded);
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
let embedderReady = false;

function dismissSplash(): void {
  if (!booted || !embedderReady) return;
  const elapsed = Date.now() - splashShownAt;
  const remaining = Math.max(0, SPLASH_MIN_MS - elapsed);
  setTimeout(() => {
    const splash = document.getElementById("splash");
    if (splash) {
      splash.classList.add("fade-out");
      setTimeout(() => splash.remove(), 600);
    }
    // Show panels now that splash is gone
    window.yo.panelsShow();
  }, remaining);
  if (bootData?.needsOnboarding) {
    showOnboarding(bootData.license.daysRemaining);
  }
}

// Embedder status updates drive the splash status text
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
    embedderReady = true;
    dismissSplash();
  } else if (status.state === "error") {
    el.textContent = status.message || "model failed — continuing without embeddings";
    embedderReady = true; // Don't block the app
    dismissSplash();
  }
});

// If embedder is already cached, status might arrive before boot — or vice versa.
// Also set a timeout so the app isn't stuck if embedder never reports.
setTimeout(() => {
  if (!embedderReady) {
    embedderReady = true;
    dismissSplash();
  }
}, 60_000); // 60s max splash

window.yo.onBoot((data) => {
  booted = true;
  bootData = data;
  // If embedder already signaled ready (fast cached load), dismiss now
  dismissSplash();
});
