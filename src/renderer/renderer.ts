/**
 * Renderer — titlebar + grid handles + boot gate.
 *
 * All user commands (yo/dip/drip) happen inside app panels
 * via the interceptor, or from the command bar. The renderer
 * manages window chrome and session state display.
 */

// Help overlay moved to yo://home app
import { showOnboarding } from "./onboarding.js";

type TabInfo = { id: string; name: string; favicon?: string; layoutFavicons?: string[]; pinned?: boolean };

declare global {
  interface Window {
    yo: {
      copyToClipboard: (text: string) => void;
      windowClose: () => void;
      windowMinimize: () => void;
      windowMaximize: () => void;
      panelsHide: () => void;
      panelsShow: () => void;
      cmdPaletteOpen: () => void;
      capturePanels: () => Promise<Array<{ dataUrl: string; bounds: { x: number; y: number; width: number; height: number } }>>;
      panelsRefresh: (id?: string) => void;
      panelsZoom: (factor: number) => void;
      panelsGetZoom: () => Promise<number>;
      // Skills
      skillsList: () => Promise<string[]>;
      skillsListDetailed: () => Promise<Array<{ name: string; description?: string; hasRunner: boolean; scheduled: boolean; scheduleExpr?: string }>>;
      skillsRead: (name: string) => Promise<string | null>;
      skillsGet: (name: string) => Promise<{ name: string; manifest: any; prompt: string; hasRunner: boolean; runnerCode: string | null } | null>;
      skillsWrite: (name: string, prompt: string) => Promise<boolean | { error: string }>;
      skillsWriteFull: (name: string, manifest: any, prompt: string, runnerCode?: string | null) => Promise<boolean | { error: string }>;
      skillsRemove: (name: string) => Promise<boolean>;
      skillsGenerate: (name: string, description: string) => Promise<string>;
      skillsListFiles: (name: string) => Promise<string[]>;
      skillsReadFile: (name: string, rel: string) => Promise<string | null>;
      skillsWriteFile: (name: string, rel: string, content: string) => Promise<boolean>;
      skillsDeleteFile: (name: string, rel: string) => Promise<boolean>;
      skillsRun: (name: string, input: unknown) => Promise<{ ok: true; output: unknown } | { ok: false; error: string }>;
      skillsCancel: (runId: string) => Promise<boolean>;
      skillsUserResponse: (qid: string, answer: string) => Promise<boolean>;
      skillsRunHistory: (name: string) => Promise<any[]>;
      skillsExport: (name: string) => Promise<string | null>;
      skillsImport: (base64: string, overwrite?: boolean) => Promise<{ imported: string[]; skipped: string[]; error?: string }>;
      skillsScheduleStatus: () => Promise<Array<{ name: string; schedule: string; paused: boolean }>>;
      skillsPauseSchedule: (name: string) => Promise<void>;
      skillsResumeSchedule: (name: string) => Promise<void>;
      onSkillProgress: (cb: (data: { runId: string; event: any }) => void) => void;
      onSkillAskUser: (cb: (data: { runId: string; qid: string; question: string }) => void) => void;
      // Apps
      appsList: () => Promise<Array<{
        id: string; name: string; url?: string; connected: boolean; connectedSlug?: string;
        forceWeb?: boolean; doNotRecord?: boolean;
        commands: Record<string, { selector: string; action: string; description: string }>;
        meta?: { description: string; capabilities: string[] };
        connection?: { pipedreamSlug: string; accountId?: string; healthy?: boolean };
        mcp?: { transport: "stdio" | "sse" | "streamable-http"; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string>; enabled: boolean };
      }>>;
      appsAdd: (id: string, name: string, url?: string) => Promise<unknown>;
      appsSetMcp: (id: string, mcp: { transport: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string; enabled: boolean }) => Promise<unknown>;
      appsRemoveMcp: (id: string) => Promise<boolean>;
      appsRemove: (id: string) => Promise<boolean>;
      appsSetConnection: (id: string, pipedreamSlug: string) => Promise<boolean>;
      appsRemoveConnection: (id: string) => Promise<boolean>;
      appsUpdateId: (oldId: string, newId: string) => Promise<boolean>;
      appsUpdateName: (id: string, name: string) => Promise<boolean>;
      appsUpdateUrl: (id: string, url: string) => Promise<boolean>;
      appsUpdateForceWeb: (id: string, forceWeb: boolean) => Promise<boolean>;
      appsUpdateDoNotRecord: (id: string, doNotRecord: boolean) => Promise<boolean>;
      appsUpdateCapturePolicy: (id: string, policy: { type: string; maxVersions?: number; windowHours?: number; minDeltaChars?: number }) => Promise<boolean>;
      appsGetCapturePolicy: (id: string) => Promise<{ type: string; maxVersions?: number; windowHours?: number; minDeltaChars?: number }>;
      appsSetConnectedSlug: (id: string, slug: string | null) => Promise<boolean>;
      appsSetCommand: (id: string, key: string, mapping: { selector: string; action: string; description: string }) => Promise<boolean>;
      appsRemoveCommand: (id: string, key: string) => Promise<boolean>;
      appsTestCommand: (id: string, key: string, wcId?: number) => Promise<string>;
      startPicker: (wcId: number) => void;
      onPickerResult: (cb: (result: { selector: string; tag: string; text: string; isEditable: boolean; isClickable: boolean }) => void) => void;

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

      getAppVersion: () => Promise<string>;
      startAuth: (mode: "register" | "login") => Promise<boolean>;
      isAuthenticated: () => Promise<boolean>;
      getAccountInfo: () => Promise<{ email: string; firstName: string; lastName: string; role: string; orgName: string; tier: string; billingStatus: string } | null>;
      logout: () => Promise<void>;
      validateApiKey: (key: string) => Promise<{ valid: boolean; error?: string }>;
      getApiKey: () => Promise<string | null>;
      onBoot: (callback: (data: { authenticated: boolean; status: string; tier?: string; apiKey: boolean; needsOnboarding: boolean; hideWelcome?: boolean; theme?: string }) => void) => void;
      onThemeChanged: (callback: (theme: string) => void) => void;
      onShowWelcome: (callback: () => void) => void;
      onOpenSettings: (callback: () => void) => void;
      onFocusInput: (callback: () => void) => void;
      onExecCommandFromPalette: (callback: (cmd: string) => void) => void;
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
      // Drips CRUD
      dripsList: () => Promise<Array<{ name: string; recipe: string }>>;
      dripsSave: (name: string, recipe: string) => Promise<string>;
      dripsDelete: (name: string) => Promise<string>;
      dripsPreview: (recipe: string) => Promise<string>;
      dripsBuiltinEffects: () => Promise<string[]>;
      // Dashboard
      dashboardToday: () => Promise<any>;
      dashboardHistory: (days?: number) => Promise<any[]>;
      dashboardAllTime: () => Promise<{ agents: Record<string, any>; total: any }>;
      dashboardApps: () => Promise<Array<{ name: string; path: string; modified: string }>>;
      dashboardOpenApp: (name: string) => void;
      dashboardDeleteApp: (name: string) => Promise<boolean>;
      dashboardReminders: () => Promise<Array<{ id: string; message: string; fireAt: number }>>;
      dashboardCancelReminder: (id: string) => Promise<boolean>;
      dashboardLLMInfo: () => Promise<{ provider: string; model: string }>;
      // Prompt log
      promptsList: (offset?: number, limit?: number) => Promise<Array<{ id: string; startTs: number; endTs: number; prompt: string; response: string; inputTokens: number; outputTokens: number; model: string; provider: string; mode: string; toolsUsed: string[] }>>;
      promptsSearch: (query: string, limit?: number) => Promise<Array<{ id: string; startTs: number; endTs: number; prompt: string; response: string; inputTokens: number; outputTokens: number; model: string; provider: string; mode: string; toolsUsed: string[] }>>;
      promptsGet: (id: string) => Promise<{ id: string; startTs: number; endTs: number; prompt: string; response: string; inputTokens: number; outputTokens: number; model: string; provider: string; mode: string; toolsUsed: string[] } | null>;
      promptsCount: () => Promise<number>;
      // Capture store
      capturesStats: () => Promise<{ count: number; sources: Record<string, number>; diskBytes: number; oldestTs: number; newestTs: number; embeddedCount: number; ingestCount: number; searchCount: number; ingestBytes: number }>;
      capturesList: (offset: number, limit: number) => Promise<Array<{ meta: { id: string; source: string; created: number; chunkParent?: string }; snippet: string; size: number }>>;
      capturesRead: (id: string) => Promise<string | null>;
      capturesDelete: (id: string) => Promise<boolean>;
      capturesDeleteBySource: (source: string) => Promise<number>;
      capturesClear: () => Promise<number>;
      capturesSearch: (query: string, limit: number) => Promise<Array<{ meta: { id: string; source: string; created: number }; content: string; score: number }>>;
      capturesDailyHistory: (days?: number) => Promise<Array<{ date: string; count: number; bytes: number }>>;
      capturesEntrySize: (id: string) => Promise<number>;
      capturesStatsForSource: (source: string) => Promise<{ count: number; diskBytes: number; oldestTs: number; newestTs: number; embeddedCount: number }>;
      capturesListForSource: (source: string, offset: number, limit: number) => Promise<Array<{ meta: { id: string; source: string; created: number; chunkParent?: string }; snippet: string; size: number }>>;
      capturesDailyHistoryForSource: (source: string, days?: number) => Promise<Array<{ date: string; count: number; bytes: number }>>;
      // LLM config
      getLLMConfig: () => Promise<{ provider: string; model: string; apiKey: string; baseUrl: string | null }>;
      getLLMPresets: () => Promise<Record<string, { name: string; models: string[]; defaultModel: string; baseUrl?: string; keyPlaceholder: string }>>;
      saveLLMConfig: (config: { provider: string; model: string; apiKey: string; baseUrl?: string }) => Promise<{ ok: boolean; error?: string }>;
      // Tabs
      tabList: () => Promise<{ tabs: TabInfo[]; activeId: string; visible: boolean }>;
      tabSwitch: (id: string) => void;
      tabClose: (id: string) => void;
      tabReorder: (newOrder: string[]) => void;
      tabNew: () => void;
      tabNewApp: (appId: string) => void;
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
      // Theme
      getTheme: () => Promise<string>;
      setTheme: (theme: string) => Promise<void>;
      // Account info
      getAuthStatus: () => Promise<{ authenticated: boolean; status: string; tier?: string }>;
      refreshAuth: () => Promise<{ tier: string; status: string }>;
      openExternal: (url: string) => void;
      platformUrl: string;
      openAccountDashboard: () => void;
      openBilling: () => void;
      // Support
      submitSupportTicket: (ticket: { subject: string; description: string }) => Promise<{ ok: boolean; error?: string }>;
      // Voice transcription
      transcribeAudio: (audioBuffer: ArrayBuffer) => Promise<{ ok: boolean; text?: string; error?: string }>;
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
      yoChatsLoad: (id: string) => Promise<Array<{ role: string; text: string; tools?: Array<{ name: string; input?: unknown }> }> | null>;
      yoChatsDelete: (id: string) => Promise<boolean>;
      yoChatNew: () => Promise<boolean>;
      // Agent mode + guardrails
      getAgentMode: () => Promise<string>;
      setAgentMode: (mode: string) => void;
      onAgentModeChanged: (cb: (mode: string) => void) => void;
      getToolRegistry: () => Promise<Array<{ name: string; label: string; description: string; tier: string; override: string }>>;
      setToolOverride: (toolName: string, override: string) => void;
      onApprovalRequest: (cb: (id: string, toolName: string, toolLabel: string, input: unknown) => void) => void;
      approvalRespond: (id: string, approved: boolean) => void;
      // Connectors (Pipedream Connect)
      connectorsGetApps: (search?: string, offset?: number) => Promise<{ apps: Array<{ id: string; name: string; description: string; icon?: string; categories?: string[] }>; hasMore: boolean }>;
      connectorsGetAccounts: () => Promise<Array<{ id: string; appSlug: string; appName: string; createdAt: string; healthy: boolean }>>;
      connectorsConnect: (appSlug: string) => Promise<{ ok: boolean; error?: string }>;
      connectorsDisconnect: (accountId: string) => Promise<boolean>;
      connectorsRefreshMcp: () => Promise<{ ok: boolean; error?: string; toolCount: number }>;
      onConnectorsChanged: (cb: () => void) => void;
      // Auto-update
      onUpdateStatus: (cb: (info: { status: string; version?: string; percent?: number }) => void) => void;
      updateInstall: () => void;
      checkForUpdates: () => Promise<string | null>;
      // MCP Expose
      mcpExposeStart: () => Promise<{ ok: boolean; error?: string }>;
      mcpExposeStop: () => Promise<void>;
      mcpExposeStatus: () => Promise<{ running: boolean; port: number }>;
      mcpExposeGetTokens: () => Promise<Array<{ token: string; label: string; createdAt: string; expiresAt: string }>>;
      mcpExposeGenToken: (label: string) => Promise<{ token: string; label: string; createdAt: string; expiresAt: string }>;
      mcpExposeRevokeToken: (token: string) => Promise<void>;
      // MCP Servers (custom user-configured)
      mcpGetServers: () => Promise<Array<{ config: { id: string; name: string; transport: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string; enabled: boolean }; status: string; error?: string; tools: Array<{ name: string; description?: string }> }>>;
      mcpAddServer: (config: Record<string, unknown>) => Promise<void>;
      mcpUpdateServer: (id: string, updates: Record<string, unknown>) => Promise<void>;
      mcpRemoveServer: (id: string) => Promise<void>;
      mcpConnectServer: (id: string) => Promise<{ ok: boolean; error?: string }>;
      mcpDisconnectServer: (id: string) => Promise<void>;
      mcpGetToolOverride: (serverId: string, toolName: string) => Promise<string>;
      mcpSetToolOverride: (serverId: string, toolName: string, override: string) => void;
      mcpSetServerOverride: (serverId: string, override: string) => void;
      onMcpChanged: (cb: () => void) => void;
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

// -- Titlebar label -> open home tab --

document.getElementById("titlebar-label")!.addEventListener("click", () => {
  window.yo.tabNewApp("home");
});

// -- MCP indicator --

const mcpIndicator = document.getElementById("mcp-indicator")!;

async function updateMcpIndicator() {
  try {
    const status = await window.yo.mcpExposeStatus();
    if (status.running) {
      mcpIndicator.classList.remove("hidden", "stopped");
      mcpIndicator.classList.add("running");
      mcpIndicator.title = `MCP Server running on port ${status.port} — click to stop`;
    } else {
      // Check if it was enabled (show stopped state)
      const enabled = await window.yo.getPreference("mcpExposeRunning", false);
      if (enabled) {
        mcpIndicator.classList.remove("hidden", "running");
        mcpIndicator.classList.add("stopped");
        mcpIndicator.title = "MCP Server stopped — click to start";
      } else {
        mcpIndicator.classList.add("hidden");
      }
    }
  } catch {
    mcpIndicator.classList.add("hidden");
  }
}

mcpIndicator.addEventListener("click", async () => {
  const status = await window.yo.mcpExposeStatus();
  if (status.running) {
    await window.yo.mcpExposeStop();
  } else {
    await window.yo.mcpExposeStart();
  }
  await updateMcpIndicator();
});

// Poll MCP status periodically and on boot
updateMcpIndicator();
setInterval(updateMcpIndicator, 10000);

// -- Tab bar --

const tabBar = document.getElementById("tab-bar")!;
const tabNewBtn = document.getElementById("tab-new-btn")!;

function renderTabs(tabs: TabInfo[], activeId: string) {
  tabBar.innerHTML = "";
  for (const tab of tabs) {
    const el = document.createElement("div");
    el.className = "tab" + (tab.id === activeId ? " tab-active" : "") + (tab.pinned ? " tab-pinned" : "");
    el.dataset.id = tab.id;

    // Home gets the .Yo logo instead of a favicon
    if (tab.id === "home") {
      const logo = document.createElement("span");
      logo.className = "tab-home-logo";
      logo.innerHTML = '<span class="tab-home-dot">.</span>Yo';
      el.appendChild(logo);
    } else if (tab.layoutFavicons && tab.layoutFavicons.length > 0) {
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

    // Label (home only shows the logo, no label text)
    if (tab.id !== "home") {
      const label = document.createElement("span");
      label.className = "tab-label";
      label.textContent = tab.name;
      el.appendChild(label);
    }

    // Click to switch
    el.addEventListener("click", () => {
      window.yo.tabSwitch(tab.id);
    });

    // Close button — not shown on pinned (home) tabs
    if (!tab.pinned) {
      const close = document.createElement("button");
      close.className = "tab-close";
      close.title = "Close tab";
      close.innerHTML = "&times;";
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        window.yo.tabClose(tab.id);
      });
      el.appendChild(close);
    }

    // Drag-and-drop reordering (not for pinned or layout tabs)
    if (!tab.pinned && tab.id !== "__layout__") {
      el.draggable = true;
      el.addEventListener("dragstart", (e) => {
        el.classList.add("tab-dragging");
        e.dataTransfer?.setData("text/plain", tab.id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      });
      el.addEventListener("dragend", () => {
        el.classList.remove("tab-dragging");
        tabBar.querySelectorAll(".tab-drop-before,.tab-drop-after")
          .forEach((n) => n.classList.remove("tab-drop-before", "tab-drop-after"));
      });
    }
    el.addEventListener("dragover", (e) => {
      if (tab.pinned) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const rect = el.getBoundingClientRect();
      const midpoint = rect.left + rect.width / 2;
      el.classList.toggle("tab-drop-before", e.clientX < midpoint);
      el.classList.toggle("tab-drop-after", e.clientX >= midpoint);
    });
    el.addEventListener("dragleave", () => {
      el.classList.remove("tab-drop-before", "tab-drop-after");
    });
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      const draggedId = e.dataTransfer?.getData("text/plain");
      if (!draggedId || draggedId === tab.id) return;
      // Can't drop on pinned tab
      if (tab.pinned) return;
      const rect = el.getBoundingClientRect();
      const dropBefore = e.clientX < rect.left + rect.width / 2;
      // Compute new order from current DOM
      const currentOrder = Array.from(tabBar.querySelectorAll<HTMLElement>(".tab"))
        .map((n) => n.dataset.id!)
        .filter((id) => id && id !== "__layout__");
      const filtered = currentOrder.filter((id) => id !== draggedId);
      const targetIdx = filtered.indexOf(tab.id);
      filtered.splice(dropBefore ? targetIdx : targetIdx + 1, 0, draggedId);
      window.yo.tabReorder(filtered);
      el.classList.remove("tab-drop-before", "tab-drop-after");
    });

    tabBar.appendChild(el);
  }
  // Re-append the + button so it stays after the last tab
  tabBar.appendChild(tabNewBtn);
}

let tabNewMenu: HTMLElement | null = null;

function closeTabNewMenu() {
  if (tabNewMenu) {
    tabNewMenu.remove();
    tabNewMenu = null;
    window.yo.panelsShow();
  }
}

tabNewBtn.addEventListener("click", async (e) => {
  e.stopPropagation();

  if (tabNewMenu) { closeTabNewMenu(); return; }

  const apps = await window.yo.appsList();
  const appsWithUrl = apps.filter((a) => a.url && !a.url.startsWith("yo://"));

  if (appsWithUrl.length === 0) {
    window.yo.tabNew();
    return;
  }

  window.yo.panelsHide();

  const menu = document.createElement("div");
  menu.className = "tab-new-menu";

  // Search input
  const searchInput = document.createElement("input");
  searchInput.className = "tab-new-menu-search";
  searchInput.type = "text";
  searchInput.placeholder = "Search apps...";
  searchInput.spellcheck = false;
  menu.appendChild(searchInput);

  // Scrollable list
  const list = document.createElement("div");
  list.className = "tab-new-menu-list";

  const browserBtn = document.createElement("button");
  browserBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg><span>Browser</span>`;
  browserBtn.addEventListener("click", () => { closeTabNewMenu(); window.yo.tabNew(); });
  list.appendChild(browserBtn);

  const divider = document.createElement("div");
  divider.className = "tab-new-menu-divider";
  list.appendChild(divider);

  for (const app of appsWithUrl) {
    const btn = document.createElement("button");
    btn.dataset.name = app.name.toLowerCase();
    let iconHtml = "";
    try {
      const domain = new URL(app.url!).hostname;
      iconHtml = `<img src="https://www.google.com/s2/favicons?domain=${domain}&sz=32" width="14" height="14" style="border-radius:2px;" onerror="this.style.display='none'" />`;
    } catch {
      iconHtml = `<span class="tab-new-menu-initial">${app.name.charAt(0).toUpperCase()}</span>`;
    }
    btn.innerHTML = `${iconHtml}<span>${app.name}</span>`;
    btn.addEventListener("click", () => { closeTabNewMenu(); window.yo.tabNewApp(app.id); });
    list.appendChild(btn);
  }

  menu.appendChild(list);

  // Filter on search input
  searchInput.addEventListener("input", () => {
    const q = searchInput.value.toLowerCase();
    list.querySelectorAll<HTMLButtonElement>("button[data-name]").forEach((btn) => {
      btn.style.display = btn.dataset.name!.includes(q) ? "" : "none";
    });
  });

  const rect = tabNewBtn.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${rect.left}px`;

  document.body.appendChild(menu);
  tabNewMenu = menu;
  searchInput.focus();

  const onClickOutside = (ev: MouseEvent) => {
    if (!menu.contains(ev.target as Node) && ev.target !== tabNewBtn) {
      closeTabNewMenu();
      document.removeEventListener("click", onClickOutside);
    }
  };
  setTimeout(() => document.addEventListener("click", onClickOutside), 0);
});

const emptyState = document.getElementById("empty-state")!;

function updateEmptyState(tabs: TabInfo[]) {
  if (tabs.length === 0) {
    emptyState.classList.remove("hidden");
  } else {
    emptyState.classList.add("hidden");
  }
}

let lastActiveTabId = "";
window.yo.onTabState((state: { tabs: TabInfo[]; activeId: string; visible: boolean }) => {
  renderTabs(state.tabs, state.activeId);
  tabBar.style.display = state.visible ? "flex" : "none";
  tabNewBtn.style.display = state.visible ? "" : "none";
  updateEmptyState(state.tabs);
  lastActiveTabId = state.activeId;
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

// -- Cmd+. opens yo agent panel --

// focus-command-input from main → open agent panel
window.yo.onFocusInput(() => {
  if (!isYoPanelOpen()) {
    window.yo.yoPanelOpen("");
    openYoPanel("");
  }
});



// Commands submitted from the palette child window
window.yo.onExecCommandFromPalette((cmd) => window.yo.execCommand(cmd));

// -- Global keyboard shortcuts --

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (isYoPanelOpen()) window.yo.yoPanelDismiss();
  }

  // Cmd+. — toggle yo agent panel
  if (e.key === "." && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    if (isYoPanelOpen()) {
      window.yo.yoPanelDismiss();
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


// yo help trigger from main process — open home tab
window.yo.onShowWelcome(() => window.yo.tabNewApp("home"));
window.yo.onOpenSettings(() => window.yo.tabNewApp("home"));

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

  const cells = grid.cells || [];

  // Column border handles — use available width (accounts for yo panel)
  const availW = getAvailableWidth();
  let cumCol = 0;
  for (let i = 0; i < grid.cols - 1; i++) {
    cumCol += grid.colWidths[i];
    const border = i + 1;
    const hasEdge = cells.some((c) => c.col === border || c.col + c.colSpan === border);
    if (!hasEdge) continue;
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
    const border = i + 1;
    const hasEdge = cells.some((c) => c.row === border || c.row + c.rowSpan === border);
    if (!hasEdge) continue;
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
  gridHandles.querySelectorAll<HTMLElement>(".grid-col-handle").forEach((h) => {
    const idx = parseInt(h.dataset.index!, 10);
    let cc = 0;
    for (let j = 0; j <= idx; j++) cc += currentGrid!.colWidths[j];
    h.style.left = `${Math.round(cc * aw)}px`;
  });
  const contentHeight = window.innerHeight - getContentTop();
  gridHandles.querySelectorAll<HTMLElement>(".grid-row-handle").forEach((h) => {
    const idx = parseInt(h.dataset.index!, 10);
    let cr = 0;
    for (let j = 0; j <= idx; j++) cr += currentGrid!.rowHeights[j];
    h.style.top = `${getContentTop() + cr * contentHeight}px`;
  });
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
    const handle = gridHandles.querySelector<HTMLElement>(`.grid-col-handle[data-index="${dragIndex}"]`);
    if (handle) handle.style.left = `${Math.round(clamped * aw)}px`;
  } else {
    const contentHeight = window.innerHeight - getContentTop();
    const fraction = (e.clientY - getContentTop()) / contentHeight;
    const clamped = Math.max(0.05, Math.min(0.95, fraction));
    const handle = gridHandles.querySelector<HTMLElement>(`.grid-row-handle[data-index="${dragIndex}"]`);
    if (handle) handle.style.top = `${getContentTop() + clamped * contentHeight}px`;
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
    const handle = gridHandles.querySelector<HTMLElement>(`.grid-col-handle[data-index="${dragIndex}"]`);
    if (handle) {
      const fraction = parseFloat(handle.style.left) / getAvailableWidth();
      window.yo.gridDragEnd("col", dragIndex, fraction);
    }
  } else {
    const handle = gridHandles.querySelector<HTMLElement>(`.grid-row-handle[data-index="${dragIndex}"]`);
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

// -- Update bar --

const updateBar = document.getElementById("update-bar")!;
const updateMsg = document.getElementById("update-message")!;
const updateProgress = document.getElementById("update-progress")!;
const updateFill = document.getElementById("update-progress-fill")!;
const updateAction = document.getElementById("update-action")!;
const updateDismiss = document.getElementById("update-dismiss")!;

window.yo.onUpdateStatus(({ status, version, percent }) => {
  if (status === "available") {
    updateMsg.textContent = `Downloading v${version}...`;
    updateProgress.classList.remove("hidden");
    updateAction.classList.add("hidden");
    updateBar.classList.remove("hidden");
  } else if (status === "downloading") {
    updateFill.style.width = `${percent || 0}%`;
  } else if (status === "ready") {
    updateMsg.textContent = `v${version} ready — restart to update`;
    updateProgress.classList.add("hidden");
    updateAction.classList.remove("hidden");
    updateBar.classList.remove("hidden");
  }
});

updateAction.addEventListener("click", () => {
  window.yo.updateInstall();
});

updateDismiss.addEventListener("click", () => {
  updateBar.classList.add("hidden");
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
const yoPanelMicBtn = document.getElementById("yo-panel-mic") as HTMLButtonElement | null;
const yoScrollBtn = document.getElementById("yo-scroll-btn")!;

// Scroll-to-bottom button — show when user scrolls up from bottom
yoPanelMessages.addEventListener("scroll", () => {
  const gap = yoPanelMessages.scrollHeight - yoPanelMessages.scrollTop - yoPanelMessages.clientHeight;
  yoScrollBtn.classList.toggle("visible", gap > 80);
});
yoScrollBtn.addEventListener("click", () => {
  yoPanelMessages.scrollTop = yoPanelMessages.scrollHeight;
});

// Hide mic button by default — shown when voiceEnabled pref is true
if (yoPanelMicBtn) {
  yoPanelMicBtn.style.display = "none";
  window.yo.getPreference("voiceEnabled", false).then((v) => {
    yoPanelMicBtn!.style.display = v ? "" : "none";
  });
}
const yoPanelCloseBtn = document.querySelector(".yo-panel-close")!;
const yoPanelResize = document.getElementById("yo-panel-resize")!;
const yoHistoryToggle = document.getElementById("yo-history-toggle")!;
const yoHistoryPanel = document.getElementById("yo-history")!;
const yoHistoryList = document.getElementById("yo-history-list")!;
const yoChatNewBtn = document.getElementById("yo-chat-new")!;

let yoResponseEl: HTMLElement | null = null;  // the single assistant response element
let yoStatusEl: HTMLElement | null = null;    // spinner + tool status line (persists until response)
let yoLastAssistantText = "";
let yoLastUserText = "";                      // track last user message for plan re-execution
let yoToolsUsed = false;  // once a tool fires, suppress streamed text until done
let yoThinking = false;   // true while agent is processing

function setYoThinking(thinking: boolean) {
  yoThinking = thinking;
  yoPanelSendBtn.textContent = thinking ? "\u25A0" : "\u2191";
  yoPanelSendBtn.classList.toggle("yo-stop", thinking);
  yoPanelInput.disabled = thinking;
  yoPanelInput.classList.toggle("yo-input-disabled", thinking);
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
  w.innerHTML = `<div class="yo-welcome-logo"><span class="yo-welcome-dot">.</span>Yo</div>
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

// -- Yo panel mode + model dropdowns --

// Custom mode dropdown elements
const yoModeDropdown = document.getElementById("yo-mode-dropdown")!;
const yoModeTrigger = document.getElementById("yo-mode-trigger")!;
const yoModeMenu = document.getElementById("yo-mode-menu")!;
const yoModeOptions = yoModeMenu.querySelectorAll(".yo-mode-option");
const yoModelDropdown = document.getElementById("yo-model-dropdown")!;
const yoModelTrigger = document.getElementById("yo-model-trigger")!;
const yoModelMenu = document.getElementById("yo-model-menu")!;
let currentModel = "";
let yoControlsInited = false;

const MODE_ICONS: Record<string, string> = {
  ask: "\u2753",
  plan: "\uD83D\uDCCB",
  auto: "\u26A1",
  council: "\uD83C\uDFDB",
};

const MODE_COLORS: Record<string, string> = {
  ask: "#25C75E",
  plan: "#4A9EFF",
  auto: "#FF8C00",
  council: "#A855F7",
};

let currentMode = "ask";

function setModeValue(mode: string) {
  currentMode = mode;
  const icon = yoModeTrigger.querySelector(".yo-mode-icon")!;
  const label = yoModeTrigger.querySelector(".yo-mode-label")!;
  icon.textContent = MODE_ICONS[mode] || MODE_ICONS.ask;
  label.textContent = mode;
  yoModeOptions.forEach((opt) => {
    opt.classList.toggle("active", (opt as HTMLElement).dataset.value === mode);
  });
  applyModeColor();
}

function applyModeColor() {
  const color = MODE_COLORS[currentMode] || MODE_COLORS.ask;
  yoModeTrigger.style.borderColor = color;
  yoPanelInput.style.setProperty("--mode-color", color);
  yoPanelSendBtn.style.background = color;
  document.documentElement.style.setProperty("--yo-mode-color", color);
}

yoModeTrigger.addEventListener("click", (e) => {
  e.stopPropagation();
  yoModeMenu.classList.toggle("hidden");
});

yoModeOptions.forEach((opt) => {
  opt.addEventListener("click", () => {
    const value = (opt as HTMLElement).dataset.value!;
    setModeValue(value);
    window.yo.setAgentMode(value);
    yoModeMenu.classList.add("hidden");
  });
});

document.addEventListener("click", (e) => {
  if (!yoModeDropdown.contains(e.target as Node)) {
    yoModeMenu.classList.add("hidden");
  }
});

// Listen for mode changes pushed from main process (e.g. .council)
window.yo.onAgentModeChanged?.((mode: string) => setModeValue(mode));

async function initYoControls() {
  const mode = await window.yo.getAgentMode();
  setModeValue(mode);

  const [config, presets] = await Promise.all([
    window.yo.getLLMConfig(),
    window.yo.getLLMPresets(),
  ]);
  const preset = presets[config.provider];
  populateModelDropdown(preset?.models || [config.model], config.model);
}

function populateModelDropdown(models: string[], activeModel: string) {
  yoModelMenu.innerHTML = "";
  for (const m of models) {
    const div = document.createElement("div");
    div.className = "yo-model-option" + (m === activeModel ? " active" : "");
    div.dataset.value = m;
    div.textContent = m.replace(/^claude-|^gpt-|^gemini-/i, "").replace(/-\d{8}$/, "");
    div.addEventListener("click", async () => {
      setModelValue(m);
      yoModelMenu.classList.add("hidden");
      const cfg = await window.yo.getLLMConfig();
      await window.yo.saveLLMConfig({
        provider: cfg.provider,
        model: m,
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl || undefined,
      });
    });
    yoModelMenu.appendChild(div);
  }
  setModelValue(activeModel);
}

function setModelValue(model: string) {
  currentModel = model;
  const label = yoModelTrigger.querySelector(".yo-model-label")!;
  label.textContent = model.replace(/^claude-|^gpt-|^gemini-/i, "").replace(/-\d{8}$/, "");
  yoModelMenu.querySelectorAll(".yo-model-option").forEach((opt) => {
    opt.classList.toggle("active", (opt as HTMLElement).dataset.value === model);
  });
}

yoModelTrigger.addEventListener("click", (e) => {
  e.stopPropagation();
  yoModelMenu.classList.toggle("hidden");
});

document.addEventListener("click", (e) => {
  if (!yoModelDropdown.contains(e.target as Node)) {
    yoModelMenu.classList.add("hidden");
  }
});

async function openYoPanel(query: string) {
  if (!yoControlsInited) {
    yoControlsInited = true;
    initYoControls();
  }
  // Personalize title with user's first name
  const titleEl = document.querySelector(".yo-panel-title");
  if (titleEl) {
    const account = await window.yo.getAccountInfo();
    if (account?.firstName) {
      titleEl.innerHTML = `<span class="yo-dot">.</span>Yo <span class="yo-dot">.</span>Sup ${account.firstName}`;
    }
  }
  const savedWidth = await window.yo.yoPanelGetWidth();
  yoPanel.style.width = `${savedWidth}px`;
  document.body.style.setProperty("--right-inset", `${savedWidth}px`);
  yoPanel.classList.remove("hidden");
  void yoPanel.offsetHeight;
  yoPanel.classList.add("open");
  yoToolsUsed = false;
  yoTimelineEl = null;
  yoSpinnerEl = null;
  if (query.startsWith("__council__:")) {
    // Council mode — show prompt message, don't auto-send
    const parts = query.replace("__council__:", "").split(",");
    hideYoWelcome();
    const msg = document.createElement("div");
    msg.className = "yo-msg yo-msg-assistant";
    msg.innerHTML = formatYoText(`Council ready: ${parts.join(", ")}\nEnter your topic below.`);
    yoPanelMessages.appendChild(msg);
  } else if (query) {
    hideYoWelcome();
    addYoUserMessage(query);
    showYoStatus("");
    setYoThinking(true);
    window.yo.yoPanelSend(query);
  } else if (!yoPanelMessages.children.length) {
    showYoWelcome();
  }
  yoPanelInput.value = "";
  autoGrowYoInput();
  // Focus after slide animation; re-render grid handles (available width changed)
  setTimeout(() => { yoPanelInput.focus(); yoPanelInput.select(); renderGridHandles(); }, 220);
}

function closeYoPanel() {
  yoPanel.classList.remove("open");
  document.body.style.setProperty("--right-inset", "0px");
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
  delegate_navigate: "Navigating panels",
  delegate_layout:   "Arranging layout",
};

const DIRECT_TOOL_DESC: Record<string, string> = {
  search_captures: "Searching captures",
  get_context:     "Reading session",
  format:          "Formatting",
  save_memory:     "Saving to memory",
  search_notes:    "Searching notes",
  read_file:       "Reading file",
  list_files:      "Listing files",
  run_command:     "Running command",
  start_council:   "Starting council",
};

const BRAILLE = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827"];
const PHRASES = ["thinking", "cooking", "vibing", "brewing", "conjuring", "channeling"];
const STOP_QUIPS = [
  "You stopped the music.",
  "Record scratch.",
  "The vibe has been killed.",
  "Pulling the plug.",
  "And... cut.",
  "Mic drop. But not by me.",
  "Walked off stage mid-set.",
  "You hit the brakes.",
];

let yoSpinnerInterval: ReturnType<typeof setInterval> | null = null;
let yoSpinnerEl: HTMLElement | null = null;
let yoTimelineEl: HTMLElement | null = null;    // shared timeline for result items

function yoScroll() {
  yoPanelMessages.scrollTop = yoPanelMessages.scrollHeight;
  yoScrollBtn.classList.remove("visible");
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

/** Find an active (not yet finished) tool row by tool name. */
function findToolRowByName(toolName: string): HTMLElement | null {
  for (const [, el] of yoToolRows) {
    if (el.dataset.tool === toolName) return el;
  }
  return null;
}

/** Start a per-tool row: dot (pulsing), bold name, subtitle describing the action. */
function startToolRow(id: string, name: string, input: unknown) {
  ensureTimeline();
  const block = document.createElement("div");
  block.className = "yo-result-block yo-active";
  block.dataset.tool = name;

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
  // Accumulate silently — the existing spinner stays visible.
  // Text only renders (formatted) when finalizeYoMessage fires.
  yoLastAssistantText += delta;
}

function finalizeYoMessage(fullText: string) {
  clearYoStatus();
  setYoThinking(false);
  finishTimeline();

  const text = fullText || yoLastAssistantText;

  if (yoResponseEl) {
    yoResponseEl.innerHTML = formatYoText(text);
    attachCopyHandlers(yoResponseEl);
  } else {
    yoResponseEl = document.createElement("div");
    yoResponseEl.className = "yo-msg yo-msg-assistant";
    yoResponseEl.innerHTML = formatYoText(text);
    attachCopyHandlers(yoResponseEl);
    yoPanelMessages.appendChild(yoResponseEl);
  }

  if (text.trim()) {
    const actions = document.createElement("div");
    actions.className = "yo-msg-actions";
    const copyBtn = document.createElement("button");
    copyBtn.className = "yo-msg-copy-btn";
    copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>Copy</span>`;
    copyBtn.addEventListener("click", () => {
      const doCopy = () => {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0;";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      };
      try {
        if (window.yo.copyToClipboard) {
          window.yo.copyToClipboard(text);
        } else {
          doCopy();
        }
      } catch { doCopy(); }
      copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg><span>Copied</span>`;
      copyBtn.classList.add("yo-copied");
      setTimeout(() => {
        copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>Copy</span>`;
        copyBtn.classList.remove("yo-copied");
      }, 2000);
    });
    actions.appendChild(copyBtn);
    yoResponseEl.appendChild(actions);
  }

  yoLastAssistantText = text;
  yoResponseEl = null;

  // In plan mode, show action buttons
  if (currentMode === "plan" && yoLastUserText) {
    showPlanActions();
  }

  yoScroll();
}

function showPlanActions() {
  const card = document.createElement("div");
  card.className = "yo-plan-actions";
  card.innerHTML =
    `<button class="yo-plan-btn yo-plan-proceed">Proceed</button>` +
    `<button class="yo-plan-btn yo-plan-auto">Proceed (auto)</button>` +
    `<button class="yo-plan-btn yo-plan-edit">Edit</button>`;
  yoPanelMessages.appendChild(card);

  card.querySelector(".yo-plan-proceed")!.addEventListener("click", () => {
    card.remove();
    window.yo.setAgentMode("ask");
    setModeValue("ask");
    showYoStatus("");
    setYoThinking(true);
    window.yo.yoPanelSend("Execute the plan above.");
  });

  card.querySelector(".yo-plan-auto")!.addEventListener("click", () => {
    card.remove();
    window.yo.setAgentMode("auto");
    setModeValue("auto");
    showYoStatus("");
    setYoThinking(true);
    window.yo.yoPanelSend("Execute the plan above.");
  });

  card.querySelector(".yo-plan-edit")!.addEventListener("click", () => {
    card.remove();
    yoPanelInput.value = yoLastUserText;
    yoPanelInput.focus();
    autoGrowYoInput();
  });
}

/** Lightweight markdown → HTML renderer for LLM output.
 *  Handles: code fences, headers, bold, italic, inline code, links,
 *  unordered/ordered lists, blockquotes, horizontal rules, paragraphs. */
function formatYoText(text: string): string {
  if (!text) return "";

  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Inline formatting (applied within already-escaped text)
  const inline = (s: string) =>
    s
      .replace(/`([^`]+)`/g, '<code class="yo-md-inline">$1</code>')
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match: string, text: string, url: string) => {
        // Sanitize URL: only allow http(s) and mailto protocols
        const trimmed = url.trim().toLowerCase();
        if (trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("mailto:")) {
          return `<a class="yo-md-link" href="${url}" title="${url}">${text}</a>`;
        }
        // Strip dangerous protocols (javascript:, data:, vbscript:, file:, etc.)
        return `<span class="yo-md-link" title="[blocked: unsafe URL]">${text}</span>`;
      });

  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fenceMatch = line.match(/^```(\w*)/);
    if (fenceMatch) {
      const lang = fenceMatch[1] || "";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(esc(lines[i]));
        i++;
      }
      if (i < lines.length) i++; // skip closing ```
      const label = lang || "code";
      const codeId = `yo-code-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      out.push(
        `<div class="yo-md-codeblock" data-code-id="${codeId}">` +
          `<div class="yo-md-codeblock-header">` +
            `<span class="yo-md-codeblock-lang">${esc(label)}</span>` +
            `<button class="yo-md-copy-btn" data-code-id="${codeId}">Copy</button>` +
          `</div>` +
          `<pre class="yo-md-pre"><code>${codeLines.join("\n")}</code></pre>` +
        `</div>`
      );
      continue;
    }

    // Heading
    const hMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (hMatch) {
      const level = hMatch[1].length;
      out.push(`<h${level} class="yo-md-h${level}">${inline(esc(hMatch[2]))}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('<hr class="yo-md-hr">');
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith("> ") || line === ">") {
      const quoteLines: string[] = [];
      while (i < lines.length && (lines[i].startsWith("> ") || lines[i] === ">")) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push(`<blockquote class="yo-md-quote">${inline(esc(quoteLines.join("\n")))}</blockquote>`);
      continue;
    }

    // Unordered list
    if (/^[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
        items.push(inline(esc(lines[i].replace(/^[-*+]\s+/, ""))));
        i++;
      }
      out.push(`<ul class="yo-md-ul">${items.map((li) => `<li>${li}</li>`).join("")}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(inline(esc(lines[i].replace(/^\d+\.\s+/, ""))));
        i++;
      }
      out.push(`<ol class="yo-md-ol">${items.map((li) => `<li>${li}</li>`).join("")}</ol>`);
      continue;
    }

    // Blank line
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph — collect consecutive non-blank, non-special lines
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].match(/^```/) &&
      !lines[i].match(/^#{1,4}\s/) &&
      !lines[i].match(/^[-*+]\s+/) &&
      !lines[i].match(/^\d+\.\s+/) &&
      !lines[i].startsWith("> ") &&
      !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    out.push(`<p class="yo-md-p">${inline(esc(paraLines.join("\n")))}</p>`);
  }

  return out.join("");
}

/** Attach interactive handlers (copy buttons, links) inside a container.
 *  Called after innerHTML is set with formatYoText output. */
function attachCopyHandlers(container: HTMLElement) {
  // Copy buttons on code blocks
  container.querySelectorAll<HTMLButtonElement>(".yo-md-copy-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const codeId = btn.dataset.codeId;
      if (!codeId) return;
      const block = container.querySelector(`.yo-md-codeblock[data-code-id="${codeId}"] code`);
      if (!block) return;
      window.yo.copyToClipboard(block.textContent || "");
      btn.textContent = "Copied";
      btn.classList.add("yo-copied");
      setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("yo-copied"); }, 2000);
    });
  });
  // Links open externally instead of navigating the panel
  container.querySelectorAll<HTMLAnchorElement>(".yo-md-link").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const href = a.getAttribute("href");
      if (href) window.yo.openExternal(href);
    });
  });
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
  if (yoThinking) return;
  const text = yoPanelInput.value.trim();
  if (!text) return;

  // .rec — start voice recording instead of sending
  if (/^\.rec$/i.test(text) && yoPanelMicBtn) {
    yoPanelInput.value = "";
    autoGrowYoInput();
    yoPanelMicBtn.click();
    return;
  }

  hideYoWelcome();
  yoPanelInput.value = "";
  autoGrowYoInput();
  yoToolsUsed = false;
  yoTimelineEl = null;
  yoSpinnerEl = null;
  yoLastUserText = text;
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
    finishTimeline();
    setYoThinking(false);
    // Show a stop quip
    const quip = STOP_QUIPS[Math.floor(Math.random() * STOP_QUIPS.length)];
    const stopEl = document.createElement("div");
    stopEl.className = "yo-msg yo-msg-stopped";
    stopEl.innerHTML = `<em>${quip}</em>`;
    yoPanelMessages.appendChild(stopEl);
    yoResponseEl = null;
    yoScroll();
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

