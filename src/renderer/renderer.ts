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
      // Yo Workbench
      onWorkbenchOpen: (callback: (data: { content: string; label: string }) => void) => void;
      workbenchRefine: (instruction: string, content: string) => Promise<{ message: string; content: string; type: "skill" | "content" }>;
      suggestName: (content: string) => Promise<string>;
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

// Click edit icon -> open workbench with current context
contextPillEdit.addEventListener("click", async (e) => {
  e.stopPropagation();
  const name = currentContextFileName;
  const label = contextPillName.textContent || "Context";
  if (name) {
    const content = await window.yo.libraryRead(name);
    if (content) {
      openWorkbench(content, label);
      return;
    }
  }
  // Fallback: open workbench with empty content
  openWorkbench("", label);
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

// -- Yo Context Workbench --

const workbench = document.getElementById("yo-workbench")!;
const wbConversation = document.getElementById("wb-conversation")!;
const wbChatInput = document.getElementById("wb-chat-input") as HTMLTextAreaElement;
const wbSendBtn = document.getElementById("wb-send")!;
const wbLibraryList = document.getElementById("wb-library-list")!;
const wbSidebar = document.getElementById("wb-sidebar")!;
const wbSidebarToggle = document.getElementById("wb-sidebar-toggle")!;
const wbOutputPanel = document.getElementById("wb-output-panel")!;
const wbOutputRendered = document.getElementById("wb-output-rendered")!;
const wbOutputRaw = document.getElementById("wb-output-raw") as HTMLTextAreaElement;
const wbSearchModal = document.getElementById("wb-search-modal")!;
const wbSearchInput = document.getElementById("wb-search-input") as HTMLInputElement;
const wbSearchResults = document.getElementById("wb-search-results")!;
const wbSkillsList = document.getElementById("wb-skills-list")!;
const wbSkillInput = document.getElementById("wb-skill-input") as HTMLInputElement;
const wbSkillDropdown = document.getElementById("wb-skill-dropdown")!;
const wbSkillClear = document.getElementById("wb-skill-clear")!;

let wbContent = "";
let wbActiveSkill: string | null = null;  // currently selected skill name
let wbSkillNames: string[] = [];          // cached skill list
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
  clearSkillSelection();

  // Pre-fill the output panel title with a suggested name
  const fallback = label.replace(/\.md$/, "").replace(/^yo\s*/i, "") || "Output";
  wbOutputTitle.value = fallback;
  window.yo.suggestName(content).then((name) => {
    if (name && isWorkbenchOpen()) {
      wbOutputTitle.value = name;
    }
  });

  // Close any open overlays first
  if (isSupBrowserOpen()) closeSupBrowser();
  if (isHelpOpen()) closeHelp();

  window.yo.panelsHide();
  workbench.classList.remove("hidden");

  // Close panels by default
  wbSidebar.classList.remove("open");
  wbSidebar.style.width = "";
  wbSidebar.style.minWidth = "";
  wbSidebarToggle.classList.remove("active");
  wbDragLeft.classList.remove("visible");
  closeOutputPanel();

  // Welcome message
  const welcome = document.createElement("div");
  welcome.className = "wb-msg wb-msg-welcome";
  welcome.innerHTML =
    `<div class="wb-welcome-brand">Yo<span class="wb-welcome-dot">.</span> Sup<span class="wb-welcome-dot">.</span></div>` +
    `<div class="wb-welcome-text">Your content workspace. Create skills, refine artifacts, combine files — all from the prompt. Use a skill to transform content, or just ask.</div>`;
  wbConversation.appendChild(welcome);

  // Show captured content as first message (content block with expand)
  if (content) addMessage("content", "Captured", content);
  scrollConversation();

  loadWbLibrary();
  loadWbSkills();
  wbChatInput.focus();
}

function closeWorkbench() {
  workbench.classList.add("hidden");
  clearThinkingIntervals();
  closeOutputPanel();
  closeSearchModal();
  closeViewer();
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

function addMessage(type: "content" | "skill" | "user" | "yo" | "loading", label: string, content: string): HTMLElement {
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
  } else if (type === "content" || type === "skill") {
    const isSkill = type === "skill";
    msg.className = "wb-msg wb-msg-content-block";
    // Generate a display name from the label or first line of content
    const isYoResponse = label === "Yo" || label.startsWith("Yo:");
    let docName = label;
    if (label === "Captured" || label === "Yo" || label === "") {
      const firstLine = content.split("\n").find((l) => l.trim()) || "Untitled";
      docName = firstLine.replace(/^#+\s*/, "").slice(0, 60);
      if (docName.length === 60) docName += "...";
    }
    // Different icons: lightning bolt for skills, document for content
    const iconSvg = isSkill
      ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`
      : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>`;
    // Context button only for content, not skills
    const contextBtnHtml = isSkill ? "" :
      `<button class="wb-artifact-context" title="Set as context"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg></button>`;
    msg.innerHTML =
      `<div class="wb-msg-label">${escapeHtml(isYoResponse || label === "" ? "Yo" : label)}</div>` +
      `<div class="wb-artifact${isSkill ? " wb-artifact-skill" : ""}">` +
        `<div class="wb-artifact-header">` +
          `<span class="wb-artifact-chevron">\u25B6</span>` +
          `<span class="wb-artifact-icon">${iconSvg}</span>` +
          `<input class="wb-artifact-name-input" type="text" value="${escapeHtml(docName)}" spellcheck="false" autocomplete="off" />` +
          `<button class="wb-artifact-save" title="Save"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg></button>` +
          contextBtnHtml +
          `<button class="wb-artifact-open" title="Open in panel"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/></svg></button>` +
        `</div>` +
        `<div class="wb-artifact-body">${renderMarkdown(content)}</div>` +
      `</div>`;
    // Toggle expand on header click (skip if clicking buttons or input)
    const header = msg.querySelector(".wb-artifact-header")!;
    const artifact = msg.querySelector(".wb-artifact")!;
    const openBtn = msg.querySelector(".wb-artifact-open")!;
    const nameInput = msg.querySelector(".wb-artifact-name-input") as HTMLInputElement;
    const saveBtn = msg.querySelector(".wb-artifact-save")!;
    const contextBtn = msg.querySelector(".wb-artifact-context");
    header.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest(".wb-artifact-open") || target.closest(".wb-artifact-save") || target.closest(".wb-artifact-context") || target.closest(".wb-artifact-name-input")) return;
      artifact.classList.toggle("expanded");
    });
    // Stop clicks on input from bubbling
    nameInput.addEventListener("click", (e) => e.stopPropagation());
    openBtn.addEventListener("click", () => {
      if (isSkill) {
        openOutputPanel(content, nameInput.value.trim() || docName);
        wbOutputPanel.dataset.skillName = nameInput.value.trim() || docName;
        wbOutputContextBtn.classList.add("hidden");
      } else {
        openOutputPanel(content, nameInput.value.trim() || docName);
      }
    });
    // Save from artifact card
    saveBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const name = nameInput.value.trim();
      if (!name) { nameInput.focus(); return; }
      let ok: boolean;
      if (isSkill) {
        ok = await window.yo.skillsWrite(name, content);
        if (ok && wbSidebar.classList.contains("open")) loadWbSkills();
      } else {
        ok = await window.yo.libraryWrite(name, content);
        if (ok && wbSidebar.classList.contains("open")) loadWbLibrary();
      }
      if (ok) {
        (saveBtn as HTMLElement).style.color = "#25C75E";
        setTimeout(() => { (saveBtn as HTMLElement).style.color = ""; }, 1500);
      }
    });
    // Set as context — only for content, not skills
    if (contextBtn) {
      contextBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const name = nameInput.value.trim();
        if (!name) { nameInput.focus(); return; }
        await window.yo.libraryWrite(name, content);
        const ok = await window.yo.sessionLoadFile(name);
        if (ok) {
          navigator.clipboard.writeText(content);
          (contextBtn as HTMLElement).style.color = "#25C75E";
          setTimeout(() => { (contextBtn as HTMLElement).style.color = ""; }, 1500);
          if (wbSidebar.classList.contains("open")) loadWbLibrary();
        }
      });
    }
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
  return msg;
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

