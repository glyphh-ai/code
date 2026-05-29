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
  onFileChanged: (cb: (absPath: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, abs: string) => cb(abs);
    ipcRenderer.on("workdir:file-changed", handler);
    return () => { ipcRenderer.removeListener("workdir:file-changed", handler); };
  },
  /** Sub-agent lifecycle events from any agent surface in the app. The
   *  Workbench's Sub-Agents view subscribes to drive a per-agent ChatRenderer
   *  (the same one the main yo panel uses) so the output stream looks identical:
   *  collapsible tool widgets, braille spinner, markdown text. Cases:
   *    - { kind: "spawn",       id, source, name, description? }
   *    - { kind: "text",        id, text }            (alias: "token")
   *    - { kind: "tool",        id, toolId, toolName, toolInput }
   *    - { kind: "tool_result", id, toolId, toolOutput }
   *    - { kind: "result",      id, text? }
   *    - { kind: "error",       id, text? } */
  onSubAgentEvent: (cb: (evt: {
    id: string;
    kind: "spawn" | "text" | "token" | "tool" | "tool_result" | "result" | "error";
    source?: "task" | "yo-agent";
    name?: string;
    description?: string;
    text?: string;
    toolId?: string;
    toolName?: string;
    toolInput?: unknown;
    toolOutput?: string;
  }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, evt: any) => cb(evt);
    ipcRenderer.on("subagent:event", handler);
    return () => { ipcRenderer.removeListener("subagent:event", handler); };
  },

  // Workbench-specific: lazy file tree + file reader + diff.
  listDir: (dir: string) =>
    ipcRenderer.invoke("files:list-dir", dir) as Promise<{ entries: FileEntry[]; error?: string }>,
  readFile: (filePath: string) =>
    ipcRenderer.invoke("files:read-file", filePath) as Promise<{ content: string; error?: string }>,
  writeFile: (filePath: string, content: string) =>
    ipcRenderer.invoke("files:write-file", filePath, content) as Promise<{ ok: boolean; error?: string }>,
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

  // Workbench Preview — the `preview_url` tool broadcasts a URL for the slot
  // to load (in an in-DOM <iframe>); we accept it back so the tool resolves.
  // (The old native-BrowserView overlay channels were removed as dead code.)
  onPreviewSetUrl: (cb: (reqId: string, url: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, reqId: string, url: string) => cb(reqId, url);
    ipcRenderer.on("wb-preview:set-url", handler);
    return () => { ipcRenderer.removeListener("wb-preview:set-url", handler); };
  },
  previewAccepted: (reqId: string) => ipcRenderer.send("wb-preview:accepted", reqId),

  getTheme: () => ipcRenderer.invoke("get-theme"),
  onThemeChanged: (cb: (theme: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, theme: string) => cb(theme);
    ipcRenderer.on("theme-changed", handler);
    return () => { ipcRenderer.removeListener("theme-changed", handler); };
  },
});
