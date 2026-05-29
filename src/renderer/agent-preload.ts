import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("agent", {
  ensureDefault: () => ipcRenderer.invoke("agent:ensure-default"),
  getKind: (slug: string) =>
    ipcRenderer.invoke("agent:get-kind", slug) as Promise<{ kind: "standard" | "spec" | "vibe" }>,
  setKind: (slug: string, kind: "standard" | "spec" | "vibe") =>
    ipcRenderer.invoke("agent:set-kind", slug, kind) as Promise<{ ok: boolean; error?: string }>,
  start: (opts: { instanceId: string; agentSlug: string; cwd: string }) =>
    ipcRenderer.invoke("agent:start", opts),
  send: (instanceId: string, message: string, model: string, perm: string) =>
    ipcRenderer.invoke("agent:send", instanceId, message, model, perm),
  stop: (instanceId: string) => ipcRenderer.invoke("agent:stop", instanceId),
  clear: (instanceId: string) => ipcRenderer.invoke("agent:clear", instanceId),
  dispose: (instanceId: string) => ipcRenderer.invoke("agent:dispose", instanceId),
  rebind: (instanceId: string, cwd: string) => ipcRenderer.invoke("agent:rebind", instanceId, cwd),
  /** Resolve a pending multi-choice ask. `value` is the picked option's
   *  value, or null when the user cancelled. */
  askResolve: (instanceId: string, askId: string, value: string | null) =>
    ipcRenderer.send("agent:ask-resolve", instanceId, askId, value),

  getCwd: () => ipcRenderer.invoke("working-dir:get"),
  pickCwd: () => ipcRenderer.invoke("working-dir:pick"),
  setCwd: (dir: string) => ipcRenderer.invoke("working-dir:set", dir),
  getCwdRecents: () => ipcRenderer.invoke("working-dir:recents"),
  gitInfo: (root: string) => ipcRenderer.invoke("files:git-info", root),
  gitBranches: (root: string) => ipcRenderer.invoke("files:git-branches", root),
  gitCheckout: (root: string, branch: string) => ipcRenderer.invoke("files:git-checkout", root, branch),
  onCwdChanged: (cb: (dir: string | null) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, dir: string | null) => cb(dir);
    ipcRenderer.on("working-dir-changed", handler);
    return () => { ipcRenderer.removeListener("working-dir-changed", handler); };
  },

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
