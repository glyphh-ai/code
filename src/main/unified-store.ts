/**
 * UnifiedStore — persistent, searchable store for all agent interactions.
 *
 * One index to search regardless of source: .sup captures, MCP tool results,
 * council exchanges, chat history.
 *
 * Storage: flat files + vector sidecars (same pattern as note-store.ts / memory-store.ts).
 *   ~/yo/store/
 *     index.json              — Array of entry metadata (no content bodies)
 *     entries/
 *       <id>.md               — Full content with YAML frontmatter
 *       <id>.vec              — Binary Float32Array, 384-dim embedding
 */

import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import type { Embedder } from "./embedder";

const STORE_DIR = path.join(os.homedir(), "yo", "store");
const INDEX_FILE = path.join(STORE_DIR, "index.json");
const ENTRIES_DIR = path.join(STORE_DIR, "entries");
const EMBED_DIM = 384;
const CHUNK_TARGET = 1200;
const CHUNK_OVERLAP = 200;
const CHUNK_THRESHOLD = 1500;

export type EntryType = "capture" | "mcp" | "council" | "chat";

export interface StoreEntryMeta {
  id: string;
  type: EntryType;
  source: string;            // app ID, tool name, council participants, chat ID
  created: number;
  /** For chunks: ID of the parent entry that was split */
  chunkParent?: string;
  /** Extra metadata depending on type */
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  appId?: string;
}

export interface IngestOptions {
  type: EntryType;
  source: string;
  content: string;
  appId?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
}

export class UnifiedStore {
  private index: StoreEntryMeta[] = [];
  private embedder: Embedder | null = null;
  private embedQueue: StoreEntryMeta[] = [];
  private draining = false;

  constructor() {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.mkdirSync(ENTRIES_DIR, { recursive: true });
    this.loadIndex();
  }

  setEmbedder(embedder: Embedder): void {
    this.embedder = embedder;
    // Drain any queued embeddings now that embedder is available
    if (this.embedQueue.length > 0) this.drainEmbedQueue();
  }

  // ── Ingest ─────────────────────────────────────────────

  /** Ingest content into the store. Writes file immediately, queues embedding async. */
  async ingest(opts: IngestOptions): Promise<string> {
    const { type, source, content, appId, toolName, toolArgs } = opts;

    // Chunk if content exceeds threshold
    if (content.length > CHUNK_THRESHOLD) {
      const chunks = this.chunkContent(content);
      const parentId = crypto.randomBytes(6).toString("hex");

      for (let i = 0; i < chunks.length; i++) {
        const chunkId = `${parentId}-${i}`;
        const meta: StoreEntryMeta = {
          id: chunkId,
          type,
          source,
          created: Date.now(),
          chunkParent: parentId,
          appId,
          toolName,
          toolArgs,
        };
        this.writeEntry(chunkId, chunks[i], meta);
        this.index.push(meta);
        this.embedQueue.push(meta);
      }

      this.persistIndex();
      this.drainEmbedQueue();
      return parentId;
    }

    // Single entry (no chunking needed)
    const id = crypto.randomBytes(6).toString("hex");
    const meta: StoreEntryMeta = {
      id,
      type,
      source,
      created: Date.now(),
      appId,
      toolName,
      toolArgs,
    };
    this.writeEntry(id, content, meta);
    this.index.push(meta);
    this.persistIndex();

    this.embedQueue.push(meta);
    this.drainEmbedQueue();

    return id;
  }

  // ── Search ─────────────────────────────────────────────

  /** Semantic search across all stored interactions. */
  async search(query: string, type?: EntryType, limit = 10): Promise<Array<{ meta: StoreEntryMeta; content: string; score: number }>> {
    const candidates = type ? this.index.filter((e) => e.type === type) : this.index;
    if (candidates.length === 0) return [];

    // Vector search
    if (this.embedder?.isReady) {
      try {
        const queryVec = await this.embedder.embed(query);
        return this.vectorSearch(candidates, queryVec, limit);
      } catch {
        // Fall through to keyword
      }
    }

    return this.keywordSearch(candidates, query, limit);
  }

