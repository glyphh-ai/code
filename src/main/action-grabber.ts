/**
 * ActionGrabber — event-driven + polling capture for the context store.
 *
 * Captures content from panels on user actions:
 *   - Panel blur (user switches away)
 *   - Navigation (URL changes, page finished loading)
 *   - Polling (conversational panels checked every POLL_INTERVAL_MS)
 *
 * Uses content hashing to detect deltas — only ingests when
 * the content has actually changed since the last capture.
 */

import { WebContents } from "electron";
import { smartGrab, contentHash } from "./smart-grab";
import type { CaptureStore } from "./capture-store";
import type { AppConnector } from "./app-connector";

/** Minimum ms between captures of the same panel. */
const DEBOUNCE_MS = 3000;

/** Polling interval for conversational panels. */
const POLL_INTERVAL_MS = 8000;

/** Panels to skip (internal yo:// panels, terminals, etc). */
const SKIP_PREFIXES = ["yo:", "term", "devtools"];

export class ActionGrabber {
  private captureStore: CaptureStore | null = null;
  private appConnector: AppConnector | null = null;
  private lastHashes = new Map<string, string>();
  private lastCaptureTimes = new Map<string, number>();
  private wcGetter: ((id: string) => WebContents | null) | null = null;
  private panelIdGetter: (() => string[]) | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  setCaptureStore(store: CaptureStore): void {
    this.captureStore = store;
  }

  setAppConnector(connector: AppConnector): void {
    this.appConnector = connector;
  }

  setWebContentsGetter(fn: (id: string) => WebContents | null): void {
    this.wcGetter = fn;
  }

  setPanelIdGetter(fn: () => string[]): void {
    this.panelIdGetter = fn;
  }

  /** Start polling conversational panels for content changes. */
  startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.pollConversationalPanels(), POLL_INTERVAL_MS);
  }

  /** Stop the polling loop. */
  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Called when a panel loses focus (user switched away). */
  async onPanelBlur(panelId: string): Promise<void> {
    await this.captureIfChanged(panelId);
  }

  /** Called when a panel finishes navigating to a new URL. */
  async onPanelNavigate(panelId: string): Promise<void> {
    // Small delay to let the page render after navigation
    setTimeout(() => this.captureIfChanged(panelId), 1500);
  }

  private async pollConversationalPanels(): Promise<void> {
    if (!this.panelIdGetter || !this.appConnector) return;

    const ids = this.panelIdGetter();
    for (const id of ids) {
      if (this.shouldSkip(id)) continue;
      if (!this.appConnector.isConversational(id)) continue;
      this.captureIfChanged(id).catch(() => {});
    }
  }

  private shouldSkip(panelId: string): boolean {
    if (SKIP_PREFIXES.some((p) => panelId.startsWith(p))) return true;
    if (this.appConnector?.isDoNotRecord(panelId)) return true;
    return false;
  }

  private async captureIfChanged(panelId: string): Promise<void> {
    if (!this.captureStore || !this.wcGetter) return;
    if (this.shouldSkip(panelId)) return;

    // Debounce — don't capture same panel too frequently
    const now = Date.now();
    const lastTime = this.lastCaptureTimes.get(panelId) || 0;
    if (now - lastTime < DEBOUNCE_MS) return;

    const wc = this.wcGetter(panelId);
    if (!wc || wc.isDestroyed()) return;

    // Check content hash — only capture if content changed
    const hash = await contentHash(wc);
    if (!hash) return;

    const prevHash = this.lastHashes.get(panelId);
    if (hash === prevHash) return;

    // Content changed — grab and ingest
    const content = await smartGrab(wc);
    if (!content || content.length < 50) return;

    this.lastHashes.set(panelId, hash);
    this.lastCaptureTimes.set(panelId, now);

    try {
      await this.captureStore.ingest(panelId, content);
    } catch (err) {
      console.error("[action-grabber] ingest failed:", panelId, err);
    }
  }
}
