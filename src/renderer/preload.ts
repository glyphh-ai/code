/**
 * Preload script — exposes IPC to the renderer safely.
 */

import { contextBridge, ipcRenderer, clipboard } from "electron";

contextBridge.exposeInMainWorld("yo", {
  copyToClipboard: (text: string) => clipboard.writeText(text),
  windowClose: () => ipcRenderer.send("window-close"),
  windowMinimize: () => ipcRenderer.send("window-minimize"),
  windowMaximize: () => ipcRenderer.send("window-maximize"),

  // Panel visibility + refresh
  panelsHide: () => ipcRenderer.send("panels-hide"),
  panelsShow: () => ipcRenderer.send("panels-show"),
  cmdPaletteOpen: () => ipcRenderer.send("cmd-palette-open"),
  capturePanels: () => ipcRenderer.invoke("capture-panels") as Promise<Array<{ dataUrl: string; bounds: { x: number; y: number; width: number; height: number } }>>,
  panelsRefresh: (id?: string) => ipcRenderer.send("panels-refresh", id),
  panelsZoom: (factor: number) => ipcRenderer.send("panels-zoom", factor),
  panelsGetZoom: () => ipcRenderer.invoke("panels-get-zoom") as Promise<number>,

  // Skills CRUD
  skillsList: () => ipcRenderer.invoke("skills-list") as Promise<string[]>,
  skillsListDetailed: () => ipcRenderer.invoke("skills-list-detailed") as Promise<Array<{ name: string; description?: string; hasRunner: boolean; scheduled: boolean; scheduleExpr?: string }>>,
  skillsRead: (name: string) => ipcRenderer.invoke("skills-read", name) as Promise<string | null>,
  skillsGet: (name: string) => ipcRenderer.invoke("skills-get", name) as Promise<{ name: string; manifest: any; prompt: string; hasRunner: boolean; runnerCode: string | null } | null>,
  skillsWrite: (name: string, prompt: string) => ipcRenderer.invoke("skills-write", name, prompt) as Promise<boolean | { error: string }>,
  skillsWriteFull: (name: string, manifest: any, prompt: string, runnerCode?: string | null) =>
    ipcRenderer.invoke("skills-write-full", name, manifest, prompt, runnerCode) as Promise<boolean | { error: string }>,
  skillsRemove: (name: string) => ipcRenderer.invoke("skills-remove", name) as Promise<boolean>,
  skillsGenerate: (name: string, description: string) => ipcRenderer.invoke("skills-generate", name, description) as Promise<string>,
  skillsAvailableTools: () => ipcRenderer.invoke("skills-available-tools") as Promise<Array<{ namespace: string; label: string; tools: Array<{ name: string; description: string }> }>>,
  // Files in a skill folder
  skillsListFiles: (name: string) => ipcRenderer.invoke("skills-list-files", name) as Promise<string[]>,
  skillsReadFile: (name: string, rel: string) => ipcRenderer.invoke("skills-read-file", name, rel) as Promise<string | null>,
  skillsWriteFile: (name: string, rel: string, content: string) => ipcRenderer.invoke("skills-write-file", name, rel, content) as Promise<boolean>,
  skillsDeleteFile: (name: string, rel: string) => ipcRenderer.invoke("skills-delete-file", name, rel) as Promise<boolean>,
  // Run
  skillsRun: (name: string, input: unknown) => ipcRenderer.invoke("skills-run", name, input) as Promise<{ ok: true; output: unknown } | { ok: false; error: string }>,
  skillsCancel: (runId: string) => ipcRenderer.invoke("skills-cancel", runId) as Promise<boolean>,
  skillsUserResponse: (qid: string, answer: string) => ipcRenderer.invoke("skills-user-response", qid, answer) as Promise<boolean>,
  skillsRunHistory: (name: string) => ipcRenderer.invoke("skills-run-history", name) as Promise<any[]>,
  onSkillProgress: (cb: (data: { runId: string; event: any }) => void) => {
    ipcRenderer.on("skill-progress", (_e, data) => cb(data));
  },
  onSkillAskUser: (cb: (data: { runId: string; qid: string; question: string }) => void) => {
    ipcRenderer.on("skill-ask-user", (_e, data) => cb(data));
  },
  // Export/import
  skillsExport: (name: string) => ipcRenderer.invoke("skills-export", name) as Promise<string | null>,
  skillsImport: (base64: string, overwrite?: boolean) =>
    ipcRenderer.invoke("skills-import", base64, overwrite) as Promise<{ imported: string[]; skipped: string[]; error?: string }>,
  // Scheduler
  skillsScheduleStatus: () => ipcRenderer.invoke("skills-schedule-status") as Promise<Array<{ name: string; schedule: string; paused: boolean }>>,
  skillsPauseSchedule: (name: string) => ipcRenderer.invoke("skills-pause-schedule", name) as Promise<void>,
  skillsResumeSchedule: (name: string) => ipcRenderer.invoke("skills-resume-schedule", name) as Promise<void>,

  // Layouts CRUD
  layoutsList: () => ipcRenderer.invoke("layouts-list") as Promise<Array<{ name: string; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; splits: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }> }>>,
  layoutsSave: (name: string, panelIds: string[]) => ipcRenderer.invoke("layouts-save", name, panelIds) as Promise<boolean>,
  layoutsSaveGrid: (grid: { name: string; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }> }) =>
    ipcRenderer.invoke("layouts-save-grid", grid) as Promise<boolean>,
  layoutsDelete: (name: string) => ipcRenderer.invoke("layouts-delete", name) as Promise<boolean>,

  // Drips CRUD
  dripsList: () => ipcRenderer.invoke("drips-list") as Promise<Array<{ name: string; recipe: string }>>,
  dripsSave: (name: string, recipe: string) => ipcRenderer.invoke("drips-save", name, recipe) as Promise<string>,
  dripsDelete: (name: string) => ipcRenderer.invoke("drips-delete", name) as Promise<string>,
  dripsPreview: (recipe: string) => ipcRenderer.invoke("drips-preview", recipe) as Promise<string>,
  dripsBuiltinEffects: () => ipcRenderer.invoke("drips-builtin-effects") as Promise<string[]>,

  // Dashboard
  dashboardToday: () => ipcRenderer.invoke("dashboard:today") as Promise<any>,
  dashboardHistory: (days?: number) => ipcRenderer.invoke("dashboard:history", days) as Promise<any[]>,
  dashboardAllTime: () => ipcRenderer.invoke("dashboard:all-time") as Promise<{ agents: Record<string, any>; total: any }>,
  dashboardApps: () => ipcRenderer.invoke("dashboard:apps") as Promise<Array<{ name: string; path: string; modified: string }>>,
  dashboardOpenApp: (name: string) => ipcRenderer.send("dashboard:open-app", name),
  dashboardDeleteApp: (name: string) => ipcRenderer.invoke("dashboard:delete-app", name) as Promise<boolean>,
  dashboardReminders: () => ipcRenderer.invoke("dashboard:reminders") as Promise<Array<{ id: string; message: string; fireAt: number }>>,
  dashboardCancelReminder: (id: string) => ipcRenderer.invoke("dashboard:cancel-reminder", id) as Promise<boolean>,
  dashboardLLMInfo: () => ipcRenderer.invoke("dashboard:llm-info") as Promise<{ provider: string; model: string }>,

  // Prompt log
  promptsList: (offset?: number, limit?: number) => ipcRenderer.invoke("prompts-list", offset, limit) as Promise<Array<{ id: string; startTs: number; endTs: number; prompt: string; response: string; inputTokens: number; outputTokens: number; model: string; provider: string; mode: string; toolsUsed: string[] }>>,
  promptsSearch: (query: string, limit?: number) => ipcRenderer.invoke("prompts-search", query, limit) as Promise<Array<{ id: string; startTs: number; endTs: number; prompt: string; response: string; inputTokens: number; outputTokens: number; model: string; provider: string; mode: string; toolsUsed: string[] }>>,
  promptsGet: (id: string) => ipcRenderer.invoke("prompts-get", id) as Promise<{ id: string; startTs: number; endTs: number; prompt: string; response: string; inputTokens: number; outputTokens: number; model: string; provider: string; mode: string; toolsUsed: string[] } | null>,
  promptsCount: () => ipcRenderer.invoke("prompts-count") as Promise<number>,

  // Capture store
  capturesStats: () => ipcRenderer.invoke("captures-stats") as Promise<{ count: number; sources: Record<string, number>; diskBytes: number; oldestTs: number; newestTs: number; embeddedCount: number; ingestCount: number; searchCount: number; ingestBytes: number }>,
  capturesList: (offset: number, limit: number) => ipcRenderer.invoke("captures-list", offset, limit) as Promise<Array<{ meta: { id: string; source: string; created: number; chunkParent?: string }; snippet: string; size: number }>>,
  capturesRead: (id: string) => ipcRenderer.invoke("captures-read", id) as Promise<string | null>,
  capturesDelete: (id: string) => ipcRenderer.invoke("captures-delete", id) as Promise<boolean>,
  capturesDeleteBySource: (source: string) => ipcRenderer.invoke("captures-delete-source", source) as Promise<number>,
  capturesClear: () => ipcRenderer.invoke("captures-clear") as Promise<number>,
  capturesSearch: (query: string, limit: number) => ipcRenderer.invoke("captures-search", query, limit) as Promise<Array<{ meta: { id: string; source: string; created: number }; content: string; score: number }>>,
  capturesDailyHistory: (days?: number) => ipcRenderer.invoke("captures-daily-history", days) as Promise<Array<{ date: string; count: number; bytes: number }>>,
  capturesEntrySize: (id: string) => ipcRenderer.invoke("captures-entry-size", id) as Promise<number>,
  capturesStatsForSource: (source: string) => ipcRenderer.invoke("captures-stats-source", source) as Promise<{ count: number; diskBytes: number; oldestTs: number; newestTs: number; embeddedCount: number }>,
  capturesListForSource: (source: string, offset: number, limit: number) => ipcRenderer.invoke("captures-list-source", source, offset, limit) as Promise<Array<{ meta: { id: string; source: string; created: number; chunkParent?: string }; snippet: string; size: number }>>,
  capturesDailyHistoryForSource: (source: string, days?: number) => ipcRenderer.invoke("captures-daily-history-source", source, days) as Promise<Array<{ date: string; count: number; bytes: number }>>,

  // Grid resize
  gridDragEnd: (type: "col" | "row", index: number, fraction: number) =>
    ipcRenderer.send("grid-drag-end", type, index, fraction),

  // Session
  sessionInfo: () => ipcRenderer.invoke("session-info") as Promise<{ hasContent: boolean; label: string; fileName: string }>,
  sessionClear: () => ipcRenderer.invoke("session-clear") as Promise<boolean>,
  onSessionChanged: (callback: (info: { hasContent: boolean; label: string; fileName: string }) => void) => {
    ipcRenderer.on("session-changed", (_event, info) => callback(info));
  },

  // Preferences
  relaunch: () => ipcRenderer.send("relaunch"),
  setPreference: (key: string, value: unknown) => ipcRenderer.send("set-preference", key, value),
  getPreference: (key: string, defaultVal?: unknown) => ipcRenderer.invoke("get-preference", key, defaultVal),
  onShowWelcome: (callback: () => void) => {
    ipcRenderer.on("show-welcome", () => callback());
  },
  onOpenSettings: (callback: () => void) => {
    ipcRenderer.on("open-settings", () => callback());
  },
  onFocusInput: (callback: () => void) => {
    ipcRenderer.on("focus-command-input", () => callback());
  },
  onExecCommandFromPalette: (callback: (cmd: string) => void) => {
    ipcRenderer.on("exec-command-from-palette", (_e, cmd: string) => callback(cmd));
  },

  // Apps CRUD
  appsList: () => ipcRenderer.invoke("apps-list") as Promise<Array<{
    id: string; name: string; url?: string; connected: boolean; connectedSlug?: string;
    commands: Record<string, { selector: string; action: string; description: string }>;
    meta?: { description: string; capabilities: string[] };
    forceWeb?: boolean; doNotRecord?: boolean;
    connection?: { pipedreamSlug: string; accountId?: string; healthy?: boolean };
    mcp?: { transport: "stdio" | "sse" | "streamable-http"; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string>; enabled: boolean };
  }>>,
  appsAdd: (id: string, name: string, url?: string) => ipcRenderer.invoke("apps-add", id, name, url),
  appsSetMcp: (id: string, mcp: { transport: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string; enabled: boolean }) =>
    ipcRenderer.invoke("apps-set-mcp", id, mcp),
  appsRemoveMcp: (id: string) => ipcRenderer.invoke("apps-remove-mcp", id) as Promise<boolean>,
  appsRemove: (id: string) => ipcRenderer.invoke("apps-remove", id) as Promise<boolean>,
  appsSetConnection: (id: string, pipedreamSlug: string) => ipcRenderer.invoke("apps-set-connection", id, pipedreamSlug) as Promise<boolean>,
  appsRemoveConnection: (id: string) => ipcRenderer.invoke("apps-remove-connection", id) as Promise<boolean>,
  appsUpdateId: (oldId: string, newId: string) => ipcRenderer.invoke("apps-update-id", oldId, newId) as Promise<boolean>,
  appsUpdateName: (id: string, name: string) => ipcRenderer.invoke("apps-update-name", id, name) as Promise<boolean>,
  appsUpdateUrl: (id: string, url: string) => ipcRenderer.invoke("apps-update-url", id, url) as Promise<boolean>,
  appsUpdateForceWeb: (id: string, forceWeb: boolean) => ipcRenderer.invoke("apps-update-force-web", id, forceWeb) as Promise<boolean>,
  appsUpdateDoNotRecord: (id: string, doNotRecord: boolean) => ipcRenderer.invoke("apps-update-do-not-record", id, doNotRecord) as Promise<boolean>,
  appsUpdateCapturePolicy: (id: string, policy: { type: string; maxVersions?: number; windowHours?: number; minDeltaChars?: number }) =>
    ipcRenderer.invoke("apps-update-capture-policy", id, policy) as Promise<boolean>,
  appsGetCapturePolicy: (id: string) => ipcRenderer.invoke("apps-get-capture-policy", id) as Promise<{ type: string; maxVersions?: number; windowHours?: number; minDeltaChars?: number }>,
  appsSetConnectedSlug: (id: string, slug: string | null) => ipcRenderer.invoke("apps-set-connected-slug", id, slug) as Promise<boolean>,
  appsSetCommand: (id: string, key: string, mapping: { selector: string; action: string; description: string }) =>
    ipcRenderer.invoke("apps-set-command", id, key, mapping) as Promise<boolean>,
  appsRemoveCommand: (id: string, key: string) =>
    ipcRenderer.invoke("apps-remove-command", id, key) as Promise<boolean>,
  appsTestCommand: (id: string, key: string, wcId?: number) =>
    ipcRenderer.invoke("apps-test-command", id, key, wcId) as Promise<string>,
  startPicker: (wcId: number) => ipcRenderer.send("start-picker", wcId),
  onPickerResult: (cb: (result: { selector: string; tag: string; text: string; isEditable: boolean; isClickable: boolean }) => void) => {
    ipcRenderer.on("picker-result", (_e, result) => cb(result));
  },

  // Onboarding complete — triggers panel restore
  onboardingComplete: () => ipcRenderer.invoke("onboarding-complete"),

  // App version
  getAppVersion: () => ipcRenderer.invoke("get-app-version") as Promise<string>,

  // Auth
  startAuth: (mode: "register" | "login") => ipcRenderer.invoke("start-auth", mode) as Promise<boolean>,
  isAuthenticated: () => ipcRenderer.invoke("is-authenticated") as Promise<boolean>,
  getAccountInfo: () => ipcRenderer.invoke("get-account-info") as Promise<{ email: string; firstName: string; lastName: string; role: string; orgName: string; tier: string; billingStatus: string } | null>,
  logout: () => ipcRenderer.invoke("logout") as Promise<void>,
  validateApiKey: (key: string) => ipcRenderer.invoke("validate-api-key", key) as Promise<{ valid: boolean; error?: string }>,
  getApiKey: () => ipcRenderer.invoke("get-api-key") as Promise<string | null>,
  onBoot: (callback: (data: { authenticated: boolean; status: string; tier?: string; apiKey: boolean; needsOnboarding: boolean; hideWelcome?: boolean; theme?: string }) => void) => {
    ipcRenderer.on("boot", (_event, data) => callback(data));
  },
  onThemeChanged: (callback: (theme: string) => void) => {
    ipcRenderer.on("theme-changed", (_event, theme) => callback(theme));
  },
  onSplashStatus: (callback: (msg: string) => void) => {
    ipcRenderer.on("splash-status", (_event, msg) => callback(msg));
  },
  onSplitState: (callback: (info: {
    panelIds: string[];
    cols: number;
    rows: number;
    colWidths: number[];
    rowHeights: number[];
    cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }>;
  } | null) => void) => {
    ipcRenderer.on("split-state", (_event, info) => callback(info));
  },

  // Command execution (used internally by interceptor routing)
  execCommand: (cmd: string) => ipcRenderer.invoke("exec-command", cmd) as Promise<string>,

  // Downloads
  onDownloadStart: (cb: (info: { filename: string; totalBytes: number; savePath: string }) => void) => {
    ipcRenderer.on("download:start", (_e, info) => cb(info));
  },
  onDownloadProgress: (cb: (info: { filename: string; receivedBytes: number; totalBytes: number }) => void) => {
    ipcRenderer.on("download:progress", (_e, info) => cb(info));
  },
  onDownloadDone: (cb: (info: { filename: string; savePath: string; state: string }) => void) => {
    ipcRenderer.on("download:done", (_e, info) => cb(info));
  },
  downloadShow: (filePath: string) => ipcRenderer.send("download:show", filePath),

  // Drip effects
  onDripEffect: (callback: (effect: string) => void) => {
    ipcRenderer.on("drip-effect", (_event, effect) => callback(effect));
  },

  // LLM config
  getLLMConfig: () => ipcRenderer.invoke("get-llm-config") as Promise<{ provider: string; model: string; apiKey: string; baseUrl: string | null }>,
  getLLMPresets: () => ipcRenderer.invoke("get-llm-presets") as Promise<Record<string, { name: string; models: string[]; defaultModel: string; baseUrl?: string; keyPlaceholder: string }>>,
  saveLLMConfig: (config: { provider: string; model: string; apiKey: string; baseUrl?: string }) =>
    ipcRenderer.invoke("save-llm-config", config) as Promise<{ ok: boolean; error?: string }>,

  // Tabs
  tabList: () => ipcRenderer.invoke("tab-list") as Promise<{ tabs: Array<{ id: string; name: string; favicon?: string; layoutFavicons?: string[] }>; activeId: string; visible: boolean }>,
  tabSwitch: (id: string) => ipcRenderer.send("tab-switch", id),
  tabClose: (id: string) => ipcRenderer.send("tab-close", id),
  tabReorder: (newOrder: string[]) => ipcRenderer.send("tab-reorder", newOrder),
  tabNew: () => ipcRenderer.send("tab-new"),
  tabNewApp: (appId: string) => ipcRenderer.send("tab-new-app", appId),
  onTabState: (callback: (state: { tabs: Array<{ id: string; name: string; favicon?: string; layoutFavicons?: string[] }>; activeId: string; visible: boolean }) => void) => {
    ipcRenderer.on("tab-state", (_event, state) => callback(state));
  },

  // Theme
  getTheme: () => ipcRenderer.invoke("get-theme") as Promise<string>,
  setTheme: (theme: string) => ipcRenderer.invoke("set-theme", theme),

  // Account info
  getAuthStatus: () => ipcRenderer.invoke("get-auth-status") as Promise<{ authenticated: boolean; status: string; tier?: string }>,
  refreshAuth: () => ipcRenderer.invoke("refresh-auth") as Promise<{ tier: string; status: string }>,
  openExternal: (url: string) => ipcRenderer.send("open-external", url),
  platformUrl: process.env.YO_PLATFORM_URL || "https://platform.yosup.dev",
  openAccountDashboard: () => ipcRenderer.send("open-external", (process.env.YO_PLATFORM_URL || "https://platform.yosup.dev")),
  openBilling: () => ipcRenderer.send("open-external", (process.env.YO_PLATFORM_URL || "https://platform.yosup.dev") + "/dashboard/billing"),

  // Support
  submitSupportTicket: (ticket: { subject: string; description: string }) =>
    ipcRenderer.invoke("submit-support-ticket", ticket) as Promise<{ ok: boolean; error?: string }>,

  // Voice transcription
  transcribeAudio: (audioBuffer: ArrayBuffer) =>
    ipcRenderer.invoke("transcribe-audio", audioBuffer) as Promise<{ ok: boolean; text?: string; error?: string }>,

  // Yo panel
  yoPanelOpen: (query: string) => ipcRenderer.send("yo-panel-open-from-renderer", query),
  yoPanelSend: (message: string) => ipcRenderer.send("yo-panel-send", message),
  yoPanelDismiss: () => ipcRenderer.send("yo-panel-dismiss"),
  yoPanelStop: () => ipcRenderer.send("yo-panel-stop"),
  onYoPanelOpen: (cb: (query: string) => void) => {
    ipcRenderer.on("yo-panel-open", (_e, query) => cb(query));
  },
  onYoPanelToggle: (cb: () => void) => {
    ipcRenderer.on("yo-panel-toggle", () => cb());
  },
  onYoPanelToken: (cb: (delta: string) => void) => {
    ipcRenderer.on("yo-panel-token", (_e, delta) => cb(delta));
  },
  onYoPanelToolUse: (cb: (id: string, name: string, input: unknown) => void) => {
    ipcRenderer.on("yo-panel-tool-use", (_e, id, name, input) => cb(id, name, input));
  },
  onYoPanelToolResult: (cb: (id: string, detail: string) => void) => {
    ipcRenderer.on("yo-panel-tool-result", (_e, id, detail) => cb(id, detail));
  },
  onYoPanelDone: (cb: (fullText: string) => void) => {
    ipcRenderer.on("yo-panel-done", (_e, text) => cb(text));
  },
  onYoPanelError: (cb: (err: string) => void) => {
    ipcRenderer.on("yo-panel-error", (_e, err) => cb(err));
  },
  onYoPanelClose: (cb: () => void) => {
    ipcRenderer.on("yo-panel-close", () => cb());
  },

  // Yo chat history
  yoChatsList: () => ipcRenderer.invoke("yo-chats-list") as Promise<Array<{ id: string; title: string; created: string; messageCount: number }>>,
  yoChatsLoad: (id: string) => ipcRenderer.invoke("yo-chats-load", id) as Promise<Array<{ role: string; text: string; tools?: Array<{ name: string; input?: unknown }> }> | null>,
  yoChatsDelete: (id: string) => ipcRenderer.invoke("yo-chats-delete", id) as Promise<boolean>,
  yoChatNew: () => ipcRenderer.invoke("yo-chat-new") as Promise<boolean>,

  // Agent mode + guardrails
  getAgentMode: () => ipcRenderer.invoke("get-agent-mode") as Promise<string>,
  setAgentMode: (mode: string) => ipcRenderer.send("set-agent-mode", mode),
  onAgentModeChanged: (cb: (mode: string) => void) => {
    ipcRenderer.on("agent-mode-changed", (_e, mode) => cb(mode));
  },
  getToolRegistry: () => ipcRenderer.invoke("get-tool-registry") as Promise<Array<{ name: string; label: string; description: string; tier: string; override: string }>>,
  setToolOverride: (toolName: string, override: string) => ipcRenderer.send("set-tool-override", toolName, override),
  onApprovalRequest: (cb: (id: string, toolName: string, toolLabel: string, input: unknown) => void) => {
    ipcRenderer.on("approval-request", (_e, id, toolName, toolLabel, input) => cb(id, toolName, toolLabel, input));
  },
  approvalRespond: (id: string, approved: boolean) => ipcRenderer.send("approval-respond", id, approved),

  // URL bar
  urlBarNavigate: (url: string) => ipcRenderer.send("url-bar-navigate", url),
  urlBarBack: () => ipcRenderer.send("url-bar-back"),
  urlBarForward: () => ipcRenderer.send("url-bar-forward"),
  urlBarRefresh: () => ipcRenderer.send("url-bar-refresh"),
  panelNavBack: (panelId: string) => ipcRenderer.send("panel-nav-back", panelId),
  panelNavForward: (panelId: string) => ipcRenderer.send("panel-nav-forward", panelId),
  panelNavRefresh: (panelId: string) => ipcRenderer.send("panel-nav-refresh", panelId),
  panelNavTo: (panelId: string, url: string) => ipcRenderer.send("panel-nav-to", panelId, url),
  urlBarToggle: (show: boolean) => ipcRenderer.send("url-bar-toggle", show),
  onUrlUpdate: (cb: (info: { url: string; favicon: string }) => void) => {
    ipcRenderer.on("url-update", (_e, info) => cb(info));
  },
  onTabFavicon: (cb: (info: { id: string; favicon: string }) => void) => {
    ipcRenderer.on("tab-favicon", (_e, info) => cb(info));
  },
  onPanelUrlUpdate: (cb: (info: { id: string; url: string; favicon: string }) => void) => {
    ipcRenderer.on("panel-url-update", (_e, info) => cb(info));
  },

  // Yo panel resize
  yoPanelResize: (width: number) => ipcRenderer.send("yo-panel-resize", width),
  yoPanelWidthSave: (width: number) => ipcRenderer.send("yo-panel-width-save", width),
  yoPanelGetWidth: () => ipcRenderer.invoke("yo-panel-get-width") as Promise<number>,

  // Connectors (Pipedream OAuth)
  connectorsGetApps: (search?: string, offset?: number) => ipcRenderer.invoke("connectors-get-apps", search, offset) as Promise<{ apps: Array<{ id: string; name: string; description: string; icon?: string }>; hasMore: boolean }>,
  connectorsGetAccounts: () => ipcRenderer.invoke("connectors-get-accounts") as Promise<Array<{ id: string; appSlug: string; appName: string; createdAt: string; healthy: boolean }>>,
  connectorsConnect: (appSlug: string) => ipcRenderer.invoke("connectors-connect", appSlug) as Promise<{ ok: boolean; error?: string }>,
  connectorsDisconnect: (accountId: string) => ipcRenderer.invoke("connectors-disconnect", accountId) as Promise<boolean>,
  connectorsRefreshMcp: () => ipcRenderer.invoke("connectors-refresh-mcp") as Promise<{ ok: boolean; error?: string; toolCount: number }>,
  onConnectorsChanged: (cb: () => void) => { ipcRenderer.on("connectors-changed", cb); },

  // Auto-update
  onUpdateStatus: (cb: (info: { status: string; version?: string; percent?: number }) => void) => {
    ipcRenderer.on("update-status", (_e, info) => cb(info));
  },
  updateInstall: () => ipcRenderer.send("update-install"),
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates") as Promise<string | null>,

  // MCP Expose (pro feature — read-only capture store server)
  mcpExposeStart: () => ipcRenderer.invoke("mcp-expose-start") as Promise<{ ok: boolean; error?: string }>,
  mcpExposeStop: () => ipcRenderer.invoke("mcp-expose-stop") as Promise<void>,
  mcpExposeStatus: () => ipcRenderer.invoke("mcp-expose-status") as Promise<{ running: boolean; port: number }>,
  mcpExposeGetTokens: () => ipcRenderer.invoke("mcp-expose-get-tokens") as Promise<Array<{ token: string; label: string; createdAt: string; expiresAt: string }>>,
  mcpExposeGenToken: (label: string) => ipcRenderer.invoke("mcp-expose-gen-token", label) as Promise<{ token: string; label: string; createdAt: string; expiresAt: string }>,
  mcpExposeRevokeToken: (token: string) => ipcRenderer.invoke("mcp-expose-revoke-token", token) as Promise<void>,

  // MCP Servers (custom user-configured servers — Advanced plan)
  mcpGetServers: () => ipcRenderer.invoke("mcp-get-servers") as Promise<Array<{ config: { id: string; name: string; transport: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string; enabled: boolean }; status: string; error?: string; tools: Array<{ name: string; description?: string }> }>>,
  mcpAddServer: (config: Record<string, unknown>) => ipcRenderer.invoke("mcp-add-server", config) as Promise<void>,
  mcpUpdateServer: (id: string, updates: Record<string, unknown>) => ipcRenderer.invoke("mcp-update-server", id, updates) as Promise<void>,
  mcpRemoveServer: (id: string) => ipcRenderer.invoke("mcp-remove-server", id) as Promise<void>,
  mcpConnectServer: (id: string) => ipcRenderer.invoke("mcp-connect-server", id) as Promise<{ ok: boolean; error?: string }>,
  mcpDisconnectServer: (id: string) => ipcRenderer.invoke("mcp-disconnect-server", id) as Promise<void>,
  mcpGetToolOverride: (serverId: string, toolName: string) => ipcRenderer.invoke("mcp-get-tool-override", serverId, toolName) as Promise<string>,
  mcpSetToolOverride: (serverId: string, toolName: string, override: string) => ipcRenderer.send("mcp-set-tool-override", serverId, toolName, override),
  mcpSetServerOverride: (serverId: string, override: string) => ipcRenderer.send("mcp-set-server-override", serverId, override),
  onMcpChanged: (cb: () => void) => {
    ipcRenderer.on("mcp-changed", () => cb());
  },
});
