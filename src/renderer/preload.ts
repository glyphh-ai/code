/**
 * Preload script — exposes IPC to the renderer safely.
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("yo", {
  command: (input: string) => ipcRenderer.send("command", input),
  onResult: (callback: (result: string) => void) => {
    ipcRenderer.on("command-result", (_event, result: string) => {
      callback(result);
    });
  },
  windowClose: () => ipcRenderer.send("window-close"),
  windowMinimize: () => ipcRenderer.send("window-minimize"),
  windowMaximize: () => ipcRenderer.send("window-maximize"),

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

  // Panels
  panelsList: () => ipcRenderer.invoke("panels-list") as Promise<Array<{ id: string; name: string; url: string }>>,
  panelsAdd: (id: string, url: string) => ipcRenderer.invoke("panels-add", id, url) as Promise<boolean>,

  // Layouts CRUD
  layoutsList: () => ipcRenderer.invoke("layouts-list") as Promise<Array<{ name: string; splits: Array<{ panelId: string }> }>>,
  layoutsSave: (name: string, panelIds: string[]) => ipcRenderer.invoke("layouts-save", name, panelIds) as Promise<boolean>,
  layoutsSaveGrid: (grid: { name: string; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }> }) =>
    ipcRenderer.invoke("layouts-save-grid", grid) as Promise<boolean>,
  layoutsDelete: (name: string) => ipcRenderer.invoke("layouts-delete", name) as Promise<boolean>,

  // Autocomplete data
  getCompletions: () => ipcRenderer.invoke("get-completions") as Promise<{
    panels: string[];
    library: string[];
    skills: string[];
    layouts: string[];
  }>,

  // Grid resize + swap
  splitDragStart: () => ipcRenderer.send("split-drag-start"),
  splitDragMove: (ratio: number) => ipcRenderer.send("split-drag-move", ratio),
  splitDragEnd: (ratio: number) => ipcRenderer.send("split-drag-end", ratio),
  gridDragEnd: (type: "col" | "row", index: number, fraction: number) =>
    ipcRenderer.send("grid-drag-end", type, index, fraction),
  splitSwap: (index: number, panelId: string) => ipcRenderer.send("split-swap", index, panelId),

  // Preferences
  setPreference: (key: string, value: unknown) => ipcRenderer.send("set-preference", key, value),
  onShowWelcome: (callback: () => void) => {
    ipcRenderer.on("show-welcome", () => callback());
  },

  // License + API key
  checkLicense: () => ipcRenderer.invoke("check-license"),
  activateLicense: (key: string) => ipcRenderer.invoke("activate-license", key) as Promise<boolean>,
  validateApiKey: (key: string) => ipcRenderer.invoke("validate-api-key", key) as Promise<{ valid: boolean; error?: string }>,
  getApiKey: () => ipcRenderer.invoke("get-api-key") as Promise<string | null>,
  onBoot: (callback: (data: { license: { status: string; daysRemaining?: number }; apiKey: boolean; needsOnboarding: boolean }) => void) => {
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
  onSplitDragPreview: (callback: (ratio: number) => void) => {
    ipcRenderer.on("split-drag-preview", (_event, ratio) => callback(ratio));
  },
});