const wbDragLeft = document.getElementById("wb-drag-left")!;
const wbDragRight = document.getElementById("wb-drag-right")!;
const wbOutputTitle = document.getElementById("wb-output-title") as HTMLInputElement;
let wbOutputContent = "";  // raw content currently in the output panel

const wbOutputContextBtn = document.getElementById("wb-output-context")!;

async function openOutputPanel(content: string, title?: string) {
  delete wbOutputPanel.dataset.skillName;  // clear skill flag; callers set it explicitly if needed
  wbOutputContextBtn.classList.remove("hidden");  // show context button by default (hidden for skills by callers)
  wbOutputContent = content;
  wbOutputRendered.innerHTML = renderMarkdown(content);
  wbOutputRaw.value = content;
  wbOutputRendered.classList.add("hidden");
  wbOutputRaw.classList.remove("hidden");
  wbOutputTitle.value = title || "Output";
  // Default to Raw tab
  wbOutputPanel.querySelectorAll(".wb-output-tab").forEach((t) => {
    t.classList.toggle("active", (t as HTMLElement).dataset.mode === "raw");
  });
  // Restore persisted width
  const savedW = await window.yo.getPreference("wbOutputWidth") as number | undefined;
  if (savedW && savedW >= 200) {
    wbOutputPanel.style.width = savedW + "px";
    wbOutputPanel.style.minWidth = savedW + "px";
  }
  wbOutputPanel.classList.add("open");
  wbDragRight.classList.add("visible");
}

