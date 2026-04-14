/**
 * Renderer — titlebar + grid handles + boot gate + sup browser + yo workbench.
 *
 * All user commands (yo/sup/dip/wassup) happen inside app panels
 * via the interceptor, or from the command bar. The renderer
 * manages window chrome, session state display, and the yo workbench.
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
      // Yo Workbench
      onWorkbenchOpen: (callback: (data: { content: string; label: string }) => void) => void;
      workbenchRefine: (instruction: string, content: string) => Promise<string>;
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

function updateContextPill(info: { hasContent: boolean; label: string }) {
  if (info.hasContent && info.label) {
    contextPill.textContent = info.label;
    contextPill.classList.remove("hidden");
  } else {
    contextPill.classList.add("hidden");
  }
}

window.yo.onSessionChanged(updateContextPill);

// Click pill -> open sup browser
contextPill.addEventListener("click", () => {
  openSupBrowser();
});

// Load initial state
window.yo.sessionInfo().then(updateContextPill);

// -- Command input --

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

// Cmd+K from panel -> focus command input
window.yo.onFocusInput(() => commandInput.focus());

// -- Sup browser (library file picker) --

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

// Click overlay background -> close
supBrowser.addEventListener("click", (e) => {
  if (e.target === supBrowser) closeSupBrowser();
});

// -- Yo Context Workbench --

const workbench = document.getElementById("yo-workbench")!;
const wbConversation = document.getElementById("wb-conversation")!;
const wbChatInput = document.getElementById("wb-chat-input") as HTMLTextAreaElement;
const wbSendBtn = document.getElementById("wb-send")!;
const wbLibraryList = document.getElementById("wb-library-list")!;
const wbSaveName = document.getElementById("wb-save-name") as HTMLInputElement;
const wbSidebar = document.getElementById("wb-sidebar")!;
const wbSidebarToggle = document.getElementById("wb-sidebar-toggle")!;
const wbOutputPanel = document.getElementById("wb-output-panel")!;
const wbOutputRendered = document.getElementById("wb-output-rendered")!;
const wbOutputRaw = document.getElementById("wb-output-raw") as HTMLTextAreaElement;
const wbSearchModal = document.getElementById("wb-search-modal")!;
const wbSearchInput = document.getElementById("wb-search-input") as HTMLInputElement;
const wbSearchResults = document.getElementById("wb-search-results")!;

let wbContent = "";
let wbThinkingBrailleIv: ReturnType<typeof setInterval> | null = null;
let wbThinkingWordIv: ReturnType<typeof setInterval> | null = null;

const WB_LOADING_WORDS = [
  "chilling...", "vibing...", "supping...", "cooking...",
  "thinking...", "brewing...", "manifesting...", "marinating...",
];
const WB_BRAILLE_FRAMES = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827"];

function openWorkbench(content: string, label: string) {
  wbContent = content;
  wbConversation.innerHTML = "";
  wbChatInput.value = "";
  wbSaveName.value = label.replace(/\.md$/, "").replace(/^yo\s*/i, "") || "";

  // Close any open overlays first
  if (isSupBrowserOpen()) closeSupBrowser();
  if (isHelpOpen()) closeHelp();

  window.yo.panelsHide();
  workbench.classList.remove("hidden");

  // Close panels by default
  wbSidebar.classList.remove("open");
  wbSidebarToggle.classList.remove("active");
  closeOutputPanel();

  // Show captured content as first message (content block with expand)
  addMessage("content", "Captured", content);
  scrollConversation();

  loadWbLibrary();
  wbChatInput.focus();
}

function closeWorkbench() {
  workbench.classList.add("hidden");
  clearThinkingIntervals();
  closeOutputPanel();
  closeSearchModal();
  window.yo.panelsShow();
}

function isWorkbenchOpen(): boolean {
  return !workbench.classList.contains("hidden");
}

// Minimal markdown to HTML
function renderMarkdown(md: string): string {
  return md
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/^(\d+)\. (.+)$/gm, "<li>$2</li>")
    .replace(/\n\n/g, "<br><br>");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function addMessage(type: "content" | "user" | "yo" | "loading", label: string, content: string) {
  const msg = document.createElement("div");

  if (type === "user") {
    msg.className = "wb-msg wb-msg-user";
    msg.innerHTML =
      `<div class="wb-msg-label">${escapeHtml(label)}</div>` +
      `<div class="wb-msg-bubble">${escapeHtml(content)}</div>`;
  } else if (type === "yo") {
    msg.className = "wb-msg wb-msg-yo";
    msg.innerHTML =
      `<div class="wb-msg-label">${escapeHtml(label)}</div>` +
      `<div class="wb-msg-text">${renderMarkdown(content)}</div>`;
  } else if (type === "content") {
    msg.className = "wb-msg wb-msg-content-block";
    const preview = content.split("\n").slice(0, 6).join("\n");
    const isYoResponse = label === "Yo" || label.startsWith("Yo:");
    const btnText = isYoResponse ? "View updated content" : "View full content";
    msg.innerHTML =
      `<div class="wb-msg-label">${escapeHtml(label)}</div>` +
      `<div class="wb-content-preview">${escapeHtml(preview)}</div>` +
      `<button class="wb-expand-btn">\u25B6 ${btnText}</button>`;
    const expandBtn = msg.querySelector(".wb-expand-btn")!;
    expandBtn.addEventListener("click", () => openOutputPanel(content));
  } else if (type === "loading") {
    msg.className = "wb-msg wb-msg-yo wb-msg-loading";
    const word = WB_LOADING_WORDS[Math.floor(Math.random() * WB_LOADING_WORDS.length)];
    msg.innerHTML =
      `<div class="wb-msg-label">Yo</div>` +
      `<div class="wb-thinking">` +
      `<span class="wb-braille">${WB_BRAILLE_FRAMES[0]}</span>` +
      `<span class="wb-word">${word}</span>` +
      `</div>`;
    startThinkingAnimation(msg);
  }

  wbConversation.appendChild(msg);
}

