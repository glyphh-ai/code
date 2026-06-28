// dock-overlay.ts — the Dock as a transparent, always-on-top child window that
// floats ABOVE the panels (BrowserViews) instead of living in a reserved inset.
//
// Why a separate window: DOM in the main renderer paints BELOW BrowserViews, and
// a BrowserView overlay would capture every click in its footprint. A child
// window can be made click-through with setIgnoreMouseEvents, and we toggle that
// per-frame from a main-process cursor poll: the renderer reports the strip's
// hit-rectangle (icons + magnification headroom), and whenever the OS cursor is
// inside it we let the window capture the mouse; otherwise clicks fall straight
// through to the workspace behind. Polling avoids depending on the (unreliable)
// `forward` mouse-message path for a non-focusable transparent window.
import { BrowserWindow, ipcMain, screen } from "electron";
import * as path from "path";

export type DockPosition = "bottom" | "top" | "left" | "right";

/** Band thickness (px) reserved along the docked edge — wide enough that a
 *  magnified icon can grow out of the strip without clipping. */
const THICKNESS = 240;
const POLL_MS = 24; // ~40Hz: snappy click-through toggle + smooth magnification

interface DockOverlayDeps {
  getMainWindow: () => BrowserWindow | null;
  getPosition: () => DockPosition;
}

export interface DockOverlay {
  show: () => void;
  hide: () => void;
  reposition: () => void;
  send: (channel: string, payload: unknown) => void;
  destroy: () => void;
}

export function createDockOverlay(deps: DockOverlayDeps): DockOverlay {
  let overlay: BrowserWindow | null = null;
  let tracking = false;
  // Latest interactive rectangle (window-client CSS px) reported by the renderer,
  // or null when the strip is hidden / empty.
  let hitRect: { x: number; y: number; w: number; h: number } | null = null;
  let ignoring = true;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function setIgnore(ignore: boolean): void {
    if (!overlay || overlay.isDestroyed() || ignore === ignoring) return;
    ignoring = ignore;
    overlay.setIgnoreMouseEvents(ignore);
  }

  let sentOver = false;
  function sendCursor(c: { x: number; y: number } | null): void {
    if (overlay && !overlay.isDestroyed()) overlay.webContents.send("dock-cursor", c);
  }
  function pollCursor(): void {
    if (!overlay || overlay.isDestroyed() || !overlay.isVisible()) return;
    if (!hitRect) { setIgnore(true); if (sentOver) { sentOver = false; sendCursor(null); } return; }
    const wb = overlay.getBounds();
    const p = screen.getCursorScreenPoint();
    const over =
      p.x >= wb.x + hitRect.x && p.x <= wb.x + hitRect.x + hitRect.w &&
      p.y >= wb.y + hitRect.y && p.y <= wb.y + hitRect.y + hitRect.h;
    setIgnore(!over);
    // Stream the cursor (in window-client px) to drive magnification — CSS :hover
    // can't, because a stationary cursor produces no mousemove after capture flips.
    if (over) { sentOver = true; sendCursor({ x: p.x - wb.x, y: p.y - wb.y }); }
    else if (sentOver) { sentOver = false; sendCursor(null); }
  }

  function startPoll(): void { if (!pollTimer) pollTimer = setInterval(pollCursor, POLL_MS); }
  function stopPoll(): void {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    setIgnore(true);
  }

  function reposition(): void {
    const main = deps.getMainWindow();
    if (!main || main.isDestroyed() || !overlay || overlay.isDestroyed()) return;
    const cb = main.getContentBounds();
    const pos = deps.getPosition();
    let b: { x: number; y: number; width: number; height: number };
    if (pos === "bottom") b = { x: cb.x, y: cb.y + cb.height - THICKNESS, width: cb.width, height: THICKNESS };
    else if (pos === "top") b = { x: cb.x, y: cb.y, width: cb.width, height: THICKNESS };
    else if (pos === "left") b = { x: cb.x, y: cb.y, width: THICKNESS, height: cb.height };
    else b = { x: cb.x + cb.width - THICKNESS, y: cb.y, width: THICKNESS, height: cb.height };
    overlay.setBounds(b);
  }

  function ensure(): BrowserWindow | null {
    const main = deps.getMainWindow();
    if (!main || main.isDestroyed()) return null;
    if (overlay && !overlay.isDestroyed()) return overlay;

    overlay = new BrowserWindow({
      parent: main,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      focusable: false,    // never steal keyboard focus from the workspace
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      alwaysOnTop: true,
      acceptFirstMouse: true,
      webPreferences: {
        preload: path.join(__dirname, "dock-overlay-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    overlay.setAlwaysOnTop(true, "floating");
    overlay.setIgnoreMouseEvents(true); // click-through until the cursor poll says otherwise
    void overlay.loadFile(path.join(__dirname, "..", "renderer", "dock.html"));

    if (!tracking) {
      tracking = true;
      main.on("move", reposition);
      main.on("resize", reposition);
      main.on("maximize", reposition);
      main.on("unmaximize", reposition);
      main.on("restore", reposition);
      main.on("enter-full-screen", reposition);
      main.on("leave-full-screen", reposition);
    }
    overlay.on("closed", () => { overlay = null; });
    return overlay;
  }

  // The renderer reports its interactive rectangle (strip + magnification
  // headroom) whenever it renders / reveals / resizes; null when nothing is
  // interactive (hidden strip).
  ipcMain.on("dock-hit-rect", (_e, rect: { x: number; y: number; w: number; h: number } | null) => {
    hitRect = rect && typeof rect === "object" ? rect : null;
  });

  return {
    show(): void {
      const o = ensure();
      if (!o) return;
      reposition();
      o.showInactive();
      startPoll();
    },
    hide(): void {
      stopPoll();
      if (overlay && !overlay.isDestroyed()) overlay.hide();
    },
    reposition,
    send(channel: string, payload: unknown): void {
      if (overlay && !overlay.isDestroyed()) overlay.webContents.send(channel, payload);
    },
    destroy(): void {
      stopPoll();
      if (overlay && !overlay.isDestroyed()) overlay.destroy();
      overlay = null;
    },
  };
}
