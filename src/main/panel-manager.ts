/**
 * PanelManager — manages webview panels.
 *
 * Each panel is a BrowserView loading a native AI web UI.
 * Panels persist in background when hidden (no reload on switch).
 * dip commands route through here.
 */

import { BrowserWindow, BrowserView, WebContents, session } from "electron";

export interface PanelConfig {
  id: string;
  name: string;
  url: string;
  preload?: string;
}

export type PanelCreatedCallback = (id: string, webContents: WebContents) => void;

export type PanelReadyCallback = (id: string, webContents: WebContents) => void;

export class PanelManager {
  private static readonly SCROLLBAR_CSS = `
    *::-webkit-scrollbar { width: 6px; height: 6px; }
    *::-webkit-scrollbar-track { background: transparent; }
    *::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.1);
      border-radius: 3px;
    }
    *::-webkit-scrollbar-thumb:hover {
      background: rgba(168, 85, 247, 0.45);
    }
    *::-webkit-scrollbar-corner { background: transparent; }
  `;

  private static permissionsConfigured = false;

  private panels: Map<string, BrowserView> = new Map();
  private configs: Map<string, PanelConfig> = new Map();
  private activePanel: string | null = null;
  private previousPanel: string | null = null;
  private onCreated: PanelCreatedCallback | null = null;
  private onReady: PanelReadyCallback | null = null;
  private zoomFactor = 1.0;
  private _animating = false;
  private onZoomChange: ((factor: number) => void) | null = null;

  constructor(onPanelCreated?: PanelCreatedCallback) {
    this.onCreated = onPanelCreated ?? null;
    PanelManager.setupPermissions();
  }

  /** Configure permission handlers on the persist:yo session (once) */
  private static setupPermissions(): void {
    if (PanelManager.permissionsConfigured) return;
    PanelManager.permissionsConfigured = true;

    const ses = session.fromPartition("persist:yo");

    // Grant common permissions web apps need
    const ALLOWED_PERMISSIONS = new Set([
      "clipboard-read", "clipboard-sanitized-write",
      "notifications", "fullscreen",
      "pointerLock", "media",
      "display-capture", "mediaKeySystem",
      "local-fonts", "window-management",
      "idle-detection", "storage-access",
      "file-system", "fileSystem",
    ]);

    ses.setPermissionRequestHandler((_wc, permission, callback) => {
      // File System Access API (showDirectoryPicker, etc.) uses "fileSystem"
      if ((permission as string) === "fileSystem") { callback(true); return; }
      callback(ALLOWED_PERMISSIONS.has(permission));
    });

    ses.setPermissionCheckHandler((_wc, permission) => {
      if ((permission as string) === "fileSystem") return true;
      return ALLOWED_PERMISSIONS.has(permission);
    });
  }

  /** Register callback for when a panel becomes active (after switch or page load). */
  setOnPanelReady(cb: PanelReadyCallback): void {
    this.onReady = cb;
  }

  /** Register callback for when zoom changes (to persist preference). */
  setOnZoomChange(cb: (factor: number) => void): void {
    this.onZoomChange = cb;
  }

  /** Whether a slide animation is in progress */
  get isAnimating(): boolean { return this._animating; }

  /** Register a custom panel (dip add <url>) */
  addPanel(id: string, url: string, preload?: string): void {
    this.configs.set(id, { id, name: id, url, preload });
  }

  /** Get or create a panel's BrowserView (public for layout manager) */
  getOrCreateView(id: string, parent: BrowserWindow): BrowserView | null {
    return this.getOrCreate(id, parent);
  }

