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

  // Workbench terminal — per-id pty bridge.
  termSpawn: (termId: string, cwd: string, cols: number, rows: number) =>
    ipcRenderer.send("wb-term:spawn", termId, cwd, cols, rows),
  termWrite: (termId: string, data: string) => ipcRenderer.send("wb-term:write", termId, data),
  termResize: (termId: string, cols: number, rows: number) =>
    ipcRenderer.send("wb-term:resize", termId, cols, rows),
  termKill: (termId: string) => ipcRenderer.send("wb-term:kill", termId),
  termOnData: (termId: string, cb: (data: string) => void) => {
    const channel = `wb-term:data:${termId}`;
    const handler = (_e: Electron.IpcRendererEvent, data: string) => cb(data);
    ipcRenderer.on(channel, handler);
    return () => { ipcRenderer.removeListener(channel, handler); };
  },
  termOnExit: (termId: string, cb: (code: number) => void) => {
    const channel = `wb-term:exit:${termId}`;
    const handler = (_e: Electron.IpcRendererEvent, code: number) => cb(code);
    ipcRenderer.on(channel, handler);
    return () => { ipcRenderer.removeListener(channel, handler); };
  },

  getTheme: () => ipcRenderer.invoke("get-theme"),
  onThemeChanged: (cb: (theme: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, theme: string) => cb(theme);
    ipcRenderer.on("theme-changed", handler);
    return () => { ipcRenderer.removeListener("theme-changed", handler); };
  },
});