  /** Get recent entries by type. */
  recent(type?: EntryType, limit = 10): Array<{ meta: StoreEntryMeta; content: string }> {
    const candidates = type ? this.index.filter((e) => e.type === type) : this.index;
    const sorted = [...candidates].sort((a, b) => b.created - a.created).slice(0, limit);
    return sorted.map((meta) => ({
      meta,
      content: this.readContent(meta.id) || "",
    }));
  }

  /** Read full content by entry ID. */
  readContent(id: string): string | null {
    const filepath = path.join(ENTRIES_DIR, `${id}.md`);
    if (!fs.existsSync(filepath)) return null;
    try {
      const raw = fs.readFileSync(filepath, "utf-8");
      // Strip frontmatter
      const match = raw.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
      return match ? match[1].trim() : raw;
    } catch {
      return null;
    }
  }

  /** Total entry count. */
  get count(): number { return this.index.length; }

  // ── Chunking ───────────────────────────────────────────

  private chunkContent(content: string): string[] {
    const chunks: string[] = [];
    const paragraphs = content.split(/\n\n+/);
    let current = "";

    for (const para of paragraphs) {
      if (current.length + para.length > CHUNK_TARGET && current.length > 0) {
        chunks.push(current.trim());
        // Overlap: keep tail of current chunk
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

  private writeEntry(id: string, content: string, meta: StoreEntryMeta): void {
    const frontmatter = [
      "---",
      `id: ${id}`,
      `type: ${meta.type}`,
      `source: ${meta.source}`,
      `created: ${new Date(meta.created).toISOString()}`,
      meta.chunkParent ? `chunkParent: ${meta.chunkParent}` : null,
      meta.toolName ? `toolName: ${meta.toolName}` : null,
      meta.appId ? `appId: ${meta.appId}` : null,
      "---",
    ].filter(Boolean).join("\n");

    const filepath = path.join(ENTRIES_DIR, `${id}.md`);
    fs.writeFileSync(filepath, `${frontmatter}\n\n${content}`, "utf-8");
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

        const text = meta.toolName
          ? `${meta.toolName}: ${content}`
          : `${meta.source}: ${content}`;

        const vec = await this.embedder!.embed(text);
        const vecPath = path.join(ENTRIES_DIR, `${meta.id}.vec`);
        fs.writeFileSync(vecPath, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
      } catch {
        // Non-fatal — entry still searchable via keywords
      }
    }

    this.draining = false;
  }

  // ── Search internals ───────────────────────────────────

  private vectorSearch(
    candidates: StoreEntryMeta[],
    queryVec: Float32Array,
    limit: number,
  ): Array<{ meta: StoreEntryMeta; content: string; score: number }> {
    const scored: Array<{ meta: StoreEntryMeta; content: string; score: number }> = [];

    for (const meta of candidates) {
      const vecPath = path.join(ENTRIES_DIR, `${meta.id}.vec`);
      if (!fs.existsSync(vecPath)) continue;

      try {
        const buf = fs.readFileSync(vecPath);
        const vec = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
        const score = cosine(queryVec, vec);
        if (score < 0.25) continue;

        const content = this.readContent(meta.id) || "";
        scored.push({ meta, content, score });
      } catch {
        continue;
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  private keywordSearch(
    candidates: StoreEntryMeta[],
    query: string,
    limit: number,
  ): Array<{ meta: StoreEntryMeta; content: string; score: number }> {
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    if (terms.length === 0) {
      // No search terms — return most recent
      return [...candidates]
        .sort((a, b) => b.created - a.created)
        .slice(0, limit)
        .map((meta) => ({ meta, content: this.readContent(meta.id) || "", score: 1 }));
    }

    const scored: Array<{ meta: StoreEntryMeta; content: string; score: number }> = [];

    for (const meta of candidates) {
      const content = this.readContent(meta.id) || "";
      const text = `${meta.source} ${meta.toolName || ""} ${content}`.toLowerCase();
      let hits = 0;
      for (const term of terms) {
        if (text.includes(term)) hits++;
      }
      if (hits === 0) continue;

      // Recency boost
      const ageHours = (Date.now() - meta.created) / 3_600_000;
      const recency = Math.max(0, 1 - ageHours / 720);
      scored.push({ meta, content, score: hits / terms.length + recency * 0.3 });
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
