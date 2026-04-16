/**
 * ContextStore — SQLite + vector embeddings for ambient context.
 *
 * Stores chunked content captured from panels with vector embeddings
 * for semantic search. Append strategy — historical context is preserved.
 * Used by .yo <query> to find relevant context across all panels.
 */

import Database from "better-sqlite3";
import crypto from "crypto";
import path from "path";
import os from "os";
import fs from "fs";
import type { Embedder } from "./embedder";

const DB_PATH = path.join(os.homedir(), "yo", "context.db");
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CHUNK_SIZE = 1500;
const CHUNK_OVERLAP = 200;

export interface ChunkResult {
  id: number;
  panel_id: string;
  url: string;
  title: string;
  content: string;
  timestamp: number;
  rank: number;
}

export class ContextStore {
  private db: Database.Database;
  private insertStmt: Database.Statement;
  private pruneStmt: Database.Statement;
  private lastHashStmt: Database.Statement;
  private embedder: Embedder | null = null;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath || DB_PATH;
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");

    this.createSchema();

    this.insertStmt = this.db.prepare(`
      INSERT INTO chunks (panel_id, url, title, content, content_hash, timestamp, chunk_index, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.pruneStmt = this.db.prepare(`DELETE FROM chunks WHERE timestamp < ?`);

    this.lastHashStmt = this.db.prepare(`
      SELECT content_hash FROM chunks WHERE panel_id = ? ORDER BY timestamp DESC LIMIT 1
    `);
  }

  setEmbedder(embedder: Embedder): void {
    this.embedder = embedder;
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        panel_id TEXT NOT NULL,
        url TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL DEFAULT 0,
        embedding BLOB
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_panel_ts ON chunks(panel_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_chunks_ts ON chunks(timestamp);
    `);

    // Migrate: add embedding column if missing (existing databases)
    const cols = this.db.pragma("table_info(chunks)") as { name: string }[];
    if (!cols.some((c) => c.name === "embedding")) {
      this.db.exec("ALTER TABLE chunks ADD COLUMN embedding BLOB");
    }

