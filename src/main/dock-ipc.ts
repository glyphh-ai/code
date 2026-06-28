/**
 * dock-ipc.ts — Dock configuration + auto-hide reveal logic.
 *
 * The Dock itself renders in a transparent always-on-top child window (see
 * dock-overlay.ts) that floats ABOVE the panels — no inset is reserved and the
 * workspace content is never pushed around. This module owns the config
 * (preferences), broadcasts it, and drives the overlay: show/hide on enable, and
 * cursor-proximity reveal for auto-hide along whichever edge the dock is pinned
 * to.
 *
 * Preferences:
 *   dockEnabled   boolean   master on/off
 *   dockAutoHide  boolean   hide until the cursor approaches the docked edge
 *   dockScale     number    0.5–2.0 icon size
 *   dockZoom      boolean   magnify the hovered icon
 *   dockMagnify   number    1.0–2.5 hover magnification factor
 *   dockPosition  string    "bottom" | "top" | "left" | "right"
 *   dockApps      string[]  ordered app ids pinned to the dock
 */
import { ipcMain, screen, webContents } from "electron";
import type { BrowserWindow } from "electron";
import type { DockOverlay, DockPosition } from "./dock-overlay";

/** Apps pinned to the Dock on first run (the user can remove any of them). */
const DEFAULT_DOCK_APPS = ["browser", "term", "workbench", "settings"];
/** Unscaled dock height (icon + padding). Scaled by dockScale. */
const DOCK_BASE_HEIGHT = 68;
/** How close (px) the cursor must get to the docked edge to reveal. */
const REVEAL_ZONE = 6;
const POLL_MS = 120;

export interface DockConfig {
  enabled: boolean;
  autoHide: boolean;
  scale: number;
  zoom: boolean;
  magnify: number;
  position: DockPosition;
  apps: string[];
  /** Derived: scaled pixel height of the dock strip. */
  height: number;
}

interface DockIpcDeps {
  dockOverlay: DockOverlay;
  getMainWindow: () => BrowserWindow | null;
  getPreference: <T>(key: string, fallback: T) => T;
  setPreference: (key: string, value: unknown) => void;
}