function closeOutputPanel() {
  wbOutputPanel.classList.remove("open");
  wbOutputPanel.style.width = "";
  wbOutputPanel.style.minWidth = "";
  wbDragRight.classList.remove("visible");
}

document.getElementById("wb-output-close")!.addEventListener("click", closeOutputPanel);

// Download
document.getElementById("wb-output-download")!.addEventListener("click", () => {
  const text = wbOutputContent;
  const name = (wbOutputTitle.value || "output").replace(/[^a-zA-Z0-9_\- ]/g, "").trim() || "output";
  const blob = new Blob([text], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name + ".md";
  a.click();
  URL.revokeObjectURL(url);
});

// Save (output panel) — saves as library file or skill depending on context
document.getElementById("wb-output-save")!.addEventListener("click", async () => {
  const name = wbOutputTitle.value.trim();
  if (!name) { wbOutputTitle.focus(); return; }
  const isSkill = wbOutputPanel.dataset.skillName !== undefined;
  let ok: boolean;
  if (isSkill) {
    ok = await window.yo.skillsWrite(name, wbOutputContent);
    if (ok && wbSidebar.classList.contains("open")) loadWbSkills();
  } else {
    ok = await window.yo.libraryWrite(name, wbOutputContent);
    if (ok && wbSidebar.classList.contains("open")) loadWbLibrary();
  }
  if (ok) {
    const btn = document.getElementById("wb-output-save")!;
    btn.style.color = "#25C75E";
    setTimeout(() => { btn.style.color = ""; }, 1500);
    // Refresh skill names for the dropdown
    if (isSkill) wbSkillNames = await window.yo.skillsList();
  }
});

// Set as context (output panel)
document.getElementById("wb-output-context")!.addEventListener("click", async () => {
  const name = wbOutputTitle.value.trim();
  if (!name) { wbOutputTitle.focus(); return; }
  await window.yo.libraryWrite(name, wbOutputContent);
  const ok = await window.yo.sessionLoadFile(name);
  if (ok) {
    // Also copy to clipboard
    navigator.clipboard.writeText(wbOutputContent);
    const btn = document.getElementById("wb-output-context")!;
    btn.style.color = "#25C75E";
    setTimeout(() => { btn.style.color = ""; }, 1500);
    if (wbSidebar.classList.contains("open")) loadWbLibrary();
  }
});

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

// Sync raw edits back to both wbOutputContent and wbContent
wbOutputRaw.addEventListener("input", () => {
  wbOutputContent = wbOutputRaw.value;
  wbContent = wbOutputRaw.value;
  // Live-update rendered markdown
  wbOutputRendered.innerHTML = renderMarkdown(wbOutputRaw.value);
});

// -- Left sidebar toggle --

async function toggleSidebar() {
  const isOpen = wbSidebar.classList.toggle("open");
  wbSidebarToggle.classList.toggle("active", isOpen);
  wbDragLeft.classList.toggle("visible", isOpen);
  if (isOpen) {
    // Restore persisted width
    const savedW = await window.yo.getPreference("wbSidebarWidth") as number | undefined;
    if (savedW && savedW >= 120) {
      wbSidebar.style.width = savedW + "px";
      wbSidebar.style.minWidth = savedW + "px";
    }
    loadWbLibrary();
    loadWbSkills();
  } else {
    wbSidebar.style.width = "";
    wbSidebar.style.minWidth = "";
  }
}

wbSidebarToggle.addEventListener("click", toggleSidebar);

// -- Panel drag resize --

let wbDragTarget: "left" | "right" | null = null;

function startWbDrag(e: MouseEvent, target: "left" | "right") {
  e.preventDefault();
  wbDragTarget = target;
  const handle = target === "left" ? wbDragLeft : wbDragRight;
  handle.classList.add("dragging");
  // Disable transitions during drag
  wbSidebar.classList.add("no-transition");
  wbOutputPanel.classList.add("no-transition");
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
}

wbDragLeft.addEventListener("mousedown", (e) => startWbDrag(e, "left"));
wbDragRight.addEventListener("mousedown", (e) => startWbDrag(e, "right"));

document.addEventListener("mousemove", (e) => {
  if (!wbDragTarget) return;
  const body = workbench.querySelector(".wb-body") as HTMLElement;
  if (!body) return;
  const bodyRect = body.getBoundingClientRect();

  if (wbDragTarget === "left") {
    const newWidth = Math.max(120, Math.min(500, e.clientX - bodyRect.left));
    wbSidebar.style.width = newWidth + "px";
    wbSidebar.style.minWidth = newWidth + "px";
  } else {
    const newWidth = Math.max(200, Math.min(700, bodyRect.right - e.clientX));
    wbOutputPanel.style.width = newWidth + "px";
    wbOutputPanel.style.minWidth = newWidth + "px";
  }
});

document.addEventListener("mouseup", () => {
  if (!wbDragTarget) return;
  const handle = wbDragTarget === "left" ? wbDragLeft : wbDragRight;
  handle.classList.remove("dragging");
  wbSidebar.classList.remove("no-transition");
  wbOutputPanel.classList.remove("no-transition");
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
  // Persist panel widths
  const sidebarW = wbSidebar.offsetWidth;
  const outputW = wbOutputPanel.offsetWidth;
  if (wbDragTarget === "left" && sidebarW > 0) {
    window.yo.setPreference("wbSidebarWidth", sidebarW);
  } else if (wbDragTarget === "right" && outputW > 0) {
    window.yo.setPreference("wbOutputWidth", outputW);
  }
  wbDragTarget = null;
});

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
        wbOutputTitle.value = name;
        addMessage("content", `Loaded: ${name}.md`, content);
        scrollConversation();
      }
      closeSearchModal();
    });
  });
}

