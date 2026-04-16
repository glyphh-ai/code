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
  capturePanels: () => ipcRenderer.invoke("capture-panels") as Promise<Array<{ dataUrl: string; bounds: { x: number; y: number; width: number; height: number } }>>,
  panelsRefresh: (id?: string) => ipcRenderer.send("panels-refresh", id),
  panelsZoom: (factor: number) => ipcRenderer.send("panels-zoom", factor),
  panelsGetZoom: () => ipcRenderer.invoke("panels-get-zoom") as Promise<number>,

  // Ambient context capture
  captureContext: (panelId?: string) => ipcRenderer.invoke("capture-context", panelId) as Promise<number>,

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

  // Apps CRUD
  appsList: () => ipcRenderer.invoke("apps-list") as Promise<Array<{ id: string; name: string; url: string; connected: boolean; commands: Record<string, { selector: string; action: string; description: string }>; meta?: { description: string; capabilities: string[] } }>>,
  appsAdd: (id: string, name: string, url: string) => ipcRenderer.invoke("apps-add", id, name, url),
  appsRemove: (id: string) => ipcRenderer.invoke("apps-remove", id) as Promise<boolean>,
  appsUpdateName: (id: string, name: string) => ipcRenderer.invoke("apps-update-name", id, name) as Promise<boolean>,
  appsUpdateId: (oldId: string, newId: string) => ipcRenderer.invoke("apps-update-id", oldId, newId) as Promise<boolean>,
  appsConnect: (id: string, webContentsId?: number) =>
    ipcRenderer.invoke("apps-connect", id, webContentsId) as Promise<{ ok: boolean; error?: string; commandCount?: number }>,
  appsSetCommand: (id: string, commandKey: string, mapping: { selector: string; action: string; description: string; script?: string }) =>
    ipcRenderer.invoke("apps-set-command", id, commandKey, mapping) as Promise<boolean>,
  appsRemoveCommand: (id: string, commandKey: string) =>
    ipcRenderer.invoke("apps-remove-command", id, commandKey) as Promise<boolean>,
  appsTestCommand: (id: string, commandKey: string, webContentsId?: number) =>
    ipcRenderer.invoke("apps-test-command", id, commandKey, webContentsId) as Promise<string>,

  // Onboarding complete — triggers panel restore
  onboardingComplete: () => ipcRenderer.invoke("onboarding-complete"),

  // DOM picker — start picker on a webContents, result comes back via onPickerResult
  startPicker: (webContentsId: number) => ipcRenderer.send("start-picker", webContentsId),
  onPickerResult: (callback: (result: unknown) => void) => {
    ipcRenderer.once("picker-result", (_event, result) => callback(result));
  },

  // MCP API keys
  mcpKeysCreate: (label: string, duration: string) =>
    ipcRenderer.invoke("mcp-keys-create", label, duration) as Promise<{ ok: boolean; token?: string; label?: string; expiresAt?: string | null; error?: string }>,
  mcpKeysList: () =>
    ipcRenderer.invoke("mcp-keys-list") as Promise<{ ok: boolean; keys?: Array<{ token: string; tokenFull: string; label: string; createdAt: string; expiresAt: string | null }>; error?: string }>,
  mcpKeysRevoke: (token: string) =>
    ipcRenderer.invoke("mcp-keys-revoke", token) as Promise<{ ok: boolean; revoked?: boolean; error?: string }>,

  // License + API key
  checkLicense: () => ipcRenderer.invoke("check-license"),
  activateLicense: (key: string) => ipcRenderer.invoke("activate-license", key) as Promise<boolean>,
  validateApiKey: (key: string) => ipcRenderer.invoke("validate-api-key", key) as Promise<{ valid: boolean; error?: string }>,
  getApiKey: () => ipcRenderer.invoke("get-api-key") as Promise<string | null>,
  buyLicense: () => ipcRenderer.invoke("get-checkout-url") as Promise<string | null>,
  onBoot: (callback: (data: { license: { status: string; daysRemaining?: number }; apiKey: boolean; needsOnboarding: boolean; hideWelcome?: boolean }) => void) => {
    ipcRenderer.on("boot", (_event, data) => callback(data));
  },
  onEmbedderStatus: (callback: (status: { state: string; progress?: number; message?: string }) => void) => {
    ipcRenderer.on("embedder-status", (_event, status) => callback(status));
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
  tabList: () => ipcRenderer.invoke("tab-list") as Promise<{ tabs: Array<{ id: string; name: string }>; activeId: string; visible: boolean }>,
  tabSwitch: (id: string) => ipcRenderer.send("tab-switch", id),
  tabClose: (id: string) => ipcRenderer.send("tab-close", id),
  tabNew: () => ipcRenderer.send("tab-new"),
  onTabState: (callback: (state: { tabs: Array<{ id: string; name: string }>; activeId: string; visible: boolean }) => void) => {
    ipcRenderer.on("tab-state", (_event, state) => callback(state));
  },

  // License info
  getLicenseInfo: () => ipcRenderer.invoke("get-license-info") as Promise<{ status: string; key?: string; tier?: string; daysRemaining?: number }>,
  getCheckoutUrlForPlan: (plan: string) => ipcRenderer.invoke("get-checkout-url", plan) as Promise<string | null>,
  getBillingPortalUrl: () => ipcRenderer.invoke("get-billing-portal-url") as Promise<string | null>,
  openExternal: (url: string) => ipcRenderer.send("open-external", url),

  // Support
  submitSupportTicket: (ticket: { subject: string; description: string }) =>
    ipcRenderer.invoke("submit-support-ticket", ticket) as Promise<{ ok: boolean; error?: string }>,
});
