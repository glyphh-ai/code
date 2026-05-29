/**
 * plan-preload.ts — IPC bridge for the yo://plan panel.
 *
 * Same workdir + git shape as agent/workbench preloads, plus the file
 * read/write the .yo/plan/<phase>.md scratchpad needs.
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("plan", {
  getCwd: () => ipcRenderer.invoke("working-dir:get"),
  pickCwd: () => ipcRenderer.invoke("working-dir:pick"),
  setCwd: (dir: string) => ipcRenderer.invoke("working-dir:set", dir),
  getCwdRecents: () => ipcRenderer.invoke("working-dir:recents"),
  gitInfo: (root: string) => ipcRenderer.invoke("files:git-info", root),
  onCwdChanged: (cb: (dir: string | null) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, dir: string | null) => cb(dir);
    ipcRenderer.on("working-dir-changed", handler);
    return () => { ipcRenderer.removeListener("working-dir-changed", handler); };
  },
  onFileChanged: (cb: (absPath: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, abs: string) => cb(abs);
    ipcRenderer.on("workdir:file-changed", handler);
    return () => { ipcRenderer.removeListener("workdir:file-changed", handler); };
  },

  readFile: (filePath: string) =>
    ipcRenderer.invoke("files:read-file", filePath) as Promise<{ content: string; error?: string }>,
  writeFile: (filePath: string, content: string) =>
    ipcRenderer.invoke("files:write-file", filePath, content) as Promise<{ ok: boolean; error?: string }>,

  getTheme: () => ipcRenderer.invoke("get-theme"),
  onThemeChanged: (cb: (theme: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, theme: string) => cb(theme);
    ipcRenderer.on("theme-changed", handler);
    return () => { ipcRenderer.removeListener("theme-changed", handler); };
  },
});