// Listen for workbench open from main process
window.yo.onWorkbenchOpen((data) => openWorkbench(data.content, data.label));

// Listen for sup browser open from terminal
window.yo.onOpenSupBrowser(() => openSupBrowser());

// Close
document.getElementById("wb-close")!.addEventListener("click", closeWorkbench);

// Auto-grow chat input
wbChatInput.addEventListener("input", () => {
  wbChatInput.style.height = "auto";
  wbChatInput.style.height = Math.min(wbChatInput.scrollHeight, 200) + "px";
});

// Send refinement
async function sendRefinement() {
  const instruction = wbActiveSkill || wbChatInput.value.trim();
  if (!instruction) return;

  const displayLabel = wbActiveSkill ? `skill: ${wbActiveSkill}` : instruction;
  addMessage("user", "You", displayLabel);
  wbChatInput.value = "";
  wbChatInput.style.height = "auto";
  wbChatInput.disabled = true;
  wbSendBtn.setAttribute("disabled", "");
  addMessage("loading", "Yo", "");
  scrollConversation();

  try {
    const result = await window.yo.workbenchRefine(instruction, wbContent);
    removeLoading();
    // Show Yo's conversational message (if any) as a chat bubble
    if (result.message) {
      addMessage("yo", "Yo", result.message);
    }
    // Show as the correct card type — skill or content
    const cardType = result.type === "skill" ? "skill" : "content";
    wbContent = result.content;
    const contentMsg = addMessage(cardType, "", result.content);
    scrollConversation();
    // Auto-suggest a name for the generated item
    window.yo.suggestName(result.content).then((suggested) => {
      if (suggested && isWorkbenchOpen()) {
        const nameInput = contentMsg.querySelector(".wb-artifact-name-input") as HTMLInputElement | null;
        if (nameInput) nameInput.value = suggested;
        wbOutputTitle.value = suggested;
      }
    });
    // Refresh sidebar lists so new skills/content show up
    if (wbSidebar.classList.contains("open")) {
      if (cardType === "skill") loadWbSkills();
      else loadWbLibrary();
    }
  } catch (err) {
    removeLoading();
    addMessage("yo", "Yo", `Error: ${err instanceof Error ? err.message : err}`);
    scrollConversation();
  }

  wbChatInput.disabled = false;
  wbSendBtn.removeAttribute("disabled");
  clearSkillSelection();
  wbChatInput.focus();
}

wbChatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendRefinement();
  }
});

wbSendBtn.addEventListener("click", sendRefinement);

// -- Workbench viewer modal --

const wbViewerModal = document.getElementById("wb-viewer-modal")!;
const wbViewerName = document.getElementById("wb-viewer-name")!;
const wbViewerContent = document.getElementById("wb-viewer-content")!;

function openViewer(name: string, content: string) {
  wbViewerName.textContent = name + ".md";
  wbViewerContent.textContent = content || "(empty)";
  wbViewerModal.dataset.name = name;
  wbViewerModal.classList.remove("hidden");
}

function closeViewer() {
  wbViewerModal.classList.add("hidden");
}

document.getElementById("wb-viewer-close")!.addEventListener("click", closeViewer);
document.getElementById("wb-viewer-add")!.addEventListener("click", async () => {
  const name = wbViewerModal.dataset.name;
  if (!name) return;
  const content = await window.yo.libraryRead(name);
  if (content !== null) {
    wbContent = content;
    wbOutputTitle.value = name;
    addMessage("content", `Loaded: ${name}.md`, content);
    scrollConversation();
  }
  closeViewer();
});
wbViewerModal.addEventListener("click", (e) => {
  if (e.target === wbViewerModal) closeViewer();
});

// -- Sidebar filter --

const wbFilterInput = document.getElementById("wb-filter-input") as HTMLInputElement;
let wbAllFiles: string[] = [];

wbFilterInput.addEventListener("input", () => {
  const q = wbFilterInput.value.trim().toLowerCase();
  const filtered = q ? wbAllMeta.filter((f) => f.name.toLowerCase().includes(q)) : wbAllMeta;
  renderWbLibrary(filtered);
});

