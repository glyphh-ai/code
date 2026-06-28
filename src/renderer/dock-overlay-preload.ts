// dock-overlay-preload.ts — contextBridge for the transparent Dock overlay
// window. Exposes the same dock API the renderer used when the dock lived in the
// main window, plus the click-through toggle and theme. Bundled by
// `npm run build:dock-overlay` -> dist/main/dock-overlay-preload.js.
import { contextBridge, ipcRenderer } from "electron";

type DockCfg = { enabled: boolean; autoHide: boolean; scale: number; zoom: boolean; magnify: number; position: string; apps: string[]; height: number };
type AppMeta = { id: string; name: string; url?: string };

contextBridge.exposeInMainWorld("dock", {
  getConfig: () => ipcRenderer.invoke("dock-get-config") as Promise<DockCfg>,
  setConfig: (patch: Partial<DockCfg>) => ipcRenderer.send("dock-set-config", patch),
  reorder: (order: string[]) => ipcRenderer.send("dock-reorder", order),
  removeApp: (id: string) => ipcRenderer.send("dock-remove-app", id),
  onChanged: (cb: (cfg: DockCfg) => void) => ipcRenderer.on("dock-changed", (_e, cfg: DockCfg) => cb(cfg)),
  onReveal: (cb: (info: { visible: boolean }) => void) => ipcRenderer.on("dock-reveal", (_e, info) => cb(info)),
  listApps: () => ipcRenderer.invoke("apps-list-all") as Promise<AppMeta[]>,
  openApp: (id: string) => ipcRenderer.send("dock-open-app", id),
  onTabState: (cb: (s: { tabs: Array<{ id: string }>; activeId: string }) => void) => ipcRenderer.on("tab-state", (_e, s) => cb(s)),
  // Report the interactive rectangle (strip + magnification headroom) in window
  // client px; main polls the cursor against it to toggle click-through. null
  // when nothing is interactive (hidden strip).
  reportHitRect: (rect: { x: number; y: number; w: number; h: number } | null) => ipcRenderer.send("dock-hit-rect", rect),
  // Cursor position (window-client px) while over the dock, or null when away —
  // drives the magnification ripple.
  onCursor: (cb: (c: { x: number; y: number } | null) => void) => ipcRenderer.on("dock-cursor", (_e, c) => cb(c)),
  // Ask the main window to show a themed confirm modal before removing.
  requestRemove: (id: string) => ipcRenderer.send("dock-confirm-remove-request", id),
  getTheme: () => ipcRenderer.invoke("get-theme") as Promise<string>,
  onThemeChanged: (cb: (theme: string) => void) => ipcRenderer.on("theme-changed", (_e, theme: string) => cb(theme)),
});
