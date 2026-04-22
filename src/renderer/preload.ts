/**
 * Preload script — exposes IPC to the renderer safely.
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("yo", {
  windowClose: () => ipcRenderer.send("window-close"),
  windowMinimize: () => ipcRenderer.send("window-minimize"),
  windowMaximize: () => ipcRenderer.send("window-maximize"),

  // Panel visibility + refresh
  panelsHide: () => ipcRenderer.send("panels-hide"),
  panelsShow: () => ipcRenderer.send("panels-show"),
  cmdPaletteOpen: () => ipcRenderer.send("cmd-palette-open"),
  cmdPaletteClose: () => ipcRenderer.send("cmd-palette-close"),
  capturePanels: () => ipcRenderer.invoke("capture-panels") as Promise<Array<{ dataUrl: string; bounds: { x: number; y: number; width: number; height: number } }>>,
  panelsRefresh: (id?: string) => ipcRenderer.send("panels-refresh", id),
  panelsZoom: (factor: number) => ipcRenderer.send("panels-zoom", factor),
  panelsGetZoom: () => ipcRenderer.invoke("panels-get-zoom") as Promise<number>,

  // Skills CRUD
  skillsList: () => ipcRenderer.invoke("skills-list") as Promise<string[]>,
  skillsRead: (name: string) => ipcRenderer.invoke("skills-read", name) as Promise<string | null>,
  skillsWrite: (name: string, prompt: string) => ipcRenderer.invoke("skills-write", name, prompt) as Promise<boolean>,
  skillsRemove: (name: string) => ipcRenderer.invoke("skills-remove", name) as Promise<boolean>,
  skillsGenerate: (name: string, description: string) => ipcRenderer.invoke("skills-generate", name, description) as Promise<string>,

  // Layouts CRUD
  layoutsList: () => ipcRenderer.invoke("layouts-list") as Promise<Array<{ name: string; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; splits: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }> }>>,
  layoutsSave: (name: string, panelIds: string[]) => ipcRenderer.invoke("layouts-save", name, panelIds) as Promise<boolean>,
  layoutsSaveGrid: (grid: { name: string; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }> }) =>
    ipcRenderer.invoke("layouts-save-grid", grid) as Promise<boolean>,
  layoutsDelete: (name: string) => ipcRenderer.invoke("layouts-delete", name) as Promise<boolean>,

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
  onOpenCmdPalette: (callback: () => void) => {
    ipcRenderer.on("open-cmd-palette", () => callback());
  },
  onExecCommandFromPalette: (callback: (cmd: string) => void) => {
    ipcRenderer.on("exec-command-from-palette", (_e, cmd: string) => callback(cmd));
  },

  // Apps CRUD
  appsList: () => ipcRenderer.invoke("apps-list") as Promise<Array<{ id: string; name: string; url: string; connected: boolean; connectedSlug?: string; commands: Record<string, { selector: string; action: string; description: string }>; meta?: { description: string; capabilities: string[] } }>>,
  appsAdd: (id: string, name: string, url: string) => ipcRenderer.invoke("apps-add", id, name, url),
  appsRemove: (id: string) => ipcRenderer.invoke("apps-remove", id) as Promise<boolean>,
  appsUpdateId: (oldId: string, newId: string) => ipcRenderer.invoke("apps-update-id", oldId, newId) as Promise<boolean>,
  appsUpdateName: (id: string, name: string) => ipcRenderer.invoke("apps-update-name", id, name) as Promise<boolean>,
  appsUpdateUrl: (id: string, url: string) => ipcRenderer.invoke("apps-update-url", id, url) as Promise<boolean>,
  appsUpdateForceWeb: (id: string, forceWeb: boolean) => ipcRenderer.invoke("apps-update-force-web", id, forceWeb) as Promise<boolean>,
  appsUpdateDoNotRecord: (id: string, doNotRecord: boolean) => ipcRenderer.invoke("apps-update-do-not-record", id, doNotRecord) as Promise<boolean>,
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
  onBoot: (callback: (data: { authenticated: boolean; status: string; tier?: string; daysRemaining?: number; apiKey: boolean; needsOnboarding: boolean; hideWelcome?: boolean }) => void) => {
    ipcRenderer.on("boot", (_event, data) => callback(data));
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
  tabNew: () => ipcRenderer.send("tab-new"),
  onTabState: (callback: (state: { tabs: Array<{ id: string; name: string; favicon?: string; layoutFavicons?: string[] }>; activeId: string; visible: boolean }) => void) => {
    ipcRenderer.on("tab-state", (_event, state) => callback(state));
  },

  // Account info
  getAuthStatus: () => ipcRenderer.invoke("get-auth-status") as Promise<{ authenticated: boolean; status: string; tier?: string; daysRemaining?: number }>,
  openExternal: (url: string) => ipcRenderer.send("open-external", url),
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

  // Connectors (removed — stubs for renderer compat)
  connectorsGetApps: () => Promise.resolve({ apps: [], hasMore: false }),
  connectorsGetAccounts: () => Promise.resolve([]),
  connectorsConnect: () => Promise.resolve({ ok: false, error: "Connectors removed" }),
  connectorsDisconnect: () => Promise.resolve(false),
  connectorsRefreshMcp: () => Promise.resolve(false),
  onConnectorsChanged: () => {},

  // Auto-update
  onUpdateStatus: (cb: (info: { status: string; version?: string; percent?: number }) => void) => {
    ipcRenderer.on("update-status", (_e, info) => cb(info));
  },
  updateInstall: () => ipcRenderer.send("update-install"),

  // MCP Expose (pro feature — read-only capture store server)
  mcpExposeStart: () => ipcRenderer.invoke("mcp-expose-start") as Promise<{ ok: boolean; error?: string }>,
  mcpExposeStop: () => ipcRenderer.invoke("mcp-expose-stop") as Promise<void>,
  mcpExposeStatus: () => ipcRenderer.invoke("mcp-expose-status") as Promise<{ running: boolean; port: number }>,
  mcpExposeGetTokens: () => ipcRenderer.invoke("mcp-expose-get-tokens") as Promise<Array<{ token: string; label: string; createdAt: string; expiresAt: string }>>,
  mcpExposeGenToken: (label: string) => ipcRenderer.invoke("mcp-expose-gen-token", label) as Promise<{ token: string; label: string; createdAt: string; expiresAt: string }>,
  mcpExposeRevokeToken: (token: string) => ipcRenderer.invoke("mcp-expose-revoke-token", token) as Promise<void>,
});