function startThinkingAnimation(msgEl: HTMLElement) {
  clearThinkingIntervals();
  const brailleEl = msgEl.querySelector(".wb-braille");
  const wordEl = msgEl.querySelector(".wb-word");
  if (!brailleEl || !wordEl) return;

  let fi = 0;
  wbThinkingBrailleIv = setInterval(() => {
    fi++;
    brailleEl.textContent = WB_BRAILLE_FRAMES[fi % WB_BRAILLE_FRAMES.length];
  }, 100);

  wbThinkingWordIv = setInterval(() => {
    wordEl.classList.add("wiping");
    setTimeout(() => {
      const newWord = WB_LOADING_WORDS[Math.floor(Math.random() * WB_LOADING_WORDS.length)];
      wordEl.textContent = newWord;
      wordEl.classList.remove("wiping");
    }, 400);
  }, 3000);
}

function clearThinkingIntervals() {
  if (wbThinkingBrailleIv) { clearInterval(wbThinkingBrailleIv); wbThinkingBrailleIv = null; }
  if (wbThinkingWordIv) { clearInterval(wbThinkingWordIv); wbThinkingWordIv = null; }
}

function removeLoading() {
  clearThinkingIntervals();
  const loading = wbConversation.querySelector(".wb-msg-loading");
  if (loading) loading.remove();
}

function scrollConversation() {
  wbConversation.scrollTop = wbConversation.scrollHeight;
}

// -- Right output panel --

function openOutputPanel(content: string) {
  wbOutputRendered.innerHTML = renderMarkdown(content);
  wbOutputRaw.value = content;
  wbOutputRendered.classList.remove("hidden");
  wbOutputRaw.classList.add("hidden");
  // Reset tab state
  wbOutputPanel.querySelectorAll(".wb-output-tab").forEach((t) => {
    t.classList.toggle("active", (t as HTMLElement).dataset.mode === "markdown");
  });
  wbOutputPanel.classList.add("open");
}

function closeOutputPanel() {
  wbOutputPanel.classList.remove("open");
}

document.getElementById("wb-output-close")!.addEventListener("click", closeOutputPanel);

// Tab toggle (markdown/raw)
wbOutputPanel.querySelectorAll(".wb-output-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const mode = (tab as HTMLElement).dataset.mode;
    wbOutputPanel.querySelectorAll(".wb-output-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    if (mode === "raw") {
      wbOutputRendered.classList.add("hidden");
      wbOutputRaw.classList.remove("hidden");
    } else {
      wbOutputRendered.classList.remove("hidden");
      wbOutputRaw.classList.add("hidden");
    }
  });
});

// Sync raw edits back to wbContent
wbOutputRaw.addEventListener("input", () => {
  wbContent = wbOutputRaw.value;
});

// -- Left sidebar toggle --

function toggleSidebar() {
  const isOpen = wbSidebar.classList.toggle("open");
  wbSidebarToggle.classList.toggle("active", isOpen);
  if (isOpen) loadWbLibrary();
}

wbSidebarToggle.addEventListener("click", toggleSidebar);

// -- Search modal --

let wbSearchTimer2: ReturnType<typeof setTimeout> | null = null;

function openSearchModal() {
  wbSearchModal.classList.remove("hidden");
  wbSearchInput.value = "";
  wbSearchResults.innerHTML = '<div class="wb-search-empty">Type to search across all saved files...</div>';
  wbSearchInput.focus();
}

function closeSearchModal() {
  wbSearchModal.classList.add("hidden");
  if (wbSearchTimer2) { clearTimeout(wbSearchTimer2); wbSearchTimer2 = null; }
}

document.getElementById("wb-search-btn")!.addEventListener("click", openSearchModal);
document.getElementById("wb-search-close")!.addEventListener("click", closeSearchModal);

// Click backdrop to close
wbSearchModal.addEventListener("click", (e) => {
  if (e.target === wbSearchModal) closeSearchModal();
});

wbSearchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeSearchModal();
});

