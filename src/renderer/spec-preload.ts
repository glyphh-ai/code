import { contextBridge, ipcRenderer } from "electron";

interface SpecApi {
  getWorkingDir: () => Promise<string | null>;
  getTheme: () => Promise<string>;
  onThemeChanged: (cb: (theme: string) => void) => () => void;
}

const api: SpecApi = {
  getWorkingDir: () => ipcRenderer.invoke("working-dir:get") as Promise<string | null>,
  getTheme: () => ipcRenderer.invoke("get-theme") as Promise<string>,
  onThemeChanged: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, theme: string) => cb(theme);
    ipcRenderer.on("theme-changed", handler);
    return () => { ipcRenderer.removeListener("theme-changed", handler); };
  },
};

contextBridge.exposeInMainWorld("spec", api);
