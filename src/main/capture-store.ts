/**
 * CaptureStore — persistent, searchable store for .sup captures.
 *
 * Content is chunked, written to disk immediately, and embedded async
 * via the local ONNX embedder. Vector search uses cosine similarity.
 *
 * Storage layout:
 *   ~/yo/store/
 *     index.json           — Array of CaptureEntryMeta
 *     entries/<id>.md      — Content with YAML frontmatter
 *     entries/<id>.vec     — Binary Float32Array (384-dim)
 */

import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import type { Embedder } from "./embedder";
import type { CapturePolicy } from "./app-connector";

const STORE_DIR = path.join(os.homedir(), "yo", "store");
const INDEX_FILE = path.join(STORE_DIR, "index.json");
const ENTRIES_DIR = path.join(STORE_DIR, "entries");
// Embedder handles 32k tokens (~120k chars). We chunk above 28k chars and
// target 24k per chunk so embeddings represent meaningful spans.
const CHUNK_TARGET = 24000;
const CHUNK_OVERLAP = 1500;
const CHUNK_THRESHOLD = 28000;

export interface CaptureEntryMeta {
  id: string;
  source: string;
  created: number;
  chunkParent?: string;
  contentHash?: string;
  version?: number;
}

export class CaptureStore {
  private index: CaptureEntryMeta[] = [];
  private embedder: Embedder | null = null;
  private embedQueue: CaptureEntryMeta[] = [];
  private draining = false;
  private policyResolver: ((source: string) => CapturePolicy) | null = null;
  private _ingestCount = 0;
  private _searchCount = 0;
  private _ingestBytes = 0;

  constructor() {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.mkdirSync(ENTRIES_DIR, { recursive: true });
    this.loadIndex();
  }

  setEmbedder(embedder: Embedder): void {
    this.embedder = embedder;
    if (this.embedQueue.length > 0) this.drainEmbedQueue();
  }

  setPolicyResolver(resolver: (source: string) => CapturePolicy): void {
    this.policyResolver = resolver;
  }

  // ── Ingest ─────────────────────────────────────────────

  private hashContent(content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
  }

  async ingest(appId: string, content: string): Promise<string> {
    const policy = this.policyResolver?.(appId) ?? { type: "deduplicate" as const };

    switch (policy.type) {
      case "manual":
        return "";
      case "deduplicate":
        return this.ingestDeduplicate(appId, content);
      case "versioned":
        return this.ingestVersioned(appId, content, policy.maxVersions ?? 3);
      case "incremental":
        return this.ingestIncremental(appId, content, policy.minDeltaChars ?? 50);
      case "sliding-window":
        this.pruneWindow(appId, policy.windowHours ?? 24);
        return this.ingestRaw(appId, content);
      case "append":
      default:
        return this.ingestRaw(appId, content);
    }
  }

  /** Append — always write, no dedup. */
  private async ingestRaw(appId: string, content: string): Promise<string> {
    this._ingestCount++;
    this._ingestBytes += Buffer.byteLength(content, "utf-8");
    const hash = this.hashContent(content);

    if (content.length > CHUNK_THRESHOLD) {
      const chunks = this.chunkContent(content);
      const parentId = crypto.randomBytes(6).toString("hex");

      for (let i = 0; i < chunks.length; i++) {
        const chunkId = `${parentId}-${i}`;
        const meta: CaptureEntryMeta = {
          id: chunkId, source: appId, created: Date.now(),
          chunkParent: parentId, contentHash: hash,
        };
        this.writeEntry(chunkId, chunks[i], meta);
        this.index.push(meta);
        this.embedQueue.push(meta);
      }

      this.persistIndex();
      this.drainEmbedQueue();
      return parentId;
    }

    const id = crypto.randomBytes(6).toString("hex");
    const meta: CaptureEntryMeta = {
      id, source: appId, created: Date.now(), contentHash: hash,
    };
    this.writeEntry(id, content, meta);
    this.index.push(meta);
    this.persistIndex();
    this.embedQueue.push(meta);
    this.drainEmbedQueue();
    return id;
  }

  /** Deduplicate — skip if content hash matches most recent from same source, otherwise replace. */
  private async ingestDeduplicate(appId: string, content: string): Promise<string> {
    const hash = this.hashContent(content);
    const existing = this.entriesForSource(appId);
    if (existing.length > 0 && existing[0].contentHash === hash) return "";
    if (existing.length > 0) this.deleteEntriesForSource(appId);
    return this.ingestRaw(appId, content);
  }

