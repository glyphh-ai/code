/**
 * Renderer — command bar + help overlay logic.
 */

import { initHelp, openHelp, closeHelp, isHelpOpen } from "./help.js";
import { showOnboarding } from "./onboarding.js";
import { initAutocomplete, hideDropdown } from "./autocomplete.js";
import { initChat, isChatVisible, hideChat } from "./chat.js";

declare global {
  interface Window {
    yo: {
      command: (input: string) => void;
      onResult: (callback: (result: string) => void) => void;
      windowClose: () => void;
      windowMinimize: () => void;
      windowMaximize: () => void;
      libraryList: () => Promise<string[]>;
      libraryRead: (name: string) => Promise<string | null>;
      libraryWrite: (name: string, content: string) => Promise<boolean>;
      libraryRemove: (name: string) => Promise<boolean>;
      skillsList: () => Promise<string[]>;
      skillsRead: (name: string) => Promise<string | null>;
      skillsWrite: (name: string, prompt: string) => Promise<boolean>;
      skillsRemove: (name: string) => Promise<boolean>;
      panelsHide: () => void;
      panelsShow: () => void;
      panelsRefresh: (id?: string) => void;
      panelsZoom: (factor: number) => void;
      panelsGetZoom: () => Promise<number>;
      // Apps
      appsList: () => Promise<Array<{ id: string; name: string; url: string; connected: boolean; commands: Record<string, { selector: string; action: string; description: string }>; meta?: { description: string; capabilities: string[] } }>>;
      appsAdd: (id: string, name: string, url: string) => Promise<unknown>;
      appsRemove: (id: string) => Promise<boolean>;
      appsUpdateName: (id: string, name: string) => Promise<boolean>;
      appsConnect: (id: string, webContentsId?: number) => Promise<{ ok: boolean; error?: string; commandCount?: number }>;
      appsSetCommand: (id: string, commandKey: string, mapping: { selector: string; action: string; description: string; script?: string }) => Promise<boolean>;
      appsRemoveCommand: (id: string, commandKey: string) => Promise<boolean>;
      appsTestCommand: (id: string, commandKey: string, webContentsId?: number) => Promise<string>;
      layoutsList: () => Promise<Array<{ name: string; splits: Array<{ panelId: string }> }>>;
      layoutsSave: (name: string, panelIds: string[]) => Promise<boolean>;
      layoutsSaveGrid: (grid: { name: string; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }> }) => Promise<boolean>;
      layoutsDelete: (name: string) => Promise<boolean>;
      getCompletions: () => Promise<{ apps: string[]; library: string[]; skills: string[]; layouts: string[] }>;
      splitDragStart: () => void;
      splitDragMove: (ratio: number) => void;
      splitDragEnd: (ratio: number) => void;
      gridDragEnd: (type: "col" | "row", index: number, fraction: number) => void;
      splitSwap: (index: number, panelId: string) => void;
      onboardingComplete: () => Promise<void>;
      startPicker: (webContentsId: number) => void;
      onPickerResult: (callback: (result: unknown) => void) => void;
      checkLicense: () => Promise<{ status: string; daysRemaining?: number }>;
      activateLicense: (key: string) => Promise<boolean>;
      validateApiKey: (key: string) => Promise<{ valid: boolean; error?: string }>;
      getApiKey: () => Promise<string | null>;
      onBoot: (callback: (data: { license: { status: string; daysRemaining?: number }; apiKey: boolean; needsOnboarding: boolean; hideWelcome?: boolean }) => void) => void;
      setPreference: (key: string, value: unknown) => void;
      onShowWelcome: (callback: () => void) => void;
      onSplitState: (callback: (info: {
        panelIds: string[];
        cols: number;
        rows: number;
        colWidths: number[];
        rowHeights: number[];
        cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }>;
      } | null) => void) => void;
      onSplitDragPreview: (callback: (ratio: number) => void) => void;

      // Chat
      chatSend: (message: string) => Promise<void>;
      chatClear: () => void;
      onChatDelta: (callback: (delta: string) => void) => void;
      onChatToolUse: (callback: (data: { name: string; input: unknown }) => void) => void;
      onChatDone: (callback: () => void) => void;
      onShowChat: (callback: () => void) => void;
    };
  }
}

const input = document.getElementById("command-input") as HTMLInputElement;
const resultsDrawer = document.getElementById("results-drawer")!;
const resultsContent = document.getElementById("results-content")!;
const gridHandles = document.getElementById("grid-handles")!;
const splitChips = document.getElementById("split-chips")!;

// ── Results drawer ──────────────────────────────────────────

function showResult(result: string) {
  if (!result) {
    hideResults();
    return;
  }

  const isMultiLine = result.includes("\n");
  resultsContent.textContent = result;

  if (isMultiLine) {
    resultsDrawer.classList.remove("hidden", "inline");
    resultsDrawer.classList.add("expanded");
  } else {
    resultsDrawer.classList.remove("hidden", "expanded");
    resultsDrawer.classList.add("inline");
    setTimeout(hideResults, 4000);
  }
}

function hideResults() {
  resultsDrawer.classList.add("hidden");
  resultsDrawer.classList.remove("inline", "expanded");
}

// ── Command input ───────────────────────────────────────────

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    // Autocomplete dropdown handles its own Enter when item is selected
    const value = input.value.trim();
    if (value) {
      hideResults();
      hideDropdown();
      window.yo.command(value);
      input.value = "";
    }
  }

  if (e.key === "Escape") {
    if (resultsDrawer.classList.contains("expanded")) {
      hideResults();
    } else if (isHelpOpen()) {
      closeHelp();
    } else if (isChatVisible()) {
      hideChat();
      window.yo.panelsShow();
    } else {
      input.value = "";
      input.blur();
    }
  }
});

