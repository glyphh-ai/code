/**
 * PanelManager — manages webview panels.
 *
 * Each panel is a BrowserView loading a native AI web UI.
 * Panels persist in background when hidden (no reload on switch).
 * dip commands route through here.
 */

import { BrowserWindow, BrowserView } from "electron";

export interface PanelConfig {
  id: string;
  name: string;
  url: string;
}

// Built-in panels
const BUILTIN_PANELS: PanelConfig[] = [
  { id: "claude", name: "Claude", url: "https://claude.ai" },
  { id: "gemini", name: "Gemini", url: "https://gemini.google.com" },
  { id: "gpt", name: "ChatGPT", url: "https://chatgpt.com" },
  { id: "code", name: "Claude Code", url: "https://claude.ai/code" },
  { id: "cowork", name: "Cowork", url: "https://claude.ai/cowork" },
];

export class PanelManager {
  private panels: Map<string, BrowserView> = new Map();
  private configs: Map<string, PanelConfig> = new Map();
  private activePanel: string | null = null;
  private previousPanel: string | null = null;

  constructor() {
    for (const config of BUILTIN_PANELS) {
      this.configs.set(config.id, config);
    }
  }

  /** Register a custom panel (dip add <url>) */
  addPanel(id: string, url: string): void {
    this.configs.set(id, { id, name: id, url });
  }

  /** Get or create a panel's BrowserView */
  private getOrCreate(id: string, parent: BrowserWindow): BrowserView | null {
    if (this.panels.has(id)) {
      return this.panels.get(id)!;
    }

    const config = this.configs.get(id);
    if (!config) return null;

    const view = new BrowserView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        partition: `persist:panel-${id}`,
      },
    });

    view.webContents.loadURL(config.url);
    this.panels.set(id, view);
    return view;
  }

  /** Switch to a panel (dip <id>) */
  switchTo(id: string, parent: BrowserWindow): boolean {
    const view = this.getOrCreate(id, parent);
    if (!view) return false;

    // Hide current
    if (this.activePanel) {
      this.previousPanel = this.activePanel;
    }

    // Show new
    parent.setBrowserView(view);
    const bounds = parent.getBounds();
    // Leave room for command bar at top (48px)
    view.setBounds({
      x: 0,
      y: 48,
      width: bounds.width,
      height: bounds.height - 48,
    });
    view.setAutoResize({ width: true, height: true });

    this.activePanel = id;
    return true;
  }

  /** Switch to previous panel (dip back) */
  switchBack(parent: BrowserWindow): boolean {
    if (!this.previousPanel) return false;
    return this.switchTo(this.previousPanel, parent);
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

  /** List all registered panels */
  listPanels(): PanelConfig[] {
    return Array.from(this.configs.values());
  }
}
