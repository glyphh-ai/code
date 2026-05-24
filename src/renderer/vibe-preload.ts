import { contextBridge, ipcRenderer } from "electron";

interface VibeAPI {
  /** Placeholder round-trip to main — wired to the "vibe-ping" handler. */
  ping: () => Promise<unknown>;

  // Stream subscription — main forwards vibe events into the panel.
  onEvent: (cb: (event: { kind: string; [key: string]: unknown }) => void) => () => void;

  // Theme
  getTheme: () => Promise<string>;
  onThemeChanged: (cb: (theme: string) => void) => () => void;
}

const api: VibeAPI = {
  ping: () => ipcRenderer.invoke("vibe-ping"),
  onEvent: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, event: Parameters<typeof cb>[0]) => cb(event);
    ipcRenderer.on("vibe-event", handler);
    return () => { ipcRenderer.removeListener("vibe-event", handler); };
  },
  getTheme: () => ipcRenderer.invoke("get-theme") as Promise<string>,
  onThemeChanged: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, theme: string) => cb(theme);
    ipcRenderer.on("theme-changed", handler);
    return () => { ipcRenderer.removeListener("theme-changed", handler); };
  },
};

contextBridge.exposeInMainWorld("vibe", api);
