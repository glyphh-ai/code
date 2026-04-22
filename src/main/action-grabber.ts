/**
 * ActionGrabber — event-driven capture for the context store.
 *
 * Captures content from panels on user actions:
 *   - Panel blur (user switches away)
 *   - Navigation (URL changes, page finished loading)
 *
 * Uses content hashing to detect deltas — only ingests when
 * the content has actually changed since the last capture.
 * No timer-based polling. No LLM in the write path.
 */

import { WebContents } from "electron";
import { smartGrab, contentHash } from "./smart-grab";
import type { CaptureStore } from "./capture-store";

/** Minimum ms between captures of the same panel. */
const DEBOUNCE_MS = 3000;

/** Panels to skip (internal yo:// panels, terminals, etc). */
const SKIP_PREFIXES = ["yo:", "term", "devtools"];

export class ActionGrabber {
  private captureStore: CaptureStore | null = null;
  private lastHashes = new Map<string, string>();
  private lastCaptureTimes = new Map<string, number>();
  private wcGetter: ((id: string) => WebContents | null) | null = null;

  setCaptureStore(store: CaptureStore): void {
    this.captureStore = store;
  }

  setWebContentsGetter(fn: (id: string) => WebContents | null): void {
    this.wcGetter = fn;
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

  private shouldSkip(panelId: string): boolean {
    return SKIP_PREFIXES.some((p) => panelId.startsWith(p));
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
