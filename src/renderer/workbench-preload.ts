/**
 * workbench-preload.ts — IPC bridge for the yo://workbench panel.
 *
 * Same workdir + git shape as agent-preload, plus the lazy file-tree and
 * git-diff readers the Files / Diff slots need.
 */

import { contextBridge, ipcRenderer } from "electron";

type FileEntry = { name: string; path: string; kind: "dir" | "file" };

contextBridge.exposeInMainWorld("wb", {
  // Workdir + recents + git — shared with the Agent app.
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

  // Workbench-specific: lazy file tree + file reader + diff.
  listDir: (dir: string) =>
    ipcRenderer.invoke("files:list-dir", dir) as Promise<{ entries: FileEntry[]; error?: string }>,
  readFile: (filePath: string) =>
    ipcRenderer.invoke("files:read-file", filePath) as Promise<{ content: string; error?: string }>,
  gitDiff: (root: string) =>
    ipcRenderer.invoke("files:git-diff", root) as Promise<{ text: string; error?: string }>,

  getTheme: () => ipcRenderer.invoke("get-theme"),
  onThemeChanged: (cb: (theme: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, theme: string) => cb(theme);
    ipcRenderer.on("theme-changed", handler);
    return () => { ipcRenderer.removeListener("theme-changed", handler); };
  },
});