// Global Escape (for when input isn't focused)
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (resultsDrawer.classList.contains("expanded")) {
      hideResults();
    } else if (isHelpOpen()) {
      closeHelp();
    } else if (isChatVisible()) {
      hideChat();
      window.yo.panelsShow();
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

// Click outside results drawer closes it
document.addEventListener("click", (e) => {
  if (
    resultsDrawer.classList.contains("expanded") &&
    !(e.target as HTMLElement).closest("#results-drawer") &&
    !(e.target as HTMLElement).closest("#command-bar")
  ) {
    hideResults();
  }
});

// Show command results
window.yo.onResult((result: string) => {
  showResult(result);
});

// Window controls
document.getElementById("btn-close")!.addEventListener("click", () => window.yo.windowClose());
document.getElementById("btn-minimize")!.addEventListener("click", () => window.yo.windowMinimize());
document.getElementById("btn-maximize")!.addEventListener("click", () => window.yo.windowMaximize());
document.getElementById("btn-refresh")!.addEventListener("click", () => window.yo.panelsRefresh());

// yo help trigger from main process
window.yo.onShowWelcome(() => openHelp());

// Initialize help overlay + autocomplete + chat
initHelp();
initAutocomplete();
initChat();

// ── Grid drag handles ───────────────────────────────────────

type GridInfo = {
  panelIds: string[];
  cols: number;
  rows: number;
  colWidths: number[];
  rowHeights: number[];
  cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }>;
};

const CONTENT_TOP = 48;
let currentGrid: GridInfo | null = null;
let isDragging = false;
let dragType: "col" | "row" = "col";
let dragIndex = 0;
let activeSwapIndex = -1;

window.yo.onSplitState((info) => {
  currentGrid = info;
  renderGridHandles();
  if (info && info.panelIds.length >= 2) {
    renderSplitChips(info.panelIds);
  } else {
    splitChips.classList.add("hidden");
  }
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

// Reposition row handles on window resize (col handles use % so they auto-adjust)
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

function renderSplitChips(panelIds: string[]) {
  splitChips.innerHTML = panelIds
    .map((id, i) => `<button class="split-chip" data-index="${i}">${id}</button>`)
    .join(`<span class="split-chip-sep">|</span>`);
  splitChips.classList.remove("hidden");

  splitChips.querySelectorAll(".split-chip").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt((btn as HTMLElement).dataset.index!, 10);
      toggleSwapDropdown(idx, btn as HTMLElement);
    });
  });
}

async function toggleSwapDropdown(index: number, anchor: HTMLElement) {
  const existing = document.getElementById("swap-dropdown");
  if (existing) {
    existing.remove();
    activeSwapIndex = -1;
    window.yo.panelsShow();
    return;
  }

  activeSwapIndex = index;
  window.yo.panelsHide();

  const completions = await window.yo.getCompletions();
  const current = currentGrid?.panelIds[index] ?? "";

  const dd = document.createElement("div");
  dd.id = "swap-dropdown";
  dd.className = "swap-dropdown";

  const rect = anchor.getBoundingClientRect();
  dd.style.left = `${rect.left}px`;
  dd.style.top = `${rect.bottom + 4}px`;

  dd.innerHTML = completions.apps
    .filter((p) => p !== current)
    .map((p) => `<div class="swap-item" data-id="${p}">${p}</div>`)
    .join("");

  document.body.appendChild(dd);

  dd.querySelectorAll(".swap-item").forEach((item) => {
    item.addEventListener("click", () => {
      window.yo.splitSwap(index, (item as HTMLElement).dataset.id!);
      dd.remove();
      activeSwapIndex = -1;
    });
  });

  const closeHandler = (e: MouseEvent) => {
    if (!(e.target as HTMLElement).closest("#swap-dropdown") &&
        !(e.target as HTMLElement).closest(".split-chip")) {
      dd.remove();
      activeSwapIndex = -1;
      window.yo.panelsShow();
      document.removeEventListener("click", closeHandler);
    }
  };
  setTimeout(() => document.addEventListener("click", closeHandler), 0);
}

// ── Drag protocol ─────────────────────────────────────────

function startDrag(e: MouseEvent, type: "col" | "row", index: number) {
  e.preventDefault();
  isDragging = true;
  dragType = type;
  dragIndex = index;

  const handle = e.currentTarget as HTMLElement;
  handle.classList.add("dragging");

  window.yo.splitDragStart();

  const overlay = document.getElementById("drag-overlay")!;
  overlay.classList.remove("hidden");
  overlay.className = type === "col" ? "drag-col" : "drag-row";
}

document.addEventListener("mousemove", (e) => {
  if (!isDragging || !currentGrid) return;

  if (dragType === "col") {
    const fraction = e.clientX / window.innerWidth;
    const clamped = Math.max(0.05, Math.min(0.95, fraction));
    // Update the handle position visually
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

  // Remove dragging class from all handles
  gridHandles.querySelectorAll(".dragging").forEach((el) => el.classList.remove("dragging"));

  const overlay = document.getElementById("drag-overlay")!;
  overlay.classList.add("hidden");
  overlay.className = "";

  // Compute final fraction and send to main
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

// Auto-focus command input
input.focus();
