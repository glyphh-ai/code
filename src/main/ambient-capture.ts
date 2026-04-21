/**
 * AmbientCapture — background content indexing for all open panels.
 *
 * Periodically runs smartGrab on each loaded panel, detects changes
 * via MD5 hash, and ingests clean content into the UnifiedStore.
 * Zero LLM cost — content extraction is pure DOM targeting.
 */

import crypto from "crypto";
import type { PanelManager } from "./panel-manager";
import type { AppConnector } from "./app-connector";
import type { UnifiedStore } from "./unified-store";
import { smartGrab } from "./smart-grab";

const INTERVAL_MS = 30_000;
const MIN_CONTENT_LENGTH = 30;

export class AmbientCapture {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastHashes = new Map<string, string>();
  private capturing = false;

  constructor(
    private panels: PanelManager,
    private appConnector: AppConnector,
    private store: UnifiedStore,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.captureAll(), INTERVAL_MS);
    setTimeout(() => this.captureAll(), 8000);
    console.log(`[ambient] started (${INTERVAL_MS / 1000}s interval)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async captureAll(): Promise<number> {
    if (this.capturing) return 0;
    this.capturing = true;
    let count = 0;

    try {
      const loadedIds = this.panels.getLoadedPanelIds();
      for (const id of loadedIds) {
        const app = this.appConnector.get(id);
        const url = app?.url || "";
        if (url.startsWith("yo://")) continue;

        const wc = this.panels.getWebContents(id);
        if (!wc || wc.isDestroyed() || wc.isLoading()) continue;

        try {
          const captured = await this.capturePanel(id, app?.name || id);
          if (captured) count++;
        } catch {
          // Non-fatal
        }
      }
    } finally {
      this.capturing = false;
    }

    if (count > 0) console.log(`[ambient] captured ${count} panel(s)`);
    return count;
  }

  private async capturePanel(panelId: string, name: string): Promise<boolean> {
    const wc = this.panels.getWebContents(panelId);
    if (!wc || wc.isDestroyed() || wc.isLoading()) return false;

    const content = await smartGrab(wc);
    if (!content || content.trim().length < MIN_CONTENT_LENGTH) return false;

    const hash = crypto.createHash("md5").update(content).digest("hex");
    if (this.lastHashes.get(panelId) === hash) return false;
    this.lastHashes.set(panelId, hash);

    await this.store.ingest({
      type: "capture",
      source: name,
      content,
      appId: panelId,
    });

    return true;
  }
}