// -- Voice sounds (synthesized tones, no files needed) --
function playTone(freq: number, durationMs: number, volume = 0.15) {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.value = volume;
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durationMs / 1000);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + durationMs / 1000);
  osc.onended = () => ctx.close();
}
function playRecordStart() { playTone(880, 120); setTimeout(() => playTone(1320, 100), 130); }
function playRecordStop() { playTone(1320, 120); setTimeout(() => playTone(880, 100), 130); }

// -- Voice input (getUserMedia + silence detection + Whisper via IPC) --
if (yoPanelMicBtn) {
  let recording = false;
  let mediaRecorder: MediaRecorder | null = null;
  let audioChunks: Blob[] = [];
  let micStream: MediaStream | null = null;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  let silenceCheckInterval: ReturnType<typeof setInterval> | null = null;

  const SILENCE_THRESHOLD = 0.01;  // RMS below this = silence
  const SILENCE_TIMEOUT = 1500;    // ms of silence before auto-stop

  function stopRecording() {
    if (silenceCheckInterval) { clearInterval(silenceCheckInterval); silenceCheckInterval = null; }
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
    mediaRecorder?.stop();
  }

  yoPanelMicBtn.addEventListener("click", async () => {
    if (yoThinking) return;

    if (recording) {
      stopRecording();
      return;
    }

    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.warn("Mic access denied:", err);
      return;
    }

    recording = true;
    audioChunks = [];
    yoPanelMicBtn!.classList.add("listening");
    playRecordStart();

    // Set up silence detection via AnalyserNode
    const audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(micStream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let speaking = false;

    silenceCheckInterval = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      const rms = Math.sqrt(buf.reduce((sum, v) => sum + v * v, 0) / buf.length);

      if (rms > SILENCE_THRESHOLD) {
        speaking = true;
        if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
      } else if (speaking && !silenceTimer) {
        // Started being silent after speaking — start countdown
        silenceTimer = setTimeout(() => {
          audioCtx.close();
          stopRecording();
        }, SILENCE_TIMEOUT);
      }
    }, 100);

    mediaRecorder = new MediaRecorder(micStream, { mimeType: "audio/webm" });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      recording = false;
      yoPanelMicBtn!.classList.remove("listening");
      playRecordStop();
      if (silenceCheckInterval) { clearInterval(silenceCheckInterval); silenceCheckInterval = null; }
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
      // Release mic
      micStream?.getTracks().forEach((t) => t.stop());
      micStream = null;

      if (audioChunks.length === 0) return;

      const blob = new Blob(audioChunks, { type: "audio/webm" });
      audioChunks = [];

      // Decode to raw 16kHz mono Float32 for Whisper
      const arrayBuf = await blob.arrayBuffer();
      const decodeCtx = new AudioContext({ sampleRate: 16000 });
      let decoded: AudioBuffer;
      try {
        decoded = await decodeCtx.decodeAudioData(arrayBuf);
      } catch {
        console.warn("Failed to decode audio");
        decodeCtx.close();
        return;
      }
      const mono = decoded.getChannelData(0);
      decodeCtx.close();

      // Show brief status
      yoPanelMicBtn!.classList.add("disabled");
      yoPanelMicBtn!.title = "Transcribing...";

      const result = await window.yo.transcribeAudio(mono.buffer as ArrayBuffer);

      yoPanelMicBtn!.classList.remove("disabled");
      yoPanelMicBtn!.title = "Voice input";

      if (result.ok && result.text) {
        yoPanelInput.value = (yoPanelInput.value + " " + result.text).trim();
        yoPanelInput.style.height = "auto";
        yoPanelInput.style.height = yoPanelInput.scrollHeight + "px";
        yoPanelInput.focus();
      } else if (!result.ok) {
        const errMsg = (result.error || "Transcription failed")
          .replace(/^Whisper API \d+:\s*/, "")
          .replace(/\{[\s\S]*$/, "")
          .trim() || "Transcription failed";
        const el = document.createElement("div");
        el.className = "yo-msg yo-msg-error";
        el.textContent = errMsg;
        yoPanelMessages.appendChild(el);
        yoScroll();
      }
    };

    mediaRecorder.start();
  });
}

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
  document.body.style.setProperty("--right-inset", `${newWidth}px`);
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

        // Render conversation messages (including tool calls from history)
        for (const msg of messages) {
          // Render tool timeline for this assistant turn (before the text)
          if (msg.role === "assistant" && msg.tools && msg.tools.length > 0) {
            const timeline = document.createElement("div");
            timeline.className = "yo-ag-timeline done";
            for (const tool of msg.tools) {
              const block = document.createElement("div");
              block.className = "yo-result-block yo-done";
              const header = document.createElement("div");
              header.className = "yo-result-header";
              const dot = document.createElement("span");
              dot.className = "yo-ag-dot";
              header.appendChild(dot);
              const headings = document.createElement("div");
              headings.className = "yo-result-headings";
              const nameEl = document.createElement("span");
              nameEl.className = "yo-result-name";
              nameEl.textContent = DELEGATION_DESC[tool.name] || DIRECT_TOOL_DESC[tool.name] || tool.name.replace(/_/g, " ");
              headings.appendChild(nameEl);
              const sub = toolInputSummary(tool.name, tool.input);
              if (sub) {
                const subEl = document.createElement("span");
                subEl.className = "yo-result-subtitle";
                subEl.textContent = sub;
                headings.appendChild(subEl);
              }
              header.appendChild(headings);
              block.appendChild(header);
              timeline.appendChild(block);
            }
            yoPanelMessages.appendChild(timeline);
          }

          const el = document.createElement("div");
          if (msg.role === "user") {
            el.className = "yo-msg yo-msg-user";
            el.textContent = msg.text;
          } else {
            if (!msg.text) continue; // tool-only turn with no text
            el.className = "yo-msg yo-msg-assistant";
            el.innerHTML = formatYoText(msg.text);
            attachCopyHandlers(el);
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

// -- Yo panel approval UI --

window.yo.onApprovalRequest((id, toolName, toolLabel, input) => {
  const inputObj = input as Record<string, unknown>;
  let detail = "";
  if (typeof inputObj.instruction === "string") detail = inputObj.instruction;
  else if (typeof inputObj.text === "string") detail = inputObj.text;
  else if (typeof inputObj.command === "string") detail = inputObj.command;
  else if (typeof inputObj.url === "string") detail = inputObj.url;
  else if (typeof inputObj.panel_id === "string") detail = `panel: ${inputObj.panel_id}`;
  else {
    const first = Object.values(inputObj).find((v) => typeof v === "string");
    if (typeof first === "string") detail = first;
  }

  const card = document.createElement("div");
  card.className = "yo-approval-card";
  card.innerHTML =
    `<div class="yo-approval-header">` +
      `<span class="yo-approval-icon">?</span>` +
      `<span class="yo-approval-title">${toolLabel}</span>` +
    `</div>` +
    (detail ? `<div class="yo-approval-detail">${detail.replace(/&/g, "&amp;").replace(/</g, "&lt;").slice(0, 200)}</div>` : "") +
    `<div class="yo-approval-actions">` +
      `<button class="yo-approval-btn yo-approval-allow">Allow</button>` +
      `<button class="yo-approval-btn yo-approval-deny">Deny</button>` +
    `</div>`;

  // Anchor the approval card to its tool row in the timeline so it
  // stays in order even when multiple tools need approval at once.
  const toolRow = findToolRowByName(toolName);
  if (toolRow) {
    toolRow.appendChild(card);
  } else if (yoStatusEl) {
    yoStatusEl.before(card);
  } else {
    yoPanelMessages.appendChild(card);
  }
  yoScroll();

  card.querySelector(".yo-approval-allow")!.addEventListener("click", () => {
    window.yo.approvalRespond(id, true);
    card.classList.add("yo-approval-resolved", "yo-approval-allowed");
    card.querySelector(".yo-approval-actions")!.remove();
    const status = document.createElement("span");
    status.className = "yo-approval-status allowed";
    status.textContent = "allowed";
    card.querySelector(".yo-approval-header")!.appendChild(status);
  });

  card.querySelector(".yo-approval-deny")!.addEventListener("click", () => {
    window.yo.approvalRespond(id, false);
    card.classList.add("yo-approval-resolved", "yo-approval-denied");
    card.querySelector(".yo-approval-actions")!.remove();
    const status = document.createElement("span");
    status.className = "yo-approval-status denied";
    status.textContent = "denied";
    card.querySelector(".yo-approval-header")!.appendChild(status);
  });
});

// -- Boot gate --

// Splash — minimum display time before dismissing
const splashShownAt = Date.now();
const SPLASH_MIN_MS = 3500;
let booted = false;
let bootData: any = null;
let tutorialShowing = false;


function dismissSplash(): void {
  if (!booted) return;
  const elapsed = Date.now() - splashShownAt;
  const remaining = Math.max(0, SPLASH_MIN_MS - elapsed);
  setTimeout(() => {
    // Show panels first (behind splash z-index:9999) so they're ready when splash fades
    // BUT not if tutorial is showing — BrowserViews paint over HTML overlays
    if (!tutorialShowing) window.yo.panelsShow();
    const splash = document.getElementById("splash");
    if (splash) {
      splash.classList.add("fade-out");
      setTimeout(() => splash.remove(), 600);
    }
  }, remaining);
  if (bootData?.needsOnboarding) {
    showOnboarding(!bootData.authenticated);
  }
}

// Config sync status during boot
(window as any).yo.onSplashStatus?.((msg: string) => {
  const el = document.getElementById("splash-status");
  if (el) {
    el.textContent = msg;
    if (msg === "ready") el.classList.add("done");
    else el.classList.remove("done");
  }
});

window.yo.onBoot((data) => {
  booted = true;
  bootData = data;
  if (data.theme) {
    document.documentElement.setAttribute("data-theme", data.theme);
    try { localStorage.setItem("yoTheme", data.theme); } catch {}
  }
  dismissSplash();

  // Show tutorial on first launch (skip if going through onboarding — handled by yo-onboarding-done)
  if (!data.needsOnboarding) {
    window.yo.getPreference("hasSeenTutorial", false).then((seen) => {
      if (!seen) showTutorial();
    });
  }
});

window.yo.onThemeChanged((theme) => {
  document.documentElement.setAttribute("data-theme", theme);
  try { localStorage.setItem("yoTheme", theme); } catch {}
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
  "", // Cmd+. step — no typing, shows keyboard shortcut
];

function showTutorial() {
  tutorialShowing = true;
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
    tutorialShowing = false;
    window.yo.setPreference("hasSeenTutorial", true);
    overlay.classList.add("hidden");
    // Restore panels now that tutorial is dismissed
    window.yo.panelsShow();
  }

  // Start first step
  goToStep(0);
}
