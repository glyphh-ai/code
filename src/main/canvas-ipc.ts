/**
 * canvas-ipc.ts — "Canvas mode": a draggable-desktop layout where each open app
 * renders as an individual free-floating window (move / resize / collapse /
 * close) instead of a tab or a fixed grid.
 *
 * Because app panels are native BrowserViews, their bounds must be set in the
 * main process. The renderer (canvas-ui.ts) draws the window chrome (titlebar +
 * borders) in the strip above each view and drives interaction over IPC — the
 * same split-of-responsibility used by the grid drag handles.
 *
 * Window geometry lives in the `canvasWindows` preference, keyed by panel id, in
 * absolute window-content coordinates (the same space as BrowserView.setBounds):
 *   { [id]: { x, y, w, h, z, collapsed } }
 *
 * "Dip to a layout" while in canvas mode arranges the windows to match that
 * layout's grid given the available space (canvasArrangeToGrid).
 */
import { ipcMain } from "electron";
import type { BrowserWindow } from "electron";
import type { PanelManager } from "./panel-manager";
import type { LayoutManager, GridLayout, GridSplitInfo } from "./layout-manager";

/** Height reserved at the top of every canvas window for the DOM titlebar. */
export const CANVAS_TITLEBAR_H = 30;
/** Uncovered frame (px) on the sides/bottom of each window for resize handles. */
export const CANVAS_FRAME = 8;

const TITLEBAR_BAR = 38; // app titlebar height
const MIN_W = 240;
const MIN_H = 160;

interface WinRect { x: number; y: number; w: number; h: number; z?: number; collapsed?: boolean }
type CanvasWindows = Record<string, WinRect>;

export interface CanvasWindowState {
  id: string;
  name: string;
  favicon: string;
  x: number; y: number; w: number; h: number;
  z: number;
  collapsed: boolean;
}

export interface CanvasState {
  mode: boolean;
  titlebarH: number;
  frame: number;
  active: string | null;
  windows: CanvasWindowState[];
}

interface CanvasIpcDeps {
  panelManager: PanelManager;
  layoutManager: LayoutManager;
  getMainWindow: () => BrowserWindow | null;
  getPreference: <T>(key: string, fallback: T) => T;
  setPreference: (key: string, value: unknown) => void;
  /** Live list of open tab/panel ids (excludes the layout pseudo-tab). */
  openTabs: string[];
  /** Resolve display name + favicon for chrome. */
  getPanelMeta: (id: string) => { name: string; favicon: string };
  /** Close a tab through the normal tab path (bookkeeping + re-render). */
  closeTab: (id: string) => void;
  sendTabState: () => void;
}