// Library sidebar file list
interface FileMeta { name: string; modified: number; size: number }
let wbAllMeta: FileMeta[] = [];

function formatRelativeDate(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function loadWbLibrary() {
  wbAllMeta = await window.yo.libraryListMeta();
  wbAllFiles = wbAllMeta.map((f) => f.name);
  const q = wbFilterInput.value.trim().toLowerCase();
  const filtered = q ? wbAllMeta.filter((f) => f.name.toLowerCase().includes(q)) : wbAllMeta;
  renderWbLibrary(filtered);
}

function renderWbLibrary(files: FileMeta[]) {
  if (files.length === 0) {
    wbLibraryList.innerHTML = '<div style="padding:12px 14px;color:#555;font-size:12px;">No files</div>';
    return;
  }

  wbLibraryList.innerHTML = files.map((f) => `
    <div class="wb-file-item" data-name="${f.name}">
      <div class="wb-file-top">
        <span class="wb-file-name" title="${f.name}.md">${f.name}.md</span>
        <div class="wb-file-actions">
          <button class="wb-file-action wb-act-view" title="View">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
          <button class="wb-file-action wb-act-add" title="Add to context">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
          </button>
          <button class="wb-file-action wb-act-del danger" title="Delete">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/></svg>
          </button>
        </div>
      </div>
      <div class="wb-file-meta">
        <span class="wb-file-date">${formatRelativeDate(f.modified)}</span>
        <span class="wb-file-size">${formatSize(f.size)}</span>
      </div>
    </div>`).join("");

  wbLibraryList.querySelectorAll(".wb-file-item[data-name]").forEach((el) => {
    const name = (el as HTMLElement).dataset.name!;

    el.querySelector(".wb-act-view")!.addEventListener("click", async (e) => {
      e.stopPropagation();
      const content = await window.yo.libraryRead(name);
      if (content !== null) openViewer(name, content);
    });

    el.querySelector(".wb-act-add")!.addEventListener("click", async (e) => {
      e.stopPropagation();
      const content = await window.yo.libraryRead(name);
      if (content !== null) {
        wbContent = content;
        wbOutputTitle.value = name;
        wbLibraryList.querySelectorAll(".wb-file-item").forEach((f) => f.classList.remove("active"));
        el.classList.add("active");
        addMessage("content", `Loaded: ${name}.md`, content);
        scrollConversation();
      }
    });

    el.querySelector(".wb-act-del")!.addEventListener("click", async (e) => {
      e.stopPropagation();
      const ok = await window.yo.libraryRemove(name);
      if (ok) loadWbLibrary();
    });

    // Click row -> open in right panel editor
    el.addEventListener("click", async () => {
      const content = await window.yo.libraryRead(name);
      if (content !== null) {
        openOutputPanel(content, name);
      }
    });
  });
}

// -- Skills list in sidebar --

async function loadWbSkills() {
  const skills = await window.yo.skillsList();
  wbSkillNames = skills;
  if (skills.length === 0) {
    wbSkillsList.innerHTML = '<div style="padding:8px 14px;color:#888;font-size:11px;">No skills yet</div>';
    return;
  }

  wbSkillsList.innerHTML = skills.map((name) => `
    <div class="wb-file-item" data-name="${name}">
      <div class="wb-file-top">
        <span class="wb-file-name" title="${name}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#25C75E" stroke-width="2" style="vertical-align:-1px;margin-right:4px;flex-shrink:0;"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>${name}
        </span>
        <div class="wb-file-actions">
          <button class="wb-file-action wb-act-view" title="View">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
          <button class="wb-file-action wb-act-use" title="Use skill on content">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          </button>
          <button class="wb-file-action wb-act-del danger" title="Delete">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/></svg>
          </button>
        </div>
      </div>
    </div>`).join("");

  wbSkillsList.querySelectorAll(".wb-file-item[data-name]").forEach((el) => {
    const name = (el as HTMLElement).dataset.name!;

    // View — opens skill prompt in the viewer modal
    el.querySelector(".wb-act-view")!.addEventListener("click", async (e) => {
      e.stopPropagation();
      const content = await window.yo.skillsRead(name);
      if (content !== null) openViewer(name, content);
    });

    // Use — select skill in the dropdown to run on current content
    el.querySelector(".wb-act-use")!.addEventListener("click", (e) => {
      e.stopPropagation();
      selectSkill(name);
      wbChatInput.focus();
    });

    // Delete
    el.querySelector(".wb-act-del")!.addEventListener("click", async (e) => {
      e.stopPropagation();
      const ok = await window.yo.skillsRemove(name);
      if (ok) {
        loadWbSkills();
        if (wbActiveSkill === name) clearSkillSelection();
      }
    });

    // Click row -> open in right panel editor
    el.addEventListener("click", async () => {
      const content = await window.yo.skillsRead(name);
      if (content !== null) {
        delete wbOutputPanel.dataset.skillName;
        openOutputPanel(content, name);
        wbOutputPanel.dataset.skillName = name;
        wbOutputContextBtn.classList.add("hidden");
      }
    });
  });
}

// -- Skill dropdown in chat input --

function selectSkill(name: string) {
  wbActiveSkill = name;
  wbSkillInput.value = name;
  wbSkillInput.classList.add("active");
  wbSkillClear.classList.remove("hidden");
  wbChatInput.classList.add("skill-active");
  wbChatInput.placeholder = `Will run skill "${name}" on current content`;
  wbSkillDropdown.classList.add("hidden");
}

function clearSkillSelection() {
  wbActiveSkill = null;
  wbSkillInput.value = "";
  wbSkillInput.classList.remove("active");
  wbSkillClear.classList.add("hidden");
  wbChatInput.classList.remove("skill-active");
  wbChatInput.placeholder = "Ask Yo to refine this content...";
  wbSkillDropdown.classList.add("hidden");
}

function renderSkillDropdown(filter: string) {
  const q = filter.toLowerCase();
  const matches = q ? wbSkillNames.filter((s) => s.toLowerCase().includes(q)) : wbSkillNames;
  if (matches.length === 0) {
    wbSkillDropdown.classList.add("hidden");
    return;
  }
  wbSkillDropdown.innerHTML = matches.map((name) =>
    `<div class="wb-skill-option" data-name="${name}">${name}</div>`
  ).join("");
  wbSkillDropdown.classList.remove("hidden");

  wbSkillDropdown.querySelectorAll(".wb-skill-option").forEach((opt) => {
    opt.addEventListener("mousedown", (e) => {
      e.preventDefault();  // prevent blur
      selectSkill((opt as HTMLElement).dataset.name!);
    });
  });
}

wbSkillInput.addEventListener("focus", () => {
  if (!wbActiveSkill) renderSkillDropdown(wbSkillInput.value);
});

wbSkillInput.addEventListener("input", () => {
  if (wbActiveSkill) clearSkillSelection();
  renderSkillDropdown(wbSkillInput.value);
});

wbSkillInput.addEventListener("blur", () => {
  setTimeout(() => wbSkillDropdown.classList.add("hidden"), 150);
});

wbSkillInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    wbSkillDropdown.classList.add("hidden");
    wbSkillInput.blur();
  } else if (e.key === "Enter") {
    e.preventDefault();
    const firstOpt = wbSkillDropdown.querySelector(".wb-skill-option") as HTMLElement | null;
    if (firstOpt) selectSkill(firstOpt.dataset.name!);
    else if (wbActiveSkill) sendRefinement();
  }
});

wbSkillClear.addEventListener("click", () => {
  clearSkillSelection();
  wbSkillInput.focus();
});

// -- Global keyboard shortcuts --

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!wbViewerModal.classList.contains("hidden")) closeViewer();
    else if (isWorkbenchOpen()) closeWorkbench();
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
