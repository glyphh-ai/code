/**
 * SessionCache — in-memory capture store for yo/sup.
 *
 * yo captures content → stored here + copied to clipboard.
 * sup reads from here instantly — no disk, no search, no latency.
 *
 * The session is runtime-only. Restart clears it.
 */

import { clipboard } from "electron";

export interface SessionEntry {
  id: string;
  appId: string;
  timestamp: number;
  content: string;
}

export class SessionCache {
  private entries: SessionEntry[] = [];
  private combined = "";

  /** Add captured content from a panel. Replaces any existing entry from the same app. */
  capture(appId: string, content: string): void {
    // Replace existing entry from same app (latest capture wins)
    this.entries = this.entries.filter((e) => e.appId !== appId);
    this.entries.push({
      id: `${appId}-${Date.now()}`,
      appId,
      timestamp: Date.now(),
      content,
    });
    this.rebuildCombined();
  }

  /** Get the combined session content (what sup uses). */
  get(): string {
    return this.combined;
  }

  /** Get all individual entries. */
  getEntries(): SessionEntry[] {
    return [...this.entries];
  }

  /** Check if session has content. */
  hasContent(): boolean {
    return this.combined.length > 0;
  }

  /** Copy current session to system clipboard. */
  copyToClipboard(): void {
    if (this.combined) {
      clipboard.writeText(this.combined);
    }
  }

  /** Clear the session. */
  clear(): void {
    this.entries = [];
    this.combined = "";
  }

  /** Remove a specific entry by app ID. */
  remove(appId: string): void {
    this.entries = this.entries.filter((e) => e.appId !== appId);
    this.rebuildCombined();
  }

  private rebuildCombined(): void {
    if (this.entries.length === 0) {
      this.combined = "";
    } else if (this.entries.length === 1) {
      this.combined = this.entries[0].content;
    } else {
      this.combined = this.entries
        .map((e) => `## ${e.appId}\n\n${e.content}`)
        .join("\n\n---\n\n");
    }
  }
}
