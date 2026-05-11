import { contextBridge, ipcRenderer } from "electron";

interface WazAPI {
  getContext: () => Promise<{ id: string; prompt: string }>;
  send: (message: string) => void;
  stop: () => void;
  close: () => void;
  minimize: () => void;

  onToken: (cb: (delta: string) => void) => () => void;
  onToolUse: (cb: (id: string, name: string, input: unknown) => void) => () => void;
  onToolResult: (cb: (id: string, detail: string) => void) => () => void;
  onToolProgress: (cb: (id: string, status: string) => void) => () => void;
  onDone: (cb: (fullText: string) => void) => () => void;
  onError: (cb: (error: string) => void) => () => void;

  onApprovalRequest: (cb: (id: string, toolName: string, toolLabel: string, input: unknown) => void) => () => void;
  approvalRespond: (id: string, approved: boolean) => void;
  setMode: (mode: string) => void;
  getMode: () => Promise<string>;

  getTheme: () => Promise<string>;
  onThemeChanged: (cb: (theme: string) => void) => () => void;
}

const api: WazAPI = {
  getContext: () => ipcRenderer.invoke("waz-context"),
  send: (message) => ipcRenderer.send("waz-send", message),
  stop: () => ipcRenderer.send("waz-stop"),
  close: () => ipcRenderer.send("waz-close"),
  minimize: () => ipcRenderer.send("waz-minimize"),

  onToken: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, delta: string) => cb(delta);
    ipcRenderer.on("waz-token", handler);
    return () => { ipcRenderer.removeListener("waz-token", handler); };
  },
  onToolUse: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, id: string, name: string, input: unknown) => cb(id, name, input);
    ipcRenderer.on("waz-tool-use", handler);
    return () => { ipcRenderer.removeListener("waz-tool-use", handler); };
  },
  onToolResult: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, id: string, detail: string) => cb(id, detail);
    ipcRenderer.on("waz-tool-result", handler);
    return () => { ipcRenderer.removeListener("waz-tool-result", handler); };
  },
  onToolProgress: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, id: string, status: string) => cb(id, status);
    ipcRenderer.on("waz-tool-progress", handler);
    return () => { ipcRenderer.removeListener("waz-tool-progress", handler); };
  },
  onDone: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, fullText: string) => cb(fullText);
    ipcRenderer.on("waz-done", handler);
    return () => { ipcRenderer.removeListener("waz-done", handler); };
  },
  onError: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, error: string) => cb(error);
    ipcRenderer.on("waz-error", handler);
    return () => { ipcRenderer.removeListener("waz-error", handler); };
  },

  onApprovalRequest: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, id: string, toolName: string, toolLabel: string, input: unknown) =>
      cb(id, toolName, toolLabel, input);
    ipcRenderer.on("waz-approval-request", handler);
    return () => { ipcRenderer.removeListener("waz-approval-request", handler); };
  },
  approvalRespond: (id, approved) => ipcRenderer.send("waz-approval-respond", id, approved),
  setMode: (mode) => ipcRenderer.send("waz-set-mode", mode),
  getMode: () => ipcRenderer.invoke("waz-get-mode") as Promise<string>,

  getTheme: () => ipcRenderer.invoke("get-theme") as Promise<string>,
  onThemeChanged: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, theme: string) => cb(theme);
    ipcRenderer.on("theme-changed", handler);
    return () => { ipcRenderer.removeListener("theme-changed", handler); };
  },
};

contextBridge.exposeInMainWorld("waz", api);
