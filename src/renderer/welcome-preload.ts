import { contextBridge, ipcRenderer } from "electron";

interface WelcomeApi {
  getRecents: () => Promise<string[]>;
  openVibe: () => Promise<void>;
  openSpec: () => Promise<void>;
  openFolder: (folder: string) => Promise<void>;
  getShowOnStartup: () => Promise<boolean>;
  setShowOnStartup: (v: boolean) => Promise<void>;
  getTheme: () => Promise<string>;
  onThemeChanged: (cb: (theme: string) => void) => () => void;
}

const api: WelcomeApi = {
  getRecents: () => ipcRenderer.invoke("welcome:recents") as Promise<string[]>,
  openVibe: () => ipcRenderer.invoke("welcome:open-vibe") as Promise<void>,
  openSpec: () => ipcRenderer.invoke("welcome:open-spec") as Promise<void>,
  openFolder: (folder) => ipcRenderer.invoke("welcome:open-folder", folder) as Promise<void>,
  getShowOnStartup: () =>
    ipcRenderer.invoke("welcome:get-show-on-startup") as Promise<boolean>,
  setShowOnStartup: (v) =>
    ipcRenderer.invoke("welcome:set-show-on-startup", v) as Promise<void>,
  getTheme: () => ipcRenderer.invoke("get-theme") as Promise<string>,
  onThemeChanged: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, theme: string) => cb(theme);
    ipcRenderer.on("theme-changed", handler);
    return () => { ipcRenderer.removeListener("theme-changed", handler); };
  },
};

contextBridge.exposeInMainWorld("welcome", api);