  /** Versioned — keep last N ingestions, prune oldest. */
  private async ingestVersioned(appId: string, content: string, maxVersions: number): Promise<string> {
    const hash = this.hashContent(content);
    const existing = this.entriesForSource(appId);
    if (existing.length > 0 && existing[0].contentHash === hash) return "";

    const versions = this.getVersionGroups(appId);
    if (versions.length >= maxVersions) {
      const toPrune = versions.slice(maxVersions - 1);
      for (const group of toPrune) {
        for (const meta of group) this.deleteEntry(meta.id);
      }
    }

    return this.ingestRaw(appId, content);
  }

  /** Incremental — diff against a snapshot reference, only store new content. */
  private async ingestIncremental(appId: string, content: string, minDelta: number): Promise<string> {
    const refPath = path.join(STORE_DIR, `ref-${appId}.txt`);
    let previous = "";
    try { previous = fs.readFileSync(refPath, "utf-8"); } catch {}

    if (previous) {
      const delta = this.extractDelta(previous, content);
      if (delta.length < minDelta) return "";
      fs.writeFileSync(refPath, content, "utf-8");
      return this.ingestRaw(appId, delta);
    }

    fs.writeFileSync(refPath, content, "utf-8");
    return this.ingestRaw(appId, content);
  }

  /** Prune entries older than windowHours for a source. */
  private pruneWindow(appId: string, windowHours: number): void {
    const cutoff = Date.now() - windowHours * 3600000;
    const toDelete = this.index.filter((m) => m.source === appId && m.created < cutoff);
    for (const meta of toDelete) {
      try { fs.unlinkSync(path.join(ENTRIES_DIR, `${meta.id}.md`)); } catch {}
      try { fs.unlinkSync(path.join(ENTRIES_DIR, `${meta.id}.vec`)); } catch {}
    }
    if (toDelete.length > 0) {
      this.index = this.index.filter((m) => !(m.source === appId && m.created < cutoff));
      this.persistIndex();
    }
  }

  /** Get all entries for a source, newest first. */
  private entriesForSource(appId: string): CaptureEntryMeta[] {
    return this.index.filter((m) => m.source === appId).sort((a, b) => b.created - a.created);
  }

  /** Delete all entries for a source and persist index. */
  private deleteEntriesForSource(appId: string): void {
    const toDelete = this.index.filter((m) => m.source === appId);
    for (const meta of toDelete) {
      try { fs.unlinkSync(path.join(ENTRIES_DIR, `${meta.id}.md`)); } catch {}
      try { fs.unlinkSync(path.join(ENTRIES_DIR, `${meta.id}.vec`)); } catch {}
    }
    this.index = this.index.filter((m) => m.source !== appId);
    this.persistIndex();
  }

  /** Group entries by version (chunkParent or individual). Newest first. */
  private getVersionGroups(appId: string): CaptureEntryMeta[][] {
    const entries = this.entriesForSource(appId);
    const groups = new Map<string, CaptureEntryMeta[]>();
    for (const e of entries) {
      const key = e.chunkParent || e.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(e);
    }
    const sorted = Array.from(groups.values()).sort((a, b) => {
      const aTs = Math.max(...a.map((e) => e.created));
      const bTs = Math.max(...b.map((e) => e.created));
      return bTs - aTs;
    });
    return sorted;
  }

  /** Read all content for a source, concatenated. */
  private readAllForSource(appId: string): string | null {
    const entries = this.entriesForSource(appId);
    if (entries.length === 0) return null;
    const parts: string[] = [];
    for (const e of entries) {
      const c = this.readContent(e.id);
      if (c) parts.push(c);
    }
    return parts.join("\n\n");
  }

  /** Extract new content by finding where previous content ends in current. */
  private extractDelta(previous: string, current: string): string {
    if (!previous) return current;

    // Find the best overlap: look for the tail of `previous` at the start/middle of `current`
    // Use progressively shorter suffixes of `previous` to find the match point
    const prevTrimmed = previous.trimEnd();
    const searchLen = Math.min(prevTrimmed.length, 500);
    const tail = prevTrimmed.slice(-searchLen);

    const idx = current.indexOf(tail);
    if (idx !== -1) {
      const after = current.slice(idx + tail.length).trim();
      return after;
    }

    // Fallback: paragraph-level diff — new paragraphs not in previous
    const prevParas = new Set(
      previous.split(/\n{2,}/).map((p) => p.trim().slice(0, 200)).filter(Boolean),
    );
    const newParas = current.split(/\n{2,}/).filter((p) => {
      const key = p.trim().slice(0, 200);
      return key && !prevParas.has(key);
    });
    return newParas.join("\n\n");
  }