wbSearchInput.addEventListener("input", () => {
  if (wbSearchTimer2) clearTimeout(wbSearchTimer2);
  const q = wbSearchInput.value.trim();

  if (!q) {
    wbSearchResults.innerHTML = '<div class="wb-search-empty">Type to search across all saved files...</div>';
    return;
  }

  // Instant local name filter
  window.yo.libraryList().then((all) => {
    const lower = q.toLowerCase();
    const filtered = all.filter((f) => f.toLowerCase().includes(lower));
    if (filtered.length > 0) renderSearchResults(filtered);
  });

  // AI search after debounce
  wbSearchTimer2 = setTimeout(async () => {
    const results = await window.yo.librarySearchAi(q);
    if (results.length > 0 && wbSearchInput.value.trim() === q) {
      renderSearchResults(results);
    }
  }, 600);
});

function renderSearchResults(files: string[]) {
  if (files.length === 0) {
    wbSearchResults.innerHTML = '<div class="wb-search-empty">No results found</div>';
    return;
  }
  wbSearchResults.innerHTML = files.map((name) =>
    `<div class="wb-search-result" data-name="${name}">${name}.md</div>`
  ).join("");

  wbSearchResults.querySelectorAll(".wb-search-result").forEach((el) => {
    el.addEventListener("click", async () => {
      const name = (el as HTMLElement).dataset.name!;
      const content = await window.yo.libraryRead(name);
      if (content !== null) {
        wbContent = content;
        wbSaveName.value = name;
        addMessage("content", `Loaded: ${name}.md`, content);
        scrollConversation();
      }
      closeSearchModal();
    });
  });
}

// Listen for workbench open from main process
window.yo.onWorkbenchOpen((data) => openWorkbench(data.content, data.label));

// Close
document.getElementById("wb-close")!.addEventListener("click", closeWorkbench);

// Copy
document.getElementById("wb-copy")!.addEventListener("click", () => {
  navigator.clipboard.writeText(wbContent);
  const btn = document.getElementById("wb-copy")!;
  btn.textContent = "Copied!";
  setTimeout(() => { btn.textContent = "Copy"; }, 1500);
});

// Save
document.getElementById("wb-save")!.addEventListener("click", async () => {
  const name = wbSaveName.value.trim();
  if (!name) { wbSaveName.focus(); return; }
  const ok = await window.yo.libraryWrite(name, wbContent);
  if (ok) {
    const btn = document.getElementById("wb-save")!;
    btn.textContent = "Saved!";
    setTimeout(() => { btn.textContent = "Save"; }, 1500);
    if (wbSidebar.classList.contains("open")) loadWbLibrary();
  }
});

// Auto-grow chat input
wbChatInput.addEventListener("input", () => {
  wbChatInput.style.height = "auto";
  wbChatInput.style.height = Math.min(wbChatInput.scrollHeight, 200) + "px";
});

// Send refinement
async function sendRefinement() {
  const instruction = wbChatInput.value.trim();
  if (!instruction) return;

  addMessage("user", "You", instruction);
  wbChatInput.value = "";
  wbChatInput.style.height = "auto";
  wbChatInput.disabled = true;
  wbSendBtn.setAttribute("disabled", "");
  addMessage("loading", "Yo", "");
  scrollConversation();

  try {
    const refined = await window.yo.workbenchRefine(instruction, wbContent);
    removeLoading();
    wbContent = refined;
    addMessage("content", "Yo", refined);
    scrollConversation();
  } catch (err) {
    removeLoading();
    addMessage("yo", "Yo", `Error: ${err instanceof Error ? err.message : err}`);
    scrollConversation();
  }

  wbChatInput.disabled = false;
  wbSendBtn.removeAttribute("disabled");
  wbChatInput.focus();
}

wbChatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendRefinement();
  }
});

wbSendBtn.addEventListener("click", sendRefinement);

// Library sidebar file list
async function loadWbLibrary() {
  const files = await window.yo.libraryList();
  wbLibraryList.innerHTML = files.length === 0
    ? '<div class="wb-file-item" style="color:#555;cursor:default;">No files yet</div>'
    : files.map((name) =>
        `<div class="wb-file-item" data-name="${name}">${name}.md</div>`
      ).join("");

  wbLibraryList.querySelectorAll(".wb-file-item[data-name]").forEach((el) => {
    el.addEventListener("click", async () => {
      const name = (el as HTMLElement).dataset.name!;
      const content = await window.yo.libraryRead(name);
      if (content !== null) {
        wbContent = content;
        wbSaveName.value = name;
        wbLibraryList.querySelectorAll(".wb-file-item").forEach((f) => f.classList.remove("active"));
        el.classList.add("active");
        addMessage("content", `Loaded: ${name}.md`, content);
        scrollConversation();
      }
    });
  });
}

// -- Global keyboard shortcuts --

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (isWorkbenchOpen()) closeWorkbench();
    else if (isSupBrowserOpen()) closeSupBrowser();
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

// -- Boot gate --

window.yo.onBoot((data) => {
  if (data.needsOnboarding) {
    showOnboarding(data.license.daysRemaining);
  } else if (!data.hideWelcome) {
    openHelp();
  }
});