  private getOrCreate(id: string, parent: BrowserWindow): BrowserView | null {
    if (this.panels.has(id)) {
      const existing = this.panels.get(id)!;
      // If the view or its webContents was destroyed, drop it and recreate
      try {
        if (!existing.webContents || existing.webContents.isDestroyed()) {
          this.panels.delete(id);
        } else {
          return existing;
        }
      } catch {
        this.panels.delete(id);
      }
    }

    const config = this.configs.get(id);
    if (!config) return null;

    const isLocal = config.url.startsWith("file://");

    const view = new BrowserView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        partition: isLocal ? undefined : "persist:yo",
        ...(config.preload ? { preload: config.preload } : {}),
      },
    });

    if (!isLocal) {
      // Set a modern Chrome user agent so sites don't flag Electron's bundled Chromium as outdated
      view.webContents.setUserAgent(
        view.webContents.getUserAgent().replace(/Electron\/\S+\s*/g, "").replace(/\s+/g, " ").trim()
      );
    }

    // Block native app protocol redirects (slack://, zoommtg://, etc.)
    view.webContents.on("will-navigate", (e, url) => {
      if (isLocal && url.startsWith("file://")) return;
      if (!url.startsWith("http://") && !url.startsWith("https://") && !url.startsWith("about:")) {
        e.preventDefault();
      }
    });
    const popupOptions = {
      action: "allow" as const,
      overrideBrowserWindowOptions: {
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          partition: isLocal ? undefined : "persist:yo",
        },
      },
    };

    view.webContents.setWindowOpenHandler(({ url }) => {
      // Block native app protocol redirects (slack://, zoommtg://, etc.)
      if (!url.startsWith("http://") && !url.startsWith("https://") && !url.startsWith("about:")) {
        return { action: "deny" };
      }
      // Allow JS-driven dialogs (about:blank popups populated via script)
      if (url === "about:blank" || url === "") {
        return popupOptions;
      }
      // Allow same-origin popups (app dialogs, pickers, etc.)
      try {
        const panelOrigin = new URL(config.url).origin;
        const popupOrigin = new URL(url).origin;
        if (popupOrigin === panelOrigin) return popupOptions;
      } catch { /* invalid URL, fall through */ }
      // Allow OAuth popups (Google, GitHub, etc.)
      if (url.includes("accounts.google.com") || url.includes("github.com/login") || url.includes("auth") || url.includes("oauth") || url.includes("signin")) {
        return popupOptions;
      }
      // Cross-origin links: open in the same view instead of a popup
      view.webContents.loadURL(url);
      return { action: "deny" };
    });

    // Configure popup windows created from this panel
    view.webContents.on("did-create-window", (childWindow) => {
      // Ensure popup is visible and focused
      childWindow.once("ready-to-show", () => {
        childWindow.show();
        childWindow.focus();
      });
      // Share user agent with parent
      if (!isLocal) {
        childWindow.webContents.setUserAgent(view.webContents.getUserAgent());
      }
    });

    // Intercept Cmd/Ctrl shortcuts so they work even when a panel has focus
    view.webContents.on("before-input-event", (e, input) => {
      if (!input.meta && !input.control) return;
      if (input.type !== "keyDown") return;
      if (input.key === "=" || input.key === "+") {
        e.preventDefault();
        this.setZoom(this.zoomFactor + 0.1);
      } else if (input.key === "-") {
        e.preventDefault();
        this.setZoom(this.zoomFactor - 0.1);
      } else if (input.key === "0") {
        e.preventDefault();
        this.setZoom(1.0);
      } else if (input.key === "r") {
        e.preventDefault();
        this.refresh(this.activePanel ?? undefined);
      } else if (input.key === "i" && (input.alt || input.shift)) {
        // Cmd+Opt+I (mac) or Ctrl+Shift+I (win/linux) — DevTools for active panel
        e.preventDefault();
        this.toggleDevTools();
      }
    });

    view.webContents.loadURL(config.url);
    view.webContents.on("did-finish-load", () => {
      view.webContents.setZoomFactor(this.zoomFactor);
      // Inject thin scrollbar styles into all panels
      view.webContents.insertCSS(PanelManager.SCROLLBAR_CSS).catch(() => {});
      if (this.activePanel === id) {
        this.onReady?.(id, view.webContents);
      }
    });
    this.panels.set(id, view);
    this.onCreated?.(id, view.webContents);
    return view;
  }

  /** Switch to a panel with slide animation (dip <id>) */
  switchTo(id: string, parent: BrowserWindow, direction: "left" | "right" = "left"): boolean {
    if (parent.isDestroyed()) return false;
    const view = this.getOrCreate(id, parent);
    if (!view) return false;

    const oldId = this.activePanel;
    if (oldId) this.previousPanel = oldId;
    this.activePanel = id;

    const [w, h] = parent.getContentSize();
    const finalBounds = { x: 0, y: 38, width: w, height: h - 38 };

    // No animation if same panel, hidden, or already animating
    if (oldId === id || this._hidden || this._animating) {
      parent.setBrowserView(view);
      view.setBounds(finalBounds);
      view.setAutoResize({ width: true, height: true });
      this.onReady?.(id, view.webContents);
      return true;
    }

    const oldViews = parent.getBrowserViews();
    const oldBounds = oldViews.map((v) => ({ view: v, bounds: { ...v.getBounds() } }));

    // Position new view off-screen
    const offset = direction === "left" ? w : -w;
    view.setBounds({ ...finalBounds, x: offset });
    view.setAutoResize({ width: false, height: false });
    parent.addBrowserView(view);

    this.slideViews(
      parent, oldBounds,
      [{ view, finalBounds }],
      offset,
      220,
      () => {
        view.setAutoResize({ width: true, height: true });
        this.onReady?.(id, view.webContents);
      },
    );
    return true;
  }

  /** Switch to previous panel — slides in from the left */
  switchBack(parent: BrowserWindow): boolean {
    if (!this.previousPanel) return false;
    return this.switchTo(this.previousPanel, parent, "right");
  }

  /** Animate old views out + new views in (carousel slide) */
  slideViews(
    parent: BrowserWindow,
    oldViews: Array<{ view: BrowserView; bounds: Electron.Rectangle }>,
    newViews: Array<{ view: BrowserView; finalBounds: Electron.Rectangle }>,
    offset: number,
    duration = 220,
    onDone?: () => void,
  ) {
    this._animating = true;
    const newSet = new Set(newViews.map((n) => n.view));
    const start = Date.now();

    const tick = () => {
      const elapsed = Date.now() - start;
      const t = Math.min(elapsed / duration, 1);
      // Ease-out cubic
      const ease = 1 - Math.pow(1 - t, 3);

      // Slide old views out
      for (const { view, bounds } of oldViews) {
        if (newSet.has(view)) continue;
        try {
          view.setBounds({
            ...bounds,
            x: Math.round(bounds.x - offset * ease),
          });
        } catch { /* view may have been destroyed */ }
      }

      // Slide new views in
      for (const { view, finalBounds } of newViews) {
        view.setBounds({
          ...finalBounds,
          x: Math.round(finalBounds.x + offset * (1 - ease)),
        });
      }

      if (t < 1) {
        setTimeout(tick, 16);
      } else {
        // Animation done — clean up
        this._animating = false;
        for (const { view } of oldViews) {
          if (!newSet.has(view)) {
            try { parent.removeBrowserView(view); } catch {}
          }
        }
        for (const { view, finalBounds } of newViews) {
          view.setBounds(finalBounds);
          view.setAutoResize({ width: false, height: false });
        }
        onDone?.();
      }
    };
    tick();
  }

  /** Get the active panel's webContents */
  get activeWebContents() {
    if (!this.activePanel) return null;
    return this.panels.get(this.activePanel)?.webContents ?? null;
  }

  /** Get active panel ID */
  get activePanelId(): string | null {
    return this.activePanel;
  }

  /** Get the previously active panel ID */
  get previousPanelId(): string | null {
    return this.previousPanel;
  }

  /** Whether panels are currently hidden for overlay */
  get isHidden(): boolean {
    return this._hidden;
  }
  set hidden(v: boolean) {
    this._hidden = v;
  }
  private _hidden = false;

  /** Capture screenshots of all visible BrowserViews (for freeze-frame during hide) */
  async captureScreenshots(parent: BrowserWindow): Promise<Array<{ dataUrl: string; bounds: Electron.Rectangle }>> {
    const results: Array<{ dataUrl: string; bounds: Electron.Rectangle }> = [];
    for (const bv of parent.getBrowserViews()) {
      try {
        const bounds = bv.getBounds();
        const image = await bv.webContents.capturePage();
        if (!image.isEmpty()) {
          results.push({ dataUrl: image.toDataURL(), bounds });
        }
      } catch { /* view may have been destroyed */ }
    }
    return results;
  }

  /** Hide ALL BrowserViews (for overlay support) */
  hideActive(parent: BrowserWindow): void {
    this._hidden = true;
    for (const bv of parent.getBrowserViews()) {
      try { parent.removeBrowserView(bv); } catch { /* already destroyed */ }
    }
  }

  /** Restore the active panel's BrowserView */
  showActive(parent: BrowserWindow): void {
    this._hidden = false;
    if (this.activePanel) {
      this.switchTo(this.activePanel, parent);
    }
  }

  /** Set zoom for all panels */
  setZoom(factor: number): void {
    this.zoomFactor = Math.max(0.5, Math.min(2.0, factor));
    for (const view of this.panels.values()) {
      view.webContents.setZoomFactor(this.zoomFactor);
    }
    this.onZoomChange?.(this.zoomFactor);
  }

  /** Get current zoom factor */
  getZoom(): number {
    return this.zoomFactor;
  }

  /** Toggle DevTools for a panel (or active panel if no id given) */
  toggleDevTools(id?: string): boolean {
    const targetId = id ?? this.activePanel;
    if (!targetId) return false;
    const view = this.panels.get(targetId);
    if (!view) return false;
    if (view.webContents.isDevToolsOpened()) {
      view.webContents.closeDevTools();
    } else {
      view.webContents.openDevTools({ mode: "detach" });
    }
    return true;
  }

  /** Reload a panel (or all visible panels if no id given) */
  refresh(id?: string): boolean {
    if (id) {
      const view = this.panels.get(id);
      if (!view) return false;
      view.webContents.reload();
      return true;
    }
    // Refresh active panel
    if (this.activePanel) {
      return this.refresh(this.activePanel);
    }
    return false;
  }

  /** Get a panel's webContents by ID (null if not yet created) */
  getWebContents(id: string): WebContents | null {
    return this.panels.get(id)?.webContents ?? null;
  }

  /** Check if a panel config exists */
  hasPanel(id: string): boolean {
    return this.configs.has(id);
  }
}