export function registerDockIpc(deps: DockIpcDeps): { refreshDock: () => void } {
  const { dockOverlay, getMainWindow, getPreference, setPreference } = deps;

  let revealed = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const clampScale = (n: number): number => (!Number.isFinite(n) ? 1 : Math.max(0.5, Math.min(2.0, n)));
  const clampMagnify = (n: number): number => (!Number.isFinite(n) ? 1.6 : Math.max(1.0, Math.min(2.5, n)));
  function readPosition(): DockPosition {
    const p = getPreference<string>("dockPosition", "bottom");
    return (["bottom", "top", "left", "right"].includes(p) ? p : "bottom") as DockPosition;
  }

  function readConfig(): DockConfig {
    return {
      enabled: getPreference<boolean>("dockEnabled", false),
      autoHide: getPreference<boolean>("dockAutoHide", true),
      scale: clampScale(getPreference<number>("dockScale", 1)),
      zoom: getPreference<boolean>("dockZoom", true),
      magnify: clampMagnify(getPreference<number>("dockMagnify", 1.6)),
      position: readPosition(),
      apps: getPreference<string[]>("dockApps", DEFAULT_DOCK_APPS).filter((id) => typeof id === "string"),
      height: Math.round(DOCK_BASE_HEIGHT * clampScale(getPreference<number>("dockScale", 1))),
    };
  }

  /** Broadcast the dock config to every renderer/BrowserView (settings UI reads
   *  it; the overlay window renders from it). */
  function broadcast(): void {
    const cfg = readConfig();
    for (const wc of webContents.getAllWebContents()) {
      try { wc.send("dock-changed", cfg); } catch { /* ignore */ }
    }
  }

  /** Tell the overlay whether the strip should be visible right now. */
  function sendReveal(): void {
    const cfg = readConfig();
    const visible = cfg.enabled && (!cfg.autoHide || revealed);
    dockOverlay.send("dock-reveal", { visible });
  }

  /** Show/hide the overlay window and push current reveal state. */
  function refreshDock(): void {
    const cfg = readConfig();
    if (cfg.enabled) {
      dockOverlay.show();
      dockOverlay.reposition();
    } else {
      revealed = false;
      dockOverlay.hide();
    }
    sendReveal();
    syncPoll(cfg);
  }

  function syncPoll(cfg: DockConfig): void {
    const wantPoll = cfg.enabled && cfg.autoHide;
    if (wantPoll && !pollTimer) {
      pollTimer = setInterval(tickReveal, POLL_MS);
    } else if (!wantPoll && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
      if (revealed) { revealed = false; sendReveal(); }
    }
  }

  function tickReveal(): void {
    const win = getMainWindow();
    if (!win || win.isDestroyed() || !win.isFocused()) {
      if (revealed) { revealed = false; sendReveal(); }
      return;
    }
    const cfg = readConfig();
    const b = win.getContentBounds();
    const pt = screen.getCursorScreenPoint();
    const insideX = pt.x >= b.x && pt.x <= b.x + b.width;
    const insideY = pt.y >= b.y && pt.y <= b.y + b.height;
    const zone = revealed ? cfg.height + 24 : REVEAL_ZONE;
    let near = false;
    if (cfg.position === "bottom") near = insideX && pt.y >= b.y + b.height - zone && pt.y <= b.y + b.height + 4;
    else if (cfg.position === "top") near = insideX && pt.y <= b.y + zone && pt.y >= b.y - 4;
    else if (cfg.position === "left") near = insideY && pt.x <= b.x + zone && pt.x >= b.x - 4;
    else near = insideY && pt.x >= b.x + b.width - zone && pt.x <= b.x + b.width + 4;
    if (near !== revealed) {
      revealed = near;
      sendReveal();
    }
  }

  // ── IPC ───────────────────────────────────────────────────
  ipcMain.handle("dock-get-config", () => readConfig());

  ipcMain.on("dock-set-config", (_e, patch: Partial<Omit<DockConfig, "height">>) => {
    if (typeof patch.enabled === "boolean") setPreference("dockEnabled", patch.enabled);
    if (typeof patch.autoHide === "boolean") setPreference("dockAutoHide", patch.autoHide);
    if (typeof patch.scale === "number") setPreference("dockScale", clampScale(patch.scale));
    if (typeof patch.zoom === "boolean") setPreference("dockZoom", patch.zoom);
    if (typeof patch.magnify === "number") setPreference("dockMagnify", clampMagnify(patch.magnify));
    if (typeof patch.position === "string" && ["bottom", "top", "left", "right"].includes(patch.position)) {
      setPreference("dockPosition", patch.position);
    }
    revealed = false; // re-evaluate from scratch
    refreshDock();
    broadcast();
  });

  ipcMain.on("dock-add-app", (_e, id: string) => {
    if (!id) return;
    const apps = getPreference<string[]>("dockApps", []);
    if (!apps.includes(id)) {
      apps.push(id);
      setPreference("dockApps", apps);
      broadcast();
    }
  });

  ipcMain.on("dock-remove-app", (_e, id: string) => {
    const apps = getPreference<string[]>("dockApps", []).filter((a) => a !== id);
    setPreference("dockApps", apps);
    broadcast();
  });

  ipcMain.on("dock-reorder", (_e, order: string[]) => {
    if (!Array.isArray(order)) return;
    const current = new Set(getPreference<string[]>("dockApps", []));
    const sanitized = order.filter((id) => current.has(id));
    for (const id of current) if (!sanitized.includes(id)) sanitized.push(id);
    setPreference("dockApps", sanitized);
    broadcast();
  });

  // Seed the default pinned apps on first run (null = never set). Once the user
  // edits the dock the persisted list — including an empty one — is respected.
  if (getPreference<string[] | null>("dockApps", null) === null) {
    setPreference("dockApps", DEFAULT_DOCK_APPS);
  }

  // Apply initial state on boot.
  refreshDock();

  return { refreshDock };
}
