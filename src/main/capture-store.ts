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

const STORE_DIR = path.join(os.homedir(), "yo", "store");
const INDEX_FILE = path.join(STORE_DIR, "index.json");
const ENTRIES_DIR = path.join(STORE_DIR, "entries");
const CHUNK_TARGET = 1200;
const CHUNK_OVERLAP = 200;
const CHUNK_THRESHOLD = 1500;

export interface CaptureEntryMeta {
  id: string;
  source: string;
  created: number;
  chunkParent?: string;
}

export class CaptureStore {
  private index: CaptureEntryMeta[] = [];
  private embedder: Embedder | null = null;
  private embedQueue: CaptureEntryMeta[] = [];
  private draining = false;

  constructor() {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.mkdirSync(ENTRIES_DIR, { recursive: true });
    this.loadIndex();
  }

  setEmbedder(embedder: Embedder): void {
    this.embedder = embedder;
    if (this.embedQueue.length > 0) this.drainEmbedQueue();
  }

  // ── Ingest ─────────────────────────────────────────────

  async ingest(appId: string, content: string): Promise<string> {
    if (content.length > CHUNK_THRESHOLD) {
      const chunks = this.chunkContent(content);
      const parentId = crypto.randomBytes(6).toString("hex");

      for (let i = 0; i < chunks.length; i++) {
        const chunkId = `${parentId}-${i}`;
        const meta: CaptureEntryMeta = {
          id: chunkId,
          source: appId,
          created: Date.now(),
          chunkParent: parentId,
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
      id,
      source: appId,
      created: Date.now(),
    };
    this.writeEntry(id, content, meta);
    this.index.push(meta);
    this.persistIndex();

    this.embedQueue.push(meta);
    this.drainEmbedQueue();

    return id;
  }

  // ── Search ─────────────────────────────────────────────

  async search(query: string, limit = 10): Promise<Array<{ meta: CaptureEntryMeta; content: string; score: number }>> {
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

  // ── Chunking ───────────────────────────────────────────

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

  private vectorSearch(
    queryVec: Float32Array,
    limit: number,
  ): Array<{ meta: CaptureEntryMeta; content: string; score: number }> {
    const scored: Array<{ meta: CaptureEntryMeta; content: string; score: number }> = [];

    for (const meta of this.index) {
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
    query: string,
    limit: number,
  ): Array<{ meta: CaptureEntryMeta; content: string; score: number }> {
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    if (terms.length === 0) {
      return [...this.index]
        .sort((a, b) => b.created - a.created)
        .slice(0, limit)
        .map((meta) => ({ meta, content: this.readContent(meta.id) || "", score: 1 }));
    }

    const scored: Array<{ meta: CaptureEntryMeta; content: string; score: number }> = [];

    for (const meta of this.index) {
      const content = this.readContent(meta.id) || "";
      const text = `${meta.source} ${content}`.toLowerCase();
      let hits = 0;
      for (const term of terms) {
        if (text.includes(term)) hits++;
      }
      if (hits === 0) continue;

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
