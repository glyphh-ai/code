import { contextBridge, ipcRenderer } from "electron";

type RecentEntry = {
  kind: "app" | "layout";
  id: string;
  name: string;
  folder: string;
  ts: number;
};

interface WelcomeApi {
  recentsList: () => Promise<RecentEntry[]>;
  recentsOpen: (entry: RecentEntry) => Promise<boolean>;
  recentsRemove: (entry: Pick<RecentEntry, "kind" | "id" | "folder">) => Promise<boolean>;
  onRecentsChanged: (cb: (list: RecentEntry[]) => void) => () => void;
  openVibe: () => Promise<void>;
  openSpec: () => Promise<void>;
  openFolder: (folder: string) => Promise<void>;
  getShowOnStartup: () => Promise<boolean>;
  setShowOnStartup: (v: boolean) => Promise<void>;
  getTheme: () => Promise<string>;
  onThemeChanged: (cb: (theme: string) => void) => () => void;
}

const api: WelcomeApi = {
  recentsList: () => ipcRenderer.invoke("recents:list") as Promise<RecentEntry[]>,
  recentsOpen: (entry) => ipcRenderer.invoke("recents:open", entry) as Promise<boolean>,
  recentsRemove: (entry) => ipcRenderer.invoke("recents:remove", entry) as Promise<boolean>,
  onRecentsChanged: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, list: RecentEntry[]) => cb(list);
    ipcRenderer.on("recents-changed", handler);
    return () => { ipcRenderer.removeListener("recents-changed", handler); };
  },
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
