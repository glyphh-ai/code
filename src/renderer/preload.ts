/**
 * Preload script — exposes IPC to the renderer safely.
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("yo", {
  windowClose: () => ipcRenderer.send("window-close"),
  windowMinimize: () => ipcRenderer.send("window-minimize"),
  windowMaximize: () => ipcRenderer.send("window-maximize"),

  // Active context
  onContextUpdate: (callback: (ctx: { name: string } | null) => void) => {
    ipcRenderer.on("context-update", (_event, ctx) => callback(ctx));
  },
  contextClear: () => ipcRenderer.send("context-clear"),

  // Panel visibility + refresh
  panelsHide: () => ipcRenderer.send("panels-hide"),
  panelsShow: () => ipcRenderer.send("panels-show"),
  panelsRefresh: (id?: string) => ipcRenderer.send("panels-refresh", id),
  panelsZoom: (factor: number) => ipcRenderer.send("panels-zoom", factor),
  panelsGetZoom: () => ipcRenderer.invoke("panels-get-zoom") as Promise<number>,

  // Library CRUD
  libraryList: () => ipcRenderer.invoke("library-list") as Promise<string[]>,
  libraryRead: (name: string) => ipcRenderer.invoke("library-read", name) as Promise<string | null>,
  libraryWrite: (name: string, content: string) => ipcRenderer.invoke("library-write", name, content) as Promise<boolean>,
  libraryRemove: (name: string) => ipcRenderer.invoke("library-remove", name) as Promise<boolean>,

  // Skills CRUD
  skillsList: () => ipcRenderer.invoke("skills-list") as Promise<string[]>,
  skillsRead: (name: string) => ipcRenderer.invoke("skills-read", name) as Promise<string | null>,
  skillsWrite: (name: string, prompt: string) => ipcRenderer.invoke("skills-write", name, prompt) as Promise<boolean>,
  skillsRemove: (name: string) => ipcRenderer.invoke("skills-remove", name) as Promise<boolean>,

  // Layouts CRUD
  layoutsList: () => ipcRenderer.invoke("layouts-list") as Promise<Array<{ name: string; splits: Array<{ panelId: string }> }>>,
  layoutsSave: (name: string, panelIds: string[]) => ipcRenderer.invoke("layouts-save", name, panelIds) as Promise<boolean>,
  layoutsSaveGrid: (grid: { name: string; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }> }) =>
    ipcRenderer.invoke("layouts-save-grid", grid) as Promise<boolean>,
  layoutsDelete: (name: string) => ipcRenderer.invoke("layouts-delete", name) as Promise<boolean>,

  // Grid resize
  gridDragEnd: (type: "col" | "row", index: number, fraction: number) =>
    ipcRenderer.send("grid-drag-end", type, index, fraction),

  // Preferences
  setPreference: (key: string, value: unknown) => ipcRenderer.send("set-preference", key, value),
  onShowWelcome: (callback: () => void) => {
    ipcRenderer.on("show-welcome", () => callback());
  },

  // Apps CRUD
  appsList: () => ipcRenderer.invoke("apps-list") as Promise<Array<{ id: string; name: string; url: string; connected: boolean; commands: Record<string, { selector: string; action: string; description: string }>; meta?: { description: string; capabilities: string[] } }>>,
  appsAdd: (id: string, name: string, url: string) => ipcRenderer.invoke("apps-add", id, name, url),
  appsRemove: (id: string) => ipcRenderer.invoke("apps-remove", id) as Promise<boolean>,
  appsUpdateName: (id: string, name: string) => ipcRenderer.invoke("apps-update-name", id, name) as Promise<boolean>,
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

  // License + API key
  checkLicense: () => ipcRenderer.invoke("check-license"),
  activateLicense: (key: string) => ipcRenderer.invoke("activate-license", key) as Promise<boolean>,
  validateApiKey: (key: string) => ipcRenderer.invoke("validate-api-key", key) as Promise<{ valid: boolean; error?: string }>,
  getApiKey: () => ipcRenderer.invoke("get-api-key") as Promise<string | null>,
  onBoot: (callback: (data: { license: { status: string; daysRemaining?: number }; apiKey: boolean; needsOnboarding: boolean; hideWelcome?: boolean }) => void) => {
    ipcRenderer.on("boot", (_event, data) => callback(data));
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

  // Command bar
  execCommand: (cmd: string) => ipcRenderer.invoke("exec-command", cmd) as Promise<string>,
  getCompletions: () => ipcRenderer.invoke("get-completions") as Promise<{ apps: string[]; library: string[]; skills: string[]; layouts: string[] }>,
});