export function registerCanvasIpc(deps: CanvasIpcDeps): {
  applyCanvas: () => void;
  isCanvasMode: () => boolean;
  setCanvasMode: (on: boolean) => void;
  arrangeToGrid: (grid: GridLayout | GridSplitInfo | null) => void;
} {
  const {
    panelManager, layoutManager, getMainWindow,
    getPreference, setPreference, openTabs, getPanelMeta, closeTab, sendTabState,
  } = deps;

  function readWindows(): CanvasWindows {
    const raw = getPreference<CanvasWindows>("canvasWindows", {});
    return raw && typeof raw === "object" ? { ...raw } : {};
  }
  function writeWindows(w: CanvasWindows): void {
    setPreference("canvasWindows", w);
  }

  function isCanvasMode(): boolean {
    return getPreference<boolean>("canvasMode", false);
  }

  /** Available content area (window-content coords) minus rails/url-bar/dock. */
  function contentArea(win: BrowserWindow): { x: number; y: number; w: number; h: number } {
    const [cw, ch] = win.getContentSize();
    const x = panelManager.leftInset;
    const y = TITLEBAR_BAR + panelManager.topInset;
    const w = Math.max(MIN_W, cw - panelManager.leftInset - panelManager.rightInset);
    const h = Math.max(MIN_H, ch - y - panelManager.bottomInset);
    return { x, y, w, h };
  }

  function clampRect(r: WinRect, area: { x: number; y: number; w: number; h: number }): WinRect {
    const w = Math.max(MIN_W, Math.min(r.w, area.w));
    const h = Math.max(MIN_H, Math.min(r.h, area.h));
    const x = Math.max(area.x, Math.min(r.x, area.x + area.w - w));
    const y = Math.max(area.y, Math.min(r.y, area.y + area.h - h));
    return { ...r, x, y, w, h };
  }

  /** Panels that participate as windows: every open tab except the layout tab. */
  function windowIds(): string[] {
    return openTabs.filter((id) => id && id !== "__layout__");
  }

  /** Ensure every open panel has saved geometry; assign a cascade default to
   *  newcomers. Prunes geometry for panels no longer open. */
  function reconcile(win: BrowserWindow): CanvasWindows {
    const area = contentArea(win);
    const windows = readWindows();
    const ids = windowIds();
    const open = new Set(ids);
    for (const id of Object.keys(windows)) if (!open.has(id)) delete windows[id];

    let zMax = Math.max(0, ...Object.values(windows).map((r) => r.z ?? 0));
    let newcomers = 0;
    ids.forEach((id) => {
      if (!windows[id]) {
        const slot = newcomers++;
        const w = Math.min(760, area.w - 40);
        const h = Math.min(560, area.h - 40);
        windows[id] = clampRect({
          x: area.x + 28 + (slot % 6) * 36,
          y: area.y + 24 + (slot % 6) * 36,
          w, h, z: ++zMax, collapsed: false,
        }, area);
      }
    });
    return windows;
  }

  function buildState(win: BrowserWindow, windows: CanvasWindows): CanvasState {
    const area = contentArea(win);
    const list: CanvasWindowState[] = windowIds().map((id) => {
      const r = clampRect(windows[id], area);
      const meta = getPanelMeta(id);
      return { id, name: meta.name, favicon: meta.favicon, x: r.x, y: r.y, w: r.w, h: r.h, z: r.z ?? 0, collapsed: !!r.collapsed };
    });
    list.sort((a, b) => a.z - b.z);
    return { mode: true, titlebarH: CANVAS_TITLEBAR_H, frame: CANVAS_FRAME, active: panelManager.activePanelId, windows: list };
  }

  /** Position the BrowserViews + push chrome state to the renderer. */
  function applyCanvas(): void {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    if (!isCanvasMode()) return;
    const windows = reconcile(win);
    writeWindows(windows);
    const area = contentArea(win);
    const visible = windowIds()
      .map((id) => ({ id, r: clampRect(windows[id], area) }))
      .filter((e) => !e.r.collapsed)
      .sort((a, b) => (a.r.z ?? 0) - (b.r.z ?? 0))
      .map((e) => ({ id: e.id, x: e.r.x, y: e.r.y, width: e.r.w, height: e.r.h }));
    panelManager.applyCanvas(win, visible, CANVAS_TITLEBAR_H, CANVAS_FRAME);
    win.webContents.send("canvas-state", buildState(win, windows));
  }

  function bumpFront(id: string, windows: CanvasWindows): void {
    const zMax = Math.max(0, ...Object.values(windows).map((r) => r.z ?? 0));
    if (windows[id]) windows[id].z = zMax + 1;
    panelManager.setCanvasMode(true);
  }

  // ── Mode toggle ───────────────────────────────────────────
  function setCanvasMode(on: boolean): void {
    setPreference("canvasMode", on);
    panelManager.setCanvasMode(on);
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    if (on) {
      applyCanvas();
    } else {
      // Leaving canvas: clear the canvas chrome, restore the prior view.
      win.webContents.send("canvas-state", { mode: false, titlebarH: CANVAS_TITLEBAR_H, frame: CANVAS_FRAME, active: panelManager.activePanelId, windows: [] } as CanvasState);
      if (layoutManager.hasSplit) {
        layoutManager.restoreSplit(win);
      } else if (panelManager.activePanelId) {
        panelManager.switchTo(panelManager.activePanelId, win);
      }
    }
    sendTabState();
  }

  ipcMain.handle("canvas-get-state", () => {
    const win = getMainWindow();
    if (!win || win.isDestroyed() || !isCanvasMode()) {
      return { mode: false, titlebarH: CANVAS_TITLEBAR_H, frame: CANVAS_FRAME, active: null, windows: [] } as CanvasState;
    }
    return buildState(win, reconcile(win));
  });

  ipcMain.on("canvas-set-mode", (_e, on: boolean) => setCanvasMode(!!on));

  ipcMain.on("canvas-set-bounds", (_e, id: string, rect: { x: number; y: number; w: number; h: number }) => {
    if (!isCanvasMode()) return;
    const win = getMainWindow();
    if (!win) return;
    const windows = reconcile(win);
    if (!windows[id]) return;
    windows[id] = { ...windows[id], x: rect.x, y: rect.y, w: Math.max(MIN_W, rect.w), h: Math.max(MIN_H, rect.h) };
    writeWindows(windows);
    applyCanvas();
  });

  ipcMain.on("canvas-focus", (_e, id: string) => {
    if (!isCanvasMode()) return;
    const win = getMainWindow();
    if (!win) return;
    const windows = reconcile(win);
    if (!windows[id]) return;
    if (windows[id].collapsed) windows[id].collapsed = false;
    bumpFront(id, windows);
    writeWindows(windows);
    applyCanvas();
  });

  ipcMain.on("canvas-collapse", (_e, id: string) => {
    if (!isCanvasMode()) return;
    const win = getMainWindow();
    if (!win) return;
    const windows = reconcile(win);
    if (!windows[id]) return;
    windows[id].collapsed = true;
    writeWindows(windows);
    applyCanvas();
  });

  ipcMain.on("canvas-restore", (_e, id: string) => {
    if (!isCanvasMode()) return;
    const win = getMainWindow();
    if (!win) return;
    const windows = reconcile(win);
    if (!windows[id]) return;
    windows[id].collapsed = false;
    bumpFront(id, windows);
    writeWindows(windows);
    applyCanvas();
  });

  ipcMain.on("canvas-close", (_e, id: string) => {
    closeTab(id);
    const windows = readWindows();
    delete windows[id];
    writeWindows(windows);
    if (isCanvasMode()) applyCanvas();
  });

  // Maximize a window to fill the available content area.
  ipcMain.on("canvas-maximize", (_e, id: string) => {
    if (!isCanvasMode()) return;
    const win = getMainWindow();
    if (!win) return;
    const area = contentArea(win);
    const windows = reconcile(win);
    if (!windows[id]) return;
    windows[id] = { ...windows[id], x: area.x, y: area.y, w: area.w, h: area.h };
    bumpFront(id, windows);
    writeWindows(windows);
    applyCanvas();
  });

  /** Arrange windows to match a grid layout (the cells map panel→rect). */
  function canvasArrangeToGrid(grid: GridLayout | GridSplitInfo | null): void {
    const win = getMainWindow();
    if (!win || win.isDestroyed() || !isCanvasMode() || !grid) return;
    const area = contentArea(win);
    const gap = 10;
    const colWidths = grid.colWidths, rowHeights = grid.rowHeights;
    const cumCol: number[] = [0];
    for (let i = 0; i < colWidths.length; i++) cumCol.push(cumCol[i] + colWidths[i]);
    const cumRow: number[] = [0];
    for (let i = 0; i < rowHeights.length; i++) cumRow.push(cumRow[i] + rowHeights[i]);

    const windows = reconcile(win);
    let z = Math.max(0, ...Object.values(windows).map((r) => r.z ?? 0));
    for (const cell of grid.cells) {
      // Make sure the cell's panel is a window we know about.
      if (!windows[cell.panelId]) {
        windows[cell.panelId] = { x: area.x, y: area.y, w: 400, h: 300, z: ++z, collapsed: false };
      }
      const x = area.x + cumCol[cell.col] * area.w + gap / 2;
      const y = area.y + cumRow[cell.row] * area.h + gap / 2;
      const w = (cumCol[cell.col + cell.colSpan] - cumCol[cell.col]) * area.w - gap;
      const h = (cumRow[cell.row + cell.rowSpan] - cumRow[cell.row]) * area.h - gap;
      windows[cell.panelId] = clampRect({ ...windows[cell.panelId], x, y, w, h, collapsed: false }, area);
    }
    writeWindows(windows);
    applyCanvas();
  }

  // Open (or focus) an app as a canvas window. Reuses the normal tab-creation
  // path for panel/instance bookkeeping, then re-arranges so the new view lands
  // as a free window on top instead of a single full-bleed switchTo.
  ipcMain.on("canvas-open-app", (_e, appId: string) => {
    ipcMain.emit("tab-new-app", {} as Electron.IpcMainEvent, appId);
    if (!isCanvasMode()) return;
    const win = getMainWindow();
    if (!win) return;
    const id = openTabs[openTabs.length - 1];
    const windows = reconcile(win);
    if (id && windows[id]) bumpFront(id, windows);
    writeWindows(windows);
    applyCanvas();
  });

  ipcMain.on("canvas-dip-layout", (_e, name?: string) => {
    if (!isCanvasMode()) return;
    let grid: GridLayout | GridSplitInfo | null = null;
    if (name) {
      grid = (layoutManager.getLayout(name) as GridLayout) || null;
    } else {
      grid = layoutManager.getGridInfo() || layoutManager.getSuspendedGridInfo();
    }
    canvasArrangeToGrid(grid);
  });

  return { applyCanvas, isCanvasMode, setCanvasMode, arrangeToGrid: canvasArrangeToGrid };
}
