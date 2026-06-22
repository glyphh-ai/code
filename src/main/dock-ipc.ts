/**
 * dock-ipc.ts — macOS-style Dock at the bottom of the workspace.
 *
 * The dock is rendered as DOM chrome in the main renderer (dock-ui.ts). Because
 * app panels are native BrowserViews painted ABOVE the DOM, the dock can only be
 * visible where no BrowserView covers it — so when the dock is showing we
 * reserve a bottom inset (panelManager.setBottomInset) and the dock lives in
 * that uncovered strip.
 *
 * Membership + config live in preferences:
 *   dockEnabled   boolean   master on/off
 *   dockAutoHide  boolean   hide until the cursor approaches the bottom edge
 *   dockScale     number    0.5–2.0 icon scale
 *   dockZoom      boolean   magnify the hovered icon
 *   dockApps      string[]  ordered app ids pinned to the dock
 */
import { ipcMain, screen, webContents } from "electron";
import type { BrowserWindow } from "electron";
import type { PanelManager } from "./panel-manager";

/** Unscaled dock height (icon + padding). Scaled by dockScale. */
const DOCK_BASE_HEIGHT = 68;
/** How close (px) the cursor must get to the bottom edge to reveal an
 *  auto-hidden dock. While revealed, the active zone grows to the dock height
 *  so the dock stays up while the pointer is over it. */
const REVEAL_ZONE = 4;
const POLL_MS = 120;

export interface DockConfig {
  enabled: boolean;
  autoHide: boolean;
  scale: number;
  zoom: boolean;
  apps: string[];
  /** Derived: scaled pixel height of the dock strip. */
  height: number;
}

interface DockIpcDeps {
  panelManager: PanelManager;
  getMainWindow: () => BrowserWindow | null;
  getPreference: <T>(key: string, fallback: T) => T;
  setPreference: (key: string, value: unknown) => void;
}

export function registerDockIpc(deps: DockIpcDeps): { refreshDockInset: () => void } {
  const { panelManager, getMainWindow, getPreference, setPreference } = deps;

  let revealed = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function clampScale(n: number): number {
    if (!Number.isFinite(n)) return 1;
    return Math.max(0.5, Math.min(2.0, n));
  }

  function readConfig(): DockConfig {
    const enabled = getPreference<boolean>("dockEnabled", false);
    const autoHide = getPreference<boolean>("dockAutoHide", true);
    const scale = clampScale(getPreference<number>("dockScale", 1));
    const zoom = getPreference<boolean>("dockZoom", true);
    const apps = getPreference<string[]>("dockApps", []).filter((id) => typeof id === "string");
    return { enabled, autoHide, scale, zoom, apps, height: Math.round(DOCK_BASE_HEIGHT * scale) };
  }

  /** Broadcast the dock config to every renderer/BrowserView (home.html reads it
   *  for the settings + app-editor, index.html for the dock itself). */
  function broadcast(): void {
    const cfg = readConfig();
    for (const wc of webContents.getAllWebContents()) {
      try { wc.send("dock-changed", cfg); } catch { /* ignore */ }
    }
  }

  /** Reserve (or release) the bottom inset based on enabled + auto-hide/reveal. */
  function refreshDockInset(): void {
    const cfg = readConfig();
    const visible = cfg.enabled && (!cfg.autoHide || revealed);
    panelManager.setBottomInset(visible ? cfg.height : 0);
    const win = getMainWindow();
    win?.webContents.send("dock-reveal", { visible, height: cfg.height });
    syncPoll(cfg);
  }

  /** Start/stop the cursor-proximity poll used for auto-hide reveal. The main
   *  renderer can't detect a hover at the bottom edge because a BrowserView
   *  covers it, so we sample the OS cursor instead. */
  function syncPoll(cfg: DockConfig): void {
    const wantPoll = cfg.enabled && cfg.autoHide;
    if (wantPoll && !pollTimer) {
      pollTimer = setInterval(tickReveal, POLL_MS);
    } else if (!wantPoll && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
      if (revealed) { revealed = false; refreshDockInset(); }
    }
  }

  function tickReveal(): void {
    const win = getMainWindow();
    if (!win || win.isDestroyed() || !win.isFocused()) {
      if (revealed) { revealed = false; refreshDockInset(); }
      return;
    }
    const cfg = readConfig();
    const b = win.getContentBounds();
    const pt = screen.getCursorScreenPoint();
    const insideX = pt.x >= b.x && pt.x <= b.x + b.width;
    const bottom = b.y + b.height;
    const zone = revealed ? cfg.height + 12 : REVEAL_ZONE;
    const nearBottom = pt.y >= bottom - zone && pt.y <= bottom + 4;
    const shouldReveal = insideX && nearBottom;
    if (shouldReveal !== revealed) {
      revealed = shouldReveal;
      refreshDockInset();
    }
  }

  // ── IPC ───────────────────────────────────────────────────
  ipcMain.handle("dock-get-config", () => readConfig());

  ipcMain.on("dock-set-config", (_e, patch: Partial<Omit<DockConfig, "height">>) => {
    if (typeof patch.enabled === "boolean") setPreference("dockEnabled", patch.enabled);
    if (typeof patch.autoHide === "boolean") setPreference("dockAutoHide", patch.autoHide);
    if (typeof patch.scale === "number") setPreference("dockScale", clampScale(patch.scale));
    if (typeof patch.zoom === "boolean") setPreference("dockZoom", patch.zoom);
    if (Array.isArray(patch.apps)) setPreference("dockApps", patch.apps.filter((id) => typeof id === "string"));
    revealed = false; // re-evaluate from scratch
    refreshDockInset();
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

  // Apply the initial inset on boot.
  refreshDockInset();

  return { refreshDockInset };
}
