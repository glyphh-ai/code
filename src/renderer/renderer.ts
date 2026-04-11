/**
 * Renderer — command bar + help overlay logic.
 */

import { initHelp, openHelp, closeHelp, isHelpOpen } from "./help.js";
import { showOnboarding } from "./onboarding.js";
import { initAutocomplete } from "./autocomplete.js";

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
      panelsList: () => Promise<Array<{ id: string; name: string; url: string }>>;
      panelsAdd: (id: string, url: string) => Promise<boolean>;
      layoutsList: () => Promise<Array<{ name: string; splits: Array<{ panelId: string }> }>>;
      layoutsSave: (name: string, panelIds: string[]) => Promise<boolean>;
      layoutsDelete: (name: string) => Promise<boolean>;
      getCompletions: () => Promise<{ panels: string[]; library: string[]; skills: string[]; layouts: string[] }>;
      splitDragStart: () => void;
      splitDragMove: (ratio: number) => void;
      splitDragEnd: (ratio: number) => void;
      splitSwap: (index: number, panelId: string) => void;
      checkLicense: () => Promise<{ status: string; daysRemaining?: number }>;
      activateLicense: (key: string) => Promise<boolean>;
      validateApiKey: (key: string) => Promise<{ valid: boolean; error?: string }>;
      getApiKey: () => Promise<string | null>;
      onBoot: (callback: (data: { license: { status: string; daysRemaining?: number }; apiKey: boolean; needsOnboarding: boolean; hideWelcome?: boolean }) => void) => void;
      setPreference: (key: string, value: unknown) => void;
      onShowWelcome: (callback: () => void) => void;
      onSplitState: (callback: (info: { panelIds: string[]; ratio: number } | null) => void) => void;
      onSplitDragPreview: (callback: (ratio: number) => void) => void;
    };
  }
}

const input = document.getElementById("command-input") as HTMLInputElement;
const resultsDrawer = document.getElementById("results-drawer")!;
const resultsContent = document.getElementById("results-content")!;
const splitHandle = document.getElementById("split-handle")!;
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
      window.yo.command(value);
      input.value = "";
    }
  }

  if (e.key === "Escape") {
    if (resultsDrawer.classList.contains("expanded")) {
      hideResults();
    } else if (isHelpOpen()) {
      closeHelp();
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
    }
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

// yo help trigger from main process
window.yo.onShowWelcome(() => openHelp());

// Initialize help overlay + autocomplete
initHelp();
initAutocomplete();

// ── Split drag handle ───────────────────────────────────────

let isDragging = false;
let splitPanelIds: string[] = [];
let activeSwapIndex = -1;

window.yo.onSplitState((info) => {
  if (info && info.panelIds.length >= 2) {
    splitPanelIds = info.panelIds;
    splitHandle.style.left = `${info.ratio * 100}%`;
    splitHandle.classList.remove("hidden");
    renderSplitChips(info.panelIds);
  } else {
    splitHandle.classList.add("hidden");
    splitChips.classList.add("hidden");
    splitPanelIds = [];
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
  const current = splitPanelIds[index];

  const dd = document.createElement("div");
  dd.id = "swap-dropdown";
  dd.className = "swap-dropdown";

  const rect = anchor.getBoundingClientRect();
  dd.style.left = `${rect.left}px`;
  dd.style.top = `${rect.bottom + 4}px`;

  dd.innerHTML = completions.panels
    .filter((p) => p !== current)
    .map((p) => `<div class="swap-item" data-id="${p}">${p}</div>`)
    .join("");

  document.body.appendChild(dd);

  dd.querySelectorAll(".swap-item").forEach((item) => {
    item.addEventListener("click", () => {
      window.yo.splitSwap(index, (item as HTMLElement).dataset.id!);
      dd.remove();
      activeSwapIndex = -1;
      // panelsShow will be triggered by split-state update
    });
  });

  // Close on outside click
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

splitHandle.addEventListener("mousedown", (e) => {
  if (splitPanelIds.length < 2) return;
  e.preventDefault();
  isDragging = true;
  splitHandle.classList.add("dragging");
  window.yo.splitDragStart();

  // Show drag overlay to capture all mouse events
  const overlay = document.getElementById("drag-overlay")!;
  overlay.classList.remove("hidden");

  // Show panel labels
  const leftLabel = document.getElementById("drag-label-left")!;
  const rightLabel = document.getElementById("drag-label-right")!;
  leftLabel.textContent = splitPanelIds[0];
  rightLabel.textContent = splitPanelIds[1];
  leftLabel.classList.remove("hidden");
  rightLabel.classList.remove("hidden");
});

document.addEventListener("mousemove", (e) => {
  if (!isDragging) return;
  const ratio = e.clientX / window.innerWidth;
  const clamped = Math.max(0.15, Math.min(0.85, ratio));
  splitHandle.style.left = `${clamped * 100}%`;

  // Position labels
  const leftLabel = document.getElementById("drag-label-left")!;
  const rightLabel = document.getElementById("drag-label-right")!;
  leftLabel.style.width = `${clamped * 100}%`;
  rightLabel.style.left = `${clamped * 100}%`;
  rightLabel.style.width = `${(1 - clamped) * 100}%`;
});

document.addEventListener("mouseup", () => {
  if (!isDragging) return;
  isDragging = false;
  splitHandle.classList.remove("dragging");

  const overlay = document.getElementById("drag-overlay")!;
  overlay.classList.add("hidden");
  document.getElementById("drag-label-left")!.classList.add("hidden");
  document.getElementById("drag-label-right")!.classList.add("hidden");

  const ratio = parseFloat(splitHandle.style.left) / 100;
  window.yo.splitDragEnd(ratio);
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
