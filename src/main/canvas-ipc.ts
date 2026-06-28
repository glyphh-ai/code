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
import { ipcMain, screen } from "electron";
import type { BrowserWindow } from "electron";
import type { PanelManager } from "./panel-manager";
import type { LayoutManager, GridLayout, GridSplitInfo } from "./layout-manager";

/** Height reserved at the top of every canvas window for the DOM titlebar. */
export const CANVAS_TITLEBAR_H = 30;
/** Uncovered frame (px) on the sides/bottom of each window for resize handles. */
export const CANVAS_FRAME = 8;
/** Per-window URL-bar strip height for browser windows (below the titlebar). */
export const CANVAS_URLBAR_H = 36;
/** Bottom strip reserved for the collapsed-windows tray (so windows never cover
 *  it — the DOM tray can't paint above the BrowserViews). */
export const CANVAS_TRAY_H = 52;

const TITLEBAR_BAR = 38; // app titlebar height
const MIN_W = 240;
const MIN_H = 160;

interface WinRect { x: number; y: number; w: number; h: number; z?: number; collapsed?: boolean; restore?: { x: number; y: number; w: number; h: number } }
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
  /** Resolve display name + favicon (+ url/isBrowser for the canvas URL bar). */
  getPanelMeta: (id: string) => { name: string; favicon: string; url?: string; isBrowser?: boolean };
  /** Close a tab through the normal tab path (bookkeeping + re-render). */
  closeTab: (id: string) => void;
  sendTabState: () => void;
}