    // Drop FTS5 artifacts from previous version
    this.db.exec(`
      DROP TRIGGER IF EXISTS chunks_ai;
      DROP TRIGGER IF EXISTS chunks_ad;
    `);
    try {
      this.db.exec("DROP TABLE IF EXISTS chunks_fts");
    } catch { /* FTS5 table may not exist */ }
  }

  /**
   * Append chunks for a panel capture (preserves history).
   * Returns false if content hash matches last capture (no change).
   * Embeds chunks if embedder is available.
   */
  async insertCapture(panelId: string, url: string, title: string, fullText: string): Promise<boolean> {
    const hash = crypto.createHash("md5").update(fullText).digest("hex");

    // Check if content changed since last capture for this panel
    const last = this.lastHashStmt.get(panelId) as { content_hash: string } | undefined;
    if (last && last.content_hash === hash) return false;

    const chunks = chunkText(fullText, CHUNK_SIZE, CHUNK_OVERLAP);
    const now = Date.now();

    // Embed chunks if embedder is ready
    let embeddings: Float32Array[] | null = null;
    if (this.embedder?.isReady) {
      try {
        embeddings = await this.embedder.embedBatch(chunks);
      } catch (err) {
        console.error("[context] embedding failed, storing without vectors:", err);
      }
    }

    // Append strategy: insert new chunks, keep old ones
    const insertAll = this.db.transaction(() => {
      for (let i = 0; i < chunks.length; i++) {
        const embBuf = embeddings?.[i]
          ? Buffer.from(embeddings[i].buffer, embeddings[i].byteOffset, embeddings[i].byteLength)
          : null;
        this.insertStmt.run(panelId, url, title, chunks[i], hash, now, i, embBuf);
      }
    });
    insertAll();
    return true;
  }

  /**
   * Semantic vector search via cosine similarity.
   * Embeds the query, compares against all stored embeddings.
   * Returns top-k chunks ranked by similarity.
   */
  async search(query: string, limit = 10): Promise<ChunkResult[]> {
    if (!this.embedder?.isReady) return [];

    const queryVec = await this.embedder.embed(query);
    return this.vectorSearch(queryVec, limit);
  }

  private vectorSearch(queryVec: Float32Array, limit: number): ChunkResult[] {
    const cutoff = Date.now() - DEFAULT_RETENTION_MS;
    const rows = this.db.prepare(`
      SELECT id, panel_id, url, title, content, timestamp, chunk_index, embedding
      FROM chunks
      WHERE embedding IS NOT NULL AND timestamp > ?
    `).all(cutoff) as any[];

    const scored: ChunkResult[] = [];
    for (const row of rows) {
      if (!row.embedding) continue;
      const emb = new Float32Array(
        row.embedding.buffer.slice(row.embedding.byteOffset, row.embedding.byteOffset + row.embedding.byteLength),
      );
      // Dot product of normalized vectors = cosine similarity
      let dot = 0;
      for (let i = 0; i < queryVec.length; i++) dot += queryVec[i] * emb[i];
      scored.push({
        id: row.id,
        panel_id: row.panel_id,
        url: row.url,
        title: row.title,
        content: row.content,
        timestamp: row.timestamp,
        rank: dot,
      });
    }

    scored.sort((a, b) => b.rank - a.rank);
    return scored.slice(0, limit);
  }

  /**
   * Remove chunks older than retention period.
   */
  prune(retentionMs = DEFAULT_RETENTION_MS): number {
    const cutoff = Date.now() - retentionMs;
    const result = this.pruneStmt.run(cutoff);
    return result.changes;
  }

  /**
   * Get the content hash of the most recent capture for a panel.
   */
  getLastHash(panelId: string): string | null {
    const row = this.lastHashStmt.get(panelId) as { content_hash: string } | undefined;
    return row?.content_hash ?? null;
  }

  /**
   * Get ALL chunks for a panel's most recent capture, ordered by chunk_index.
   */
  getPanelContent(panelId: string): ChunkResult[] {
    // Get the timestamp of the most recent capture for this panel
    const latest = this.db.prepare(`
      SELECT timestamp FROM chunks WHERE panel_id = ? ORDER BY timestamp DESC LIMIT 1
    `).get(panelId) as { timestamp: number } | undefined;
    if (!latest) return [];

    return this.db.prepare(`
      SELECT id, panel_id, url, title, content, timestamp, 0 AS rank
      FROM chunks WHERE panel_id = ? AND timestamp = ? ORDER BY chunk_index ASC
    `).all(panelId, latest.timestamp) as ChunkResult[];
  }

  /**
   * Backfill embeddings for any chunks stored before the embedder was ready.
   * Called once after the embedder finishes loading.
   */
  async backfillEmbeddings(): Promise<void> {
    if (!this.embedder?.isReady) return;
    const missing = this.db.prepare(
      "SELECT id, content FROM chunks WHERE embedding IS NULL",
    ).all() as { id: number; content: string }[];

    if (missing.length === 0) return;
    console.log(`[context] backfilling ${missing.length} chunk embeddings…`);

    const updateStmt = this.db.prepare("UPDATE chunks SET embedding = ? WHERE id = ?");
    let count = 0;
    for (const row of missing) {
      try {
        const emb = await this.embedder.embed(row.content);
        const buf = Buffer.from(emb.buffer, emb.byteOffset, emb.byteLength);
        updateStmt.run(buf, row.id);
        count++;
      } catch (err) {
        console.error("[context] backfill failed at chunk", row.id, err);
        break;
      }
    }
    console.log(`[context] backfilled ${count} embeddings`);
  }

  /** Close the database. */
  close(): void {
    try {
      this.db.close();
    } catch {}
  }
}

// ── Text chunking (exported for use by ambient-capture) ────────

export function chunkText(text: string, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  const cleaned = text.replace(/\n{3,}/g, "\n\n").trim();
  if (!cleaned || cleaned.length <= chunkSize) return cleaned ? [cleaned] : [];

  const chunks: string[] = [];
  let offset = 0;
  const maxChunks = Math.ceil(cleaned.length / Math.max(chunkSize - overlap, 1)) + 10;

  while (offset < cleaned.length && chunks.length < maxChunks) {
    let end = Math.min(offset + chunkSize, cleaned.length);

    // Try to break at paragraph or sentence boundary
    if (end < cleaned.length) {
      const minEnd = offset + Math.floor(chunkSize * 0.5);
      const paragraphBreak = cleaned.lastIndexOf("\n\n", end);
      if (paragraphBreak > minEnd) {
        end = paragraphBreak;
      } else {
        const sentenceBreak = cleaned.lastIndexOf(". ", end);
        if (sentenceBreak > minEnd) {
          end = sentenceBreak + 1;
        }
      }
    }

    chunks.push(cleaned.slice(offset, end));
    const nextOffset = end - overlap;
    // Safety: always advance by at least 1 character
    offset = nextOffset > offset ? nextOffset : offset + chunkSize;
  }

  return chunks;
}
