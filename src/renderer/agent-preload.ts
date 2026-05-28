import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("agent", {
  ensureDefault: () => ipcRenderer.invoke("agent:ensure-default"),
  start: (opts: { instanceId: string; agentSlug: string; cwd: string }) =>
    ipcRenderer.invoke("agent:start", opts),
  send: (instanceId: string, message: string, model: string, perm: string) =>
    ipcRenderer.invoke("agent:send", instanceId, message, model, perm),
  stop: (instanceId: string) => ipcRenderer.invoke("agent:stop", instanceId),
  clear: (instanceId: string) => ipcRenderer.invoke("agent:clear", instanceId),
  dispose: (instanceId: string) => ipcRenderer.invoke("agent:dispose", instanceId),

  getCwd: () => ipcRenderer.invoke("working-dir:get"),
  pickCwd: () => ipcRenderer.invoke("working-dir:pick"),

  /** Generic event subscription — used for agent:<id>:* channels. */
  onEvent: (channel: string, cb: (...args: unknown[]) => void) => {
    ipcRenderer.on(channel, (_e, ...args) => cb(...args));
  },

  getTheme: () => ipcRenderer.invoke("get-theme"),
  onThemeChanged: (cb: (theme: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, theme: string) => cb(theme);
    ipcRenderer.on("theme-changed", handler);
    return () => { ipcRenderer.removeListener("theme-changed", handler); };
  },
});