export function registerCanvasIpc(deps: CanvasIpcDeps): {
  applyCanvas: () => void;
  isCanvasMode: () => boolean;
  refreshChrome: (id: string) => void;
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
    // Reserve a bottom strip for the collapsed-windows tray while any window is
    // collapsed, so a window never sits over (and hides) the tray pills.
    const wmap = readWindows();
    const trayH = windowIds().some((id) => wmap[id]?.collapsed) ? CANVAS_TRAY_H : 0;
    const w = Math.max(MIN_W, cw - panelManager.leftInset - panelManager.rightInset);
    const h = Math.max(MIN_H, ch - y - panelManager.bottomInset - trayH);
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
      .map((e) => ({ id: e.id, x: e.r.x, y: e.r.y, width: e.r.w, height: e.r.h, topExtra: getPanelMeta(e.id).isBrowser ? CANVAS_URLBAR_H : 0 }));
    panelManager.applyCanvas(win, visible, CANVAS_TITLEBAR_H, CANVAS_FRAME);
    // Push each window's meta to its chrome view so it can draw titlebar + URL bar.
    for (const v of visible) pushChromeMeta(v.id);
    win.webContents.send("canvas-state", buildState(win, windows));
  }

  /** Send one window's chrome view its current meta (titlebar + browser URL bar). */
  function pushChromeMeta(id: string): void {
    const meta = getPanelMeta(id);
    panelManager.updateChromeView(id, {
      name: meta.name,
      favicon: meta.favicon,
      active: id === panelManager.activePanelId,
      titlebarH: CANVAS_TITLEBAR_H,
      frame: CANVAS_FRAME,
      isBrowser: !!meta.isBrowser,
      urlBarH: meta.isBrowser ? CANVAS_URLBAR_H : 0,
      url: meta.url || "",
    });
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
      // Leaving canvas: tear down per-window chrome views, clear the canvas
      // chrome, and restore the prior view.
      panelManager.destroyAllChromeViews(win);
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
    // Was this window already laid out, or is it a newcomer? reconcile() assigns
    // a newcomer the top z, which would otherwise trip the "already frontmost"
    // guard below and skip laying it out at all (e.g. `.dip <app>` opening it).
    const isNew = !readWindows()[id];
    const windows = reconcile(win);
    if (!windows[id]) return;
    // For an EXISTING window, no-op if it's already frontmost + uncollapsed —
    // otherwise every click inside the active app would needlessly re-apply.
    const zMax = Math.max(0, ...Object.values(windows).map((r) => r.z ?? 0));
    if (!isNew && !windows[id].collapsed && (windows[id].z ?? 0) >= zMax) return;
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
  // Toggle: maximize to fill the area, or — if already maximized — restore the
  // pre-maximize bounds.
  ipcMain.on("canvas-maximize", (_e, id: string) => {
    if (!isCanvasMode()) return;
    const win = getMainWindow();
    if (!win) return;
    const area = contentArea(win);
    const windows = reconcile(win);
    const r = windows[id];
    if (!r) return;
    const isMax = Math.abs(r.x - area.x) < 3 && Math.abs(r.y - area.y) < 3 &&
                  Math.abs(r.w - area.w) < 5 && Math.abs(r.h - area.h) < 5;
    if (isMax && r.restore) {
      const b = r.restore;
      windows[id] = { ...r, x: b.x, y: b.y, w: b.w, h: b.h, restore: undefined };
    } else {
      windows[id] = { ...r, x: area.x, y: area.y, w: area.w, h: area.h, restore: { x: r.x, y: r.y, w: r.w, h: r.h } };
    }
    bumpFront(id, windows);
    writeWindows(windows);
    applyCanvas();
  });

  /** Arrange windows to match a grid layout (the cells map panel→rect). */
  function canvasArrangeToGrid(grid: GridLayout | GridSplitInfo | null): void {
    const win = getMainWindow();
    if (!win || win.isDestroyed() || !isCanvasMode() || !grid) return;
    const area = contentArea(win);
    const gap = 0; // windows fill the grid flush — no space between or around them
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
      // Raise every window in the layout above the rest (in cell order).
      windows[cell.panelId] = clampRect({ ...windows[cell.panelId], x, y, w, h, z: ++z, collapsed: false }, area);
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

  // ── Chrome-view interactions ──────────────────────────────
  // Each canvas window's chrome (titlebar + resize handles) is its own
  // BrowserView. Buttons map straight onto the existing handlers. Drag/resize
  // bring the window to front, then hand off to the main renderer's DOM drag
  // path (canvas-ui) — the views detach there so tracking stays smooth and in a
  // single webContents.
  ipcMain.on("canvas-chrome-ready", (_e, id: string) => {
    if (!isCanvasMode() || !windowIds().includes(id)) return;
    pushChromeMeta(id);
  });
  ipcMain.on("canvas-chrome-focus", (_e, id: string) => { ipcMain.emit("canvas-focus", {} as Electron.IpcMainEvent, id); });
  ipcMain.on("canvas-chrome-button", (_e, id: string, action: "collapse" | "maximize" | "close") => {
    if (action === "collapse") ipcMain.emit("canvas-collapse", {} as Electron.IpcMainEvent, id);
    else if (action === "maximize") ipcMain.emit("canvas-maximize", {} as Electron.IpcMainEvent, id);
    else if (action === "close") ipcMain.emit("canvas-close", {} as Electron.IpcMainEvent, id);
  });
  // ── Live drag / resize via global cursor polling ─────────────────
  // The gesture's mousedown landed inside a chrome BrowserView, so that view
  // holds the OS mouse capture — but a BrowserView only receives mouse events
  // while the cursor is over its bounds, so streaming its moves drops events on
  // fast drags. Instead we poll the global cursor position in the main process
  // (robust to speed and bounds) and move/resize that window's chrome view (the
  // "ghost") live. The content view is detached for the gesture and restored at
  // the final bounds on release. The chrome view still sends the mouseup
  // (`interact-end`) — polling keeps the ghost under the cursor, so it lands on
  // the chrome view.
  /** Snap distance (px) for window edges during move/resize. */
  const SNAP = 8;

  let interaction:
    | { id: string; mode: "move" | "resize"; edge?: "r" | "b" | "br" | "l" | "bl"; ox: number; oy: number; ow: number; oh: number; cur: WinRect; area: { x: number; y: number; w: number; h: number }; cursorStart: { x: number; y: number }; timer: ReturnType<typeof setInterval>; vTargets: number[]; hTargets: number[] }
    | null = null;

  /** Pick the snapped value for `edges` against `targets` within SNAP px. Returns
   *  the offset to apply (0 if nothing is close enough). */
  function snapOffset(edges: number[], targets: number[]): number {
    let best = SNAP + 1, adj = 0;
    for (const t of targets) {
      for (const e of edges) {
        const d = Math.abs(e - t);
        if (d < best) { best = d; adj = t - e; }
      }
    }
    return best <= SNAP ? adj : 0;
  }

  function endInteraction(): void {
    if (!interaction) return;
    clearInterval(interaction.timer);
    const { id, cur } = interaction;
    interaction = null;
    panelManager.setCanvasInteracting(false);
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send("canvas-interacting", false);
    const windows = reconcile(win);
    if (windows[id]) {
      windows[id] = { ...windows[id], x: cur.x, y: cur.y, w: cur.w, h: cur.h };
      writeWindows(windows);
    }
    applyCanvas();
  }

  function tickInteraction(): void {
    if (!interaction) return;
    const win = getMainWindow();
    if (!win || win.isDestroyed()) { endInteraction(); return; }
    const c = screen.getCursorScreenPoint();
    const dx = c.x - interaction.cursorStart.x;
    const dy = c.y - interaction.cursorStart.y;
    const { mode, edge, ox, oy, ow, oh, area, vTargets, hTargets } = interaction;
    if (mode === "move") {
      let x = Math.max(area.x, Math.min(ox + dx, area.x + area.w - ow));
      let y = Math.max(area.y, Math.min(oy + dy, area.y + area.h - oh));
      // Snap left/right edges to vertical targets, top/bottom to horizontal ones.
      x += snapOffset([x, x + ow], vTargets);
      y += snapOffset([y, y + oh], hTargets);
      interaction.cur = { ...interaction.cur, x, y, w: ow, h: oh };
    } else {
      let x = ox, w = ow, h = oh;
      if (edge === "r" || edge === "br") {
        w = Math.max(MIN_W, Math.min(ow + dx, area.x + area.w - ox));
        const adj = snapOffset([ox + w], vTargets); // snap the right edge
        if (adj) w = Math.max(MIN_W, Math.min(w + adj, area.x + area.w - ox));
      }
      if (edge === "l" || edge === "bl") {
        // Left edge: the right edge (ox+ow) stays put; the left edge follows the
        // cursor, clamped so width >= MIN_W and inside the canvas.
        let nx = Math.max(area.x, Math.min(ox + dx, ox + ow - MIN_W));
        const adj = snapOffset([nx], vTargets); // snap the left edge
        if (adj) nx = Math.max(area.x, Math.min(nx + adj, ox + ow - MIN_W));
        x = nx;
        w = ox + ow - nx;
      }
      if (edge === "b" || edge === "br" || edge === "bl") {
        h = Math.max(MIN_H, Math.min(oh + dy, area.y + area.h - oy));
        const adj = snapOffset([oy + h], hTargets); // snap the bottom edge
        if (adj) h = Math.max(MIN_H, Math.min(h + adj, area.y + area.h - oy));
      }
      interaction.cur = { ...interaction.cur, x, y: oy, w, h };
    }
    panelManager.setChromeViewBounds(interaction.id, { x: interaction.cur.x, y: interaction.cur.y, w: interaction.cur.w, h: interaction.cur.h });
  }

  function startInteraction(id: string, mode: "move" | "resize", edge?: "r" | "b" | "br" | "l" | "bl"): void {
    if (!isCanvasMode()) return;
    const win = getMainWindow();
    if (!win) return;
    if (interaction) endInteraction();
    const windows = reconcile(win);
    if (!windows[id]) return;
    if (windows[id].collapsed) windows[id].collapsed = false;
    // Bump z in prefs so the window is frontmost after release, and raise its
    // chrome view to the top IN PLACE (no detach → mouse capture survives).
    bumpFront(id, windows);
    writeWindows(windows);
    panelManager.setCanvasInteracting(true);
    panelManager.detachPanelView(id, win); // hide content; only the ghost moves
    panelManager.bringChromeToTop(id, win);
    const r = windows[id];
    const area = contentArea(win);
    // Snap targets: the canvas edges plus every other (uncollapsed) window's
    // edges, captured once so edges line up cleanly during the gesture.
    const vTargets = [area.x, area.x + area.w];
    const hTargets = [area.y, area.y + area.h];
    for (const wid of windowIds()) {
      if (wid === id) continue;
      const o = windows[wid];
      if (!o || o.collapsed) continue;
      vTargets.push(o.x, o.x + o.w);
      hTargets.push(o.y, o.y + o.h);
    }
    interaction = {
      id, mode, edge,
      ox: r.x, oy: r.y, ow: r.w, oh: r.h,
      cur: { ...r }, area,
      cursorStart: screen.getCursorScreenPoint(),
      timer: setInterval(tickInteraction, 16),
      vTargets, hTargets,
    };
    win.webContents.send("canvas-interacting", true);
  }

  ipcMain.on("canvas-chrome-move-start", (_e, id: string) => startInteraction(id, "move"));
  ipcMain.on("canvas-chrome-resize-start", (_e, id: string, edge: "r" | "b" | "br" | "l" | "bl") => startInteraction(id, "resize", edge));
  ipcMain.on("canvas-chrome-interact-end", (_e, id: string) => { if (interaction && interaction.id === id) endInteraction(); });
  ipcMain.on("canvas-interact-end-global", () => { if (interaction) endInteraction(); });

  // Tile every open window into an equal-sized grid — restoring any collapsed
  // ones first. With no args the grid is auto-squared; cols/rows can be forced
  // (rows grows to fit if both are given but too small).
  ipcMain.on("canvas-grid-all", (_e, cols?: number, rows?: number) => {
    if (!isCanvasMode()) return;
    const win = getMainWindow();
    if (!win) return;
    const windows = reconcile(win);
    const ids = windowIds().filter((id) => windows[id]);
    const n = ids.length;
    if (n === 0) return;
    // Restore collapsed windows and persist before measuring, so contentArea no
    // longer reserves the tray strip (we're using the full area for the grid).
    for (const id of ids) windows[id].collapsed = false;
    writeWindows(windows);
    const area = contentArea(win);
    const gap = 0; // windows fill the grid flush — no space between or around them
    let c = cols && cols > 0 ? Math.floor(cols) : 0;
    let r = rows && rows > 0 ? Math.floor(rows) : 0;
    if (!c && !r) { c = Math.ceil(Math.sqrt(n)); r = Math.ceil(n / c); }
    else if (c && !r) { r = Math.ceil(n / c); }
    else if (!c && r) { c = Math.ceil(n / r); }
    else { r = Math.max(r, Math.ceil(n / c)); }
    const cellW = (area.w - gap * (c + 1)) / c;
    const cellH = (area.h - gap * (r + 1)) / r;
    let z = Math.max(0, ...Object.values(windows).map((w) => w.z ?? 0));
    ids.forEach((id, i) => {
      const col = i % c;
      const row = Math.floor(i / c);
      const x = area.x + gap + col * (cellW + gap);
      const y = area.y + gap + row * (cellH + gap);
      windows[id] = clampRect({ ...windows[id], x, y, w: cellW, h: cellH, z: ++z, collapsed: false, restore: undefined }, area);
    });
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

  return { applyCanvas, isCanvasMode, setCanvasMode, arrangeToGrid: canvasArrangeToGrid, refreshChrome: pushChromeMeta };
}