  // ── Search ─────────────────────────────────────────────

  async search(query: string, limit = 10): Promise<Array<{ meta: CaptureEntryMeta; content: string; score: number }>> {
    this._searchCount++;
    if (this.index.length === 0) return [];

    // Skip vector search if the embed queue is draining (would block behind it)
    if (this.embedder?.isReady && !this.draining) {
      try {
        const queryVec = await this.embedder.embed(query);
        return this.vectorSearch(queryVec, limit);
      } catch {
        // Fall through to keyword search
      }
    }

    return this.keywordSearch(query, limit);
  }

  recentCaptures(limit = 10): Array<{ meta: CaptureEntryMeta; content: string }> {
    const sorted = [...this.index].sort((a, b) => b.created - a.created).slice(0, limit);
    return sorted.map((meta) => ({
      meta,
      content: this.readContent(meta.id) || "",
    }));
  }

  readContent(id: string): string | null {
    const filepath = path.join(ENTRIES_DIR, `${id}.md`);
    if (!fs.existsSync(filepath)) return null;
    try {
      const raw = fs.readFileSync(filepath, "utf-8");
      const match = raw.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
      return match ? match[1].trim() : raw;
    } catch {
      return null;
    }
  }

  get count(): number { return this.index.length; }

  stats(): { count: number; sources: Record<string, number>; diskBytes: number; oldestTs: number; newestTs: number; embeddedCount: number; ingestCount: number; searchCount: number; ingestBytes: number } {
    const sources: Record<string, number> = {};
    let diskBytes = 0;
    let oldestTs = Infinity;
    let newestTs = 0;
    let embeddedCount = 0;

    for (const meta of this.index) {
      sources[meta.source] = (sources[meta.source] || 0) + 1;
      if (meta.created < oldestTs) oldestTs = meta.created;
      if (meta.created > newestTs) newestTs = meta.created;
      const mdPath = path.join(ENTRIES_DIR, `${meta.id}.md`);
      const vecPath = path.join(ENTRIES_DIR, `${meta.id}.vec`);
      try { diskBytes += fs.statSync(mdPath).size; } catch {}
      if (fs.existsSync(vecPath)) {
        try { diskBytes += fs.statSync(vecPath).size; } catch {}
        embeddedCount++;
      }
    }
    try { diskBytes += fs.statSync(INDEX_FILE).size; } catch {}

    return {
      count: this.index.length,
      sources,
      diskBytes,
      oldestTs: this.index.length > 0 ? oldestTs : 0,
      newestTs,
      embeddedCount,
      ingestCount: this._ingestCount,
      searchCount: this._searchCount,
      ingestBytes: this._ingestBytes,
    };
  }

  listEntries(offset = 0, limit = 50): Array<{ meta: CaptureEntryMeta; snippet: string; size: number }> {
    const sorted = [...this.index].sort((a, b) => b.created - a.created);
    return sorted.slice(offset, offset + limit).map((meta) => {
      const content = this.readContent(meta.id) || "";
      let size = 0;
      try { size = fs.statSync(path.join(ENTRIES_DIR, `${meta.id}.md`)).size; } catch {}
      return { meta, snippet: content.slice(0, 200), size };
    });
  }

  entrySize(id: string): number {
    try { return fs.statSync(path.join(ENTRIES_DIR, `${id}.md`)).size; } catch { return 0; }
  }

