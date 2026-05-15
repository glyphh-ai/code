import { contextBridge, ipcRenderer } from "electron";

/** IPC bridge for the Files app (yo://files). All git calls are read-only. */
contextBridge.exposeInMainWorld("files", {
  pickFolder: () => ipcRenderer.invoke("files:pick-folder") as Promise<string | null>,
  listDir: (dirPath: string) =>
    ipcRenderer.invoke("files:list-dir", dirPath) as Promise<Array<{ name: string; isDir: boolean }>>,
  readFile: (filePath: string) =>
    ipcRenderer.invoke("files:read-file", filePath) as Promise<{ content: string; binary: boolean; error?: boolean }>,
  gitInfo: (root: string) =>
    ipcRenderer.invoke("files:git-info", root) as Promise<{ isRepo: boolean; branch?: string; defaultBranch?: string }>,
  gitRepos: (root: string) =>
    ipcRenderer.invoke("files:git-repos", root) as Promise<Array<{ name: string; path: string; branch: string }>>,
  gitChanges: (root: string, mode: "working" | "main") =>
    ipcRenderer.invoke("files:git-changes", root, mode) as Promise<Array<{ path: string; status: string }>>,
  gitDiff: (root: string, relPath: string, mode: "working" | "main") =>
    ipcRenderer.invoke("files:git-diff", root, relPath, mode) as Promise<{ original: string; modified: string; binary: boolean }>,
  getTheme: () => ipcRenderer.invoke("get-theme") as Promise<string>,
  onThemeChanged: (cb: (theme: string) => void) => {
    ipcRenderer.on("theme-changed", (_e, theme: string) => cb(theme));
  },
  getLastFolder: () => ipcRenderer.invoke("files:last-folder") as Promise<string | null>,
  setLastFolder: (p: string) => ipcRenderer.send("files:set-last-folder", p),
  // Fired by the .yo agent when it reads/edits a file — mirror it into a tab.
  onExternalOpenFile: (cb: (filePath: string) => void) => {
    ipcRenderer.on("files:external-open", (_e, filePath: string) => cb(filePath));
  },
});
