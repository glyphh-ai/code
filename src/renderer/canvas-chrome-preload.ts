// canvas-chrome-preload.ts — contextBridge for a single canvas window's chrome
// BrowserView. Each canvas window gets its own chrome view (titlebar + resize
// frame) stacked directly above its content view so overlapping windows never
// bleed into each other's chrome. The view forwards interactions to the main
// process, which hands the actual move/resize off to the main renderer's DOM
// drag path (smooth, single-webContents tracking). Bundled by
// `npm run build:canvas-chrome` -> dist/main/canvas-chrome-preload.js.
import { contextBridge, ipcRenderer } from "electron";

const id = new URLSearchParams(location.search).get("id") || "";

interface ChromeUpdate {
  name: string;
  favicon: string;
  active: boolean;
  titlebarH: number;
  frame: number;
}

contextBridge.exposeInMainWorld("canvasChrome", {
  id,
  // Interactions → main (tagged with this window's id).
  focus: () => ipcRenderer.send("canvas-chrome-focus", id),
  menu: () => ipcRenderer.send("canvas-window-menu", id),
  button: (action: "collapse" | "maximize" | "close") => ipcRenderer.send("canvas-chrome-button", id, action),
  // Main drives the live move/resize by polling the global cursor; these just
  // mark the gesture's start and end.
  moveStart: () => ipcRenderer.send("canvas-chrome-move-start", id),
  resizeStart: (edge: "r" | "b" | "br") => ipcRenderer.send("canvas-chrome-resize-start", id, edge),
  interactEnd: () => ipcRenderer.send("canvas-chrome-interact-end", id),
  // Tell main we're loaded + listening, so it pushes our initial meta (avoids a
  // blank titlebar if the first update fired before this view finished loading).
  ready: () => ipcRenderer.send("canvas-chrome-ready", id),
  // Window meta + geometry pushed from main on every applyCanvas.
  onUpdate: (cb: (u: ChromeUpdate) => void) =>
    ipcRenderer.on("canvas-chrome-update", (_e, u: ChromeUpdate) => cb(u)),
  // Theme so the chrome matches the app's light/dark mode.
  getTheme: () => ipcRenderer.invoke("get-theme") as Promise<string>,
  onThemeChanged: (cb: (theme: string) => void) =>
    ipcRenderer.on("theme-changed", (_e, theme: string) => cb(theme)),
});
