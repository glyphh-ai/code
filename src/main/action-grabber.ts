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

/** Content shorter than this is noise (empty pages, placeholders). */
const MIN_CONTENT_LENGTH = 200;

/** Similarity threshold — skip if content is this similar to last capture. */
const SIMILARITY_THRESHOLD = 0.92;

/** Panels to skip (internal yo:// panels, terminals, etc). */
const SKIP_PREFIXES = ["yo:", "term", "devtools"];

export class ActionGrabber {
  private captureStore: CaptureStore | null = null;
  private appConnector: AppConnector | null = null;
  private lastHashes = new Map<string, string>();
  private lastContent = new Map<string, string>();
  private lastCaptureTimes = new Map<string, number>();
  private inFlight = new Set<string>();
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
    this.lastHashes.delete(panelId);
    this.lastContent.delete(panelId);
    setTimeout(() => this.captureIfChanged(panelId), 1500);
    setTimeout(() => this.captureIfChanged(panelId), 4000);
  }

  /** Called when a page finishes loading (initial load or reload). */
  async onPageLoad(panelId: string): Promise<void> {
    // Chat SPAs can take a while to hydrate — retry capture at 2s and 5s
    setTimeout(() => this.captureIfChanged(panelId), 2000);
    setTimeout(() => this.captureIfChanged(panelId), 5000);
  }

  /** Called on in-page navigation (SPA route changes, hash changes). */
  async onInPageNavigate(panelId: string): Promise<void> {
    // SPA navigation — clear previous hash so next capture isn't deduped
    // against the old conversation's content
    this.lastHashes.delete(panelId);
    this.lastContent.delete(panelId);
    setTimeout(() => this.captureIfChanged(panelId), 1500);
    setTimeout(() => this.captureIfChanged(panelId), 4000);
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
    if (this.inFlight.has(panelId)) return;

    const now = Date.now();
    const lastTime = this.lastCaptureTimes.get(panelId) || 0;
    if (now - lastTime < DEBOUNCE_MS) return;

    this.inFlight.add(panelId);
    try {
      await this._doCapture(panelId, now);
    } finally {
      this.inFlight.delete(panelId);
    }
  }

  private async _doCapture(panelId: string, now: number): Promise<void> {
    const wc = this.wcGetter!(panelId);
    if (!wc || wc.isDestroyed()) return;

    // Quick hash check — skip if nothing changed at all
    const hash = await contentHash(wc);
    if (!hash) return;
    const prevHash = this.lastHashes.get(panelId);
    if (hash === prevHash) return;

    const content = await smartGrab(wc);
    if (!content || content.length < MIN_CONTENT_LENGTH) return;

    // Similarity check — skip if content is nearly identical to last capture
    const prev = this.lastContent.get(panelId);
    if (prev && textSimilarity(prev, content) > SIMILARITY_THRESHOLD) {
      this.lastHashes.set(panelId, hash);
      return;
    }

    this.lastHashes.set(panelId, hash);
    this.lastContent.set(panelId, content);
    this.lastCaptureTimes.set(panelId, now);

    // For conversational panels, use a URL-derived source key so each
    // conversation gets its own entry (e.g. "claude:chat/abc123" instead
    // of just "claude"). This prevents deduplicate from wiping unrelated
    // conversations and prevents incremental from fragmenting streams.
    const sourceKey = this.deriveSourceKey(panelId, wc);

    try {
      await this.captureStore!.ingest(sourceKey, content);
    } catch (err) {
      console.error("[action-grabber] ingest failed:", panelId, err);
    }
  }

  private deriveSourceKey(panelId: string, wc: WebContents): string {
    if (!this.appConnector?.isConversational(panelId)) return panelId;
    try {
      const url = new URL(wc.getURL());
      const pathKey = url.pathname.replace(/^\//, "").replace(/\//g, ":") || "";
      if (pathKey && pathKey !== panelId) return `${panelId}:${pathKey}`;
    } catch {}
    return panelId;
  }
}

/** Fast trigram-based similarity (0–1). Avoids O(n*m) edit distance. */
function textSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;

  const trigramsA = trigrams(a);
  const trigramsB = trigrams(b);
  if (trigramsA.size === 0 && trigramsB.size === 0) return 1;

  let intersection = 0;
  for (const t of trigramsA) {
    if (trigramsB.has(t)) intersection++;
  }
  return (2 * intersection) / (trigramsA.size + trigramsB.size);
}

function trigrams(text: string): Set<string> {
  const s = new Set<string>();
  const t = text.toLowerCase();
  for (let i = 0; i <= t.length - 3; i++) {
    s.add(t.slice(i, i + 3));
  }
  return s;
}
