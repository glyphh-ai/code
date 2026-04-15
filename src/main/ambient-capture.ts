/**
 * AmbientCapture — background content indexing for all open panels.
 *
 * Runs on a timer, silently extracts content from each panel's WebContents,
 * detects changes via MD5 hash, and stores chunks in the ContextStore.
 */

import { PanelManager } from "./panel-manager";
import { AppConnector } from "./app-connector";
import { ContextStore } from "./context-store";
import { executeCommand } from "./dom-bridge";
import crypto from "crypto";

const DEFAULT_INTERVAL_MS = 45_000; // 45 seconds
const MIN_CONTENT_LENGTH = 50;
const MAX_CONTENT_LENGTH = 50_000;

export class AmbientCapture {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastHashes = new Map<string, string>();
  private capturing = false;

  constructor(
    private panels: PanelManager,
    private appConnector: AppConnector,
    private contextStore: ContextStore,
    private intervalMs: number = DEFAULT_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.captureAll(), this.intervalMs);
    // Initial capture after a short delay (let panels load)
    setTimeout(() => this.captureAll(), 5000);
    console.log(`[ambient] started (${this.intervalMs / 1000}s interval)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log("[ambient] stopped");
    }
  }

  private async captureAll(): Promise<void> {
    if (this.capturing) return;
    this.capturing = true;

    try {
      const apps = this.appConnector.list();
      for (const app of apps) {
        // Skip internal panels
        if (app.url.startsWith("yo://")) continue;
        try {
          await this.capturePanel(app.id, app.url, app.name);
        } catch {
          // Silently skip panels that fail
        }
      }
    } finally {
      this.capturing = false;
    }
  }

  private async capturePanel(panelId: string, configUrl: string, name: string): Promise<void> {
    const wc = this.panels.getWebContents(panelId);
    if (!wc || wc.isDestroyed() || wc.isLoading()) return;

    // Extract text — prefer app-specific grab command, fall back to innerText
    let text = "";
    const appConfig = this.appConnector.get(panelId);
    if (appConfig?.commands.grab) {
      try {
        text = await executeCommand(wc, appConfig.commands.grab);
      } catch {}
    }
    if (!text || text.startsWith("[Element not found")) {
      try {
        text = await wc.executeJavaScript(
          `document.body.innerText.slice(0, ${MAX_CONTENT_LENGTH})`
        );
      } catch {
        return;
      }
    }

    if (!text || text.trim().length < MIN_CONTENT_LENGTH) return;

    // Fast hash check — skip if content hasn't changed
    const hash = crypto.createHash("md5").update(text).digest("hex");
    if (this.lastHashes.get(panelId) === hash) return;
    this.lastHashes.set(panelId, hash);

    // Get page title and current URL
    let title = name;
    try {
      const pageTitle = await wc.executeJavaScript("document.title || ''");
      if (pageTitle) title = pageTitle;
    } catch {}

    let currentUrl = configUrl;
    try {
      currentUrl = wc.getURL() || configUrl;
    } catch {}

    // Store in context store (handles chunking + FTS indexing)
    const stored = this.contextStore.insertCapture(panelId, currentUrl, title, text);
    if (stored) {
      console.log(`[ambient] captured ${panelId} (${text.length} chars)`);
    }
  }
}
