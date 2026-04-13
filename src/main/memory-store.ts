/**
 * MemoryStore — silent auto-capture of panel content.
 *
 * Stores raw text snapshots in ~/yo/memory/{app}/{timestamp}.md
 * with a manifest index at ~/yo/memory/manifest.json.
 * Content-hash deduplication prevents redundant writes.
 */

import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";

export interface MemoryEntry {
  id: string;
  app: string;
  timestamp: number;
  preview: string;
  hash: string;
  file: string;
}

export class MemoryStore {
  private root: string;
  private manifest: MemoryEntry[] = [];
  private manifestPath: string;
  private lastHashes = new Map<string, string>(); // app → last content hash

  constructor() {
    this.root = path.join(os.homedir(), "yo", "memory");
    this.manifestPath = path.join(this.root, "manifest.json");
    fs.mkdirSync(this.root, { recursive: true });
    this.loadManifest();
  }

  /** Store a snapshot from an app panel. Returns false if content is unchanged (dedup). */
  capture(app: string, content: string): boolean {
    if (!content || content.trim().length < 20) return false;

    const hash = crypto.createHash("md5").update(content).digest("hex");

    // Dedup: skip if this app's content hasn't changed
    if (this.lastHashes.get(app) === hash) return false;
    this.lastHashes.set(app, hash);

    const now = Date.now();
    const appDir = path.join(this.root, this.safeName(app));
    fs.mkdirSync(appDir, { recursive: true });

    const fileName = `${now}.md`;
    const filePath = path.join(appDir, fileName);
    fs.writeFileSync(filePath, content, "utf-8");

    const entry: MemoryEntry = {
      id: `${app}-${now}`,
      app,
      timestamp: now,
      preview: content.slice(0, 200).replace(/\n/g, " ").trim(),
      hash,
      file: path.join(this.safeName(app), fileName),
    };

    this.manifest.push(entry);
    this.saveManifest();
    return true;
  }

  /** Get the manifest for LLM search (newest first, optional limit). */
  getManifest(limit?: number): MemoryEntry[] {
    const sorted = [...this.manifest].sort((a, b) => b.timestamp - a.timestamp);
    return limit ? sorted.slice(0, limit) : sorted;
  }

  /** Build a compact text manifest for Claude to search. */
  buildSearchContext(limit = 200): string {
    const entries = this.getManifest(limit);
    if (entries.length === 0) return "No captured content yet.";

    return entries.map((e) => {
      const date = new Date(e.timestamp);
      const dateStr = date.toLocaleDateString("en-US", {
        weekday: "short", month: "short", day: "numeric",
      });
      const timeStr = date.toLocaleTimeString("en-US", {
        hour: "numeric", minute: "2-digit",
      });
      return `[${e.id}] ${dateStr} ${timeStr} | ${e.app} | ${e.preview}`;
    }).join("\n");
  }

  /** Get the most recent capture for an app. */
  getLatest(app: string): string | null {
    const entries = this.manifest
      .filter((e) => e.app === app)
      .sort((a, b) => b.timestamp - a.timestamp);
    if (entries.length === 0) return null;
    return this.read(entries[0].id);
  }

  /** Read the full content of a memory entry by ID. */
  read(id: string): string | null {
    const entry = this.manifest.find((e) => e.id === id);
    if (!entry) return null;
    const filePath = path.join(this.root, entry.file);
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, "utf-8");
  }

  /** Clean up entries older than maxAge (ms). Default 30 days. */
  prune(maxAge = 30 * 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAge;
    const toRemove = this.manifest.filter((e) => e.timestamp < cutoff);

    for (const entry of toRemove) {
      const filePath = path.join(this.root, entry.file);
      try { fs.unlinkSync(filePath); } catch { /* already gone */ }
    }

    this.manifest = this.manifest.filter((e) => e.timestamp >= cutoff);
    this.saveManifest();
    return toRemove.length;
  }

  /** Total number of entries. */
  get size(): number {
    return this.manifest.length;
  }

  private safeName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, "-");
  }

  private loadManifest(): void {
    try {
      if (fs.existsSync(this.manifestPath)) {
        this.manifest = JSON.parse(fs.readFileSync(this.manifestPath, "utf-8"));
        // Rebuild last hashes from most recent entry per app
        for (const entry of this.manifest) {
          this.lastHashes.set(entry.app, entry.hash);
        }
      }
    } catch {
      this.manifest = [];
    }
  }

  private saveManifest(): void {
    fs.writeFileSync(this.manifestPath, JSON.stringify(this.manifest), "utf-8");
  }
}