  dailyHistory(days = 30): Array<{ date: string; count: number; bytes: number }> {
    const now = new Date();
    const buckets = new Map<string, { count: number; bytes: number }>();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      buckets.set(d.toISOString().slice(0, 10), { count: 0, bytes: 0 });
    }
    const cutoff = now.getTime() - days * 86400000;
    for (const meta of this.index) {
      if (meta.created < cutoff) continue;
      const key = new Date(meta.created).toISOString().slice(0, 10);
      const b = buckets.get(key);
      if (!b) continue;
      b.count++;
      try { b.bytes += fs.statSync(path.join(ENTRIES_DIR, `${meta.id}.md`)).size; } catch {}
    }
    return Array.from(buckets.entries()).map(([date, v]) => ({ date, ...v }));
  }

  deleteEntry(id: string): boolean {
    const idx = this.index.findIndex((m) => m.id === id);
    if (idx === -1) return false;
    this.index.splice(idx, 1);
    this.persistIndex();
    try { fs.unlinkSync(path.join(ENTRIES_DIR, `${id}.md`)); } catch {}
    try { fs.unlinkSync(path.join(ENTRIES_DIR, `${id}.vec`)); } catch {}
    return true;
  }

  statsForSource(source: string): { count: number; diskBytes: number; oldestTs: number; newestTs: number; embeddedCount: number } {
    const entries = this.index.filter((m) => m.source === source);
    let diskBytes = 0;
    let oldestTs = Infinity;
    let newestTs = 0;
    let embeddedCount = 0;

    for (const meta of entries) {
      if (meta.created < oldestTs) oldestTs = meta.created;
      if (meta.created > newestTs) newestTs = meta.created;
      const mdPath = path.join(ENTRIES_DIR, `${meta.id}.md`);
      const vecPath = path.join(ENTRIES_DIR, `${meta.id}.vec`);
      try { diskBytes += fs.statSync(mdPath).size; } catch {}
      if (fs.existsSync(vecPath)) {
        try { diskBytes += fs.statSync(vecPath).size; } catch {}
        embeddedCount++;
      }
    }

    return {
      count: entries.length,
      diskBytes,
      oldestTs: entries.length > 0 ? oldestTs : 0,
      newestTs,
      embeddedCount,
    };
  }

  listEntriesForSource(source: string, offset = 0, limit = 50): Array<{ meta: CaptureEntryMeta; snippet: string; size: number }> {
    const sorted = this.index.filter((m) => m.source === source).sort((a, b) => b.created - a.created);
    return sorted.slice(offset, offset + limit).map((meta) => {
      const content = this.readContent(meta.id) || "";
      let size = 0;
      try { size = fs.statSync(path.join(ENTRIES_DIR, `${meta.id}.md`)).size; } catch {}
      return { meta, snippet: content.slice(0, 200), size };
    });
  }

  dailyHistoryForSource(source: string, days = 30): Array<{ date: string; count: number; bytes: number }> {
    const now = new Date();
    const buckets = new Map<string, { count: number; bytes: number }>();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      buckets.set(d.toISOString().slice(0, 10), { count: 0, bytes: 0 });
    }
    const cutoff = now.getTime() - days * 86400000;
    const entries = this.index.filter((m) => m.source === source);
    for (const meta of entries) {
      if (meta.created < cutoff) continue;
      const key = new Date(meta.created).toISOString().slice(0, 10);
      const b = buckets.get(key);
      if (!b) continue;
      b.count++;
      try { b.bytes += fs.statSync(path.join(ENTRIES_DIR, `${meta.id}.md`)).size; } catch {}
    }
    return Array.from(buckets.entries()).map(([date, v]) => ({ date, ...v }));
  }

  deleteBySource(source: string): number {
    const toDelete = this.index.filter((m) => m.source === source);
    for (const meta of toDelete) {
      try { fs.unlinkSync(path.join(ENTRIES_DIR, `${meta.id}.md`)); } catch {}
      try { fs.unlinkSync(path.join(ENTRIES_DIR, `${meta.id}.vec`)); } catch {}
    }
    this.index = this.index.filter((m) => m.source !== source);
    this.persistIndex();
    return toDelete.length;
  }

  clear(): number {
    const count = this.index.length;
    for (const meta of this.index) {
      try { fs.unlinkSync(path.join(ENTRIES_DIR, `${meta.id}.md`)); } catch {}
      try { fs.unlinkSync(path.join(ENTRIES_DIR, `${meta.id}.vec`)); } catch {}
    }
    this.index = [];
    this.persistIndex();
    return count;
  }

  // ── Chunking ───────────────────────────────────────────

  private deoverlapChunks(chunks: string[]): string {
    if (chunks.length === 0) return "";
    let result = chunks[0];
    for (let i = 1; i < chunks.length; i++) {
      const chunk = chunks[i];
      const searchLen = Math.min(result.length, CHUNK_OVERLAP + 200);
      const tail = result.slice(-searchLen);
      let best = 0;
      for (let len = Math.min(tail.length, chunk.length); len >= 20; len--) {
        if (chunk.startsWith(tail.slice(-len))) { best = len; break; }
      }
      result += "\n\n" + (best > 0 ? chunk.slice(best).trimStart() : chunk);
    }
    return result;
  }

  private chunkContent(content: string): string[] {
    const chunks: string[] = [];
    const paragraphs = content.split(/\n\n+/);
    let current = "";

    for (const para of paragraphs) {
      if (current.length + para.length > CHUNK_TARGET && current.length > 0) {
        chunks.push(current.trim());
        const overlapStart = Math.max(0, current.length - CHUNK_OVERLAP);
        current = current.slice(overlapStart) + "\n\n" + para;
      } else {
        current += (current ? "\n\n" : "") + para;
      }
    }

    if (current.trim()) {
      chunks.push(current.trim());
    }

    return chunks.length > 0 ? chunks : [content];
  }

  // ── File I/O ───────────────────────────────────────────

  private writeEntry(id: string, content: string, meta: CaptureEntryMeta): void {
    const frontmatter = [
      "---",
      `id: ${id}`,
      `source: ${meta.source}`,
      `created: ${new Date(meta.created).toISOString()}`,
      meta.chunkParent ? `chunkParent: ${meta.chunkParent}` : null,
      "---",
    ].filter(Boolean).join("\n");

    fs.writeFileSync(path.join(ENTRIES_DIR, `${id}.md`), `${frontmatter}\n\n${content}`, "utf-8");
  }

  private loadIndex(): void {
    if (fs.existsSync(INDEX_FILE)) {
      try {
        this.index = JSON.parse(fs.readFileSync(INDEX_FILE, "utf-8"));
      } catch {
        this.index = [];
      }
    }
  }

  private persistIndex(): void {
    fs.writeFileSync(INDEX_FILE, JSON.stringify(this.index, null, 2), "utf-8");
  }

  // ── Embedding ──────────────────────────────────────────

  private async drainEmbedQueue(): Promise<void> {
    if (this.draining || !this.embedder?.isReady) return;
    this.draining = true;

    while (this.embedQueue.length > 0) {
      const meta = this.embedQueue.shift()!;
      try {
        const content = this.readContent(meta.id);
        if (!content) continue;

        const text = `${meta.source}: ${content}`;
        const vec = await this.embedder!.embed(text);
        const vecPath = path.join(ENTRIES_DIR, `${meta.id}.vec`);
        fs.writeFileSync(vecPath, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
      } catch {
        // Non-fatal — entry still searchable via keywords
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    this.draining = false;
  }

  // ── Search internals ───────────────────────────────────

  /** Reassemble all chunks sharing the same chunkParent, in order. */
  private reassemble(meta: CaptureEntryMeta): string {
    const parentId = meta.chunkParent;
    if (!parentId) return this.readContent(meta.id) || "";

    const siblings = this.index
      .filter((m) => m.chunkParent === parentId)
      .sort((a, b) => a.id.localeCompare(b.id));

    if (siblings.length <= 1) return this.readContent(meta.id) || "";

    return this.deoverlapChunks(siblings.map((s) => this.readContent(s.id) || ""));
  }

  private vectorSearch(
    queryVec: Float32Array,
    limit: number,
  ): Array<{ meta: CaptureEntryMeta; content: string; score: number }> {
    const scored: Array<{ meta: CaptureEntryMeta; content: string; score: number }> = [];
    const seen = new Set<string>();

    for (const meta of this.index) {
      const vecPath = path.join(ENTRIES_DIR, `${meta.id}.vec`);
      if (!fs.existsSync(vecPath)) continue;

      const parentKey = meta.chunkParent || meta.id;
      if (seen.has(parentKey)) continue;

      try {
        const buf = fs.readFileSync(vecPath);
        const vec = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
        const score = cosine(queryVec, vec);
        if (score < 0.25) continue;

        seen.add(parentKey);
        const content = this.reassemble(meta);
        scored.push({ meta, content, score });
      } catch {
        continue;
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  private keywordSearch(
    query: string,
    limit: number,
  ): Array<{ meta: CaptureEntryMeta; content: string; score: number }> {
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    if (terms.length === 0) {
      return [...this.index]
        .sort((a, b) => b.created - a.created)
        .slice(0, limit)
        .map((meta) => ({ meta, content: this.reassemble(meta), score: 1 }));
    }

    const scored: Array<{ meta: CaptureEntryMeta; content: string; score: number }> = [];
    const seen = new Set<string>();

    for (const meta of this.index) {
      const parentKey = meta.chunkParent || meta.id;
      if (seen.has(parentKey)) continue;

      const content = this.readContent(meta.id) || "";
      const text = `${meta.source} ${content}`.toLowerCase();
      let hits = 0;
      for (const term of terms) {
        if (text.includes(term)) hits++;
      }
      if (hits === 0) continue;

      seen.add(parentKey);
      const fullContent = this.reassemble(meta);
      const ageHours = (Date.now() - meta.created) / 3_600_000;
      const recency = Math.max(0, 1 - ageHours / 720);
      scored.push({ meta, content: fullContent, score: hits / terms.length + recency * 0.3 });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }
}

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}
