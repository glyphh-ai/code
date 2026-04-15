/**
 * ContextStore — SQLite + FTS5 full-text search for ambient context.
 *
 * Stores chunked content captured from panels, indexed for fast retrieval.
 * Used by .yo <query> to find relevant context across all panels.
 */

import Database from "better-sqlite3";
import crypto from "crypto";
import path from "path";
import os from "os";
import fs from "fs";

const DB_PATH = path.join(os.homedir(), "yo", "context.db");
const DEFAULT_RETENTION_MS = 48 * 60 * 60 * 1000; // 48 hours
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
  private searchStmt: Database.Statement;
  private pruneStmt: Database.Statement;
  private deleteByPanelStmt: Database.Statement;
  private lastHashStmt: Database.Statement;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath || DB_PATH;
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");

    this.createSchema();

    this.insertStmt = this.db.prepare(`
      INSERT INTO chunks (panel_id, url, title, content, content_hash, timestamp, chunk_index)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.searchStmt = this.db.prepare(`
      SELECT c.id, c.panel_id, c.url, c.title, c.content, c.timestamp,
             (-bm25(chunks_fts, 1.0, 0.5, 0.3) * (1.0 / (1.0 + CAST((:now - c.timestamp) AS REAL) / 3600000.0 / 24.0))) AS rank
      FROM chunks_fts f
      JOIN chunks c ON c.id = f.rowid
      WHERE chunks_fts MATCH :query
      ORDER BY rank DESC
      LIMIT :limit
    `);

    this.pruneStmt = this.db.prepare(`DELETE FROM chunks WHERE timestamp < ?`);

    this.deleteByPanelStmt = this.db.prepare(`DELETE FROM chunks WHERE panel_id = ?`);

    this.lastHashStmt = this.db.prepare(`
      SELECT content_hash FROM chunks WHERE panel_id = ? ORDER BY timestamp DESC LIMIT 1
    `);
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
        chunk_index INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_panel_ts ON chunks(panel_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_chunks_ts ON chunks(timestamp);
    `);

    // FTS5 virtual table — check if it exists first
    const ftsExists = this.db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='chunks_fts'`
    ).get();

    if (!ftsExists) {
      this.db.exec(`
        CREATE VIRTUAL TABLE chunks_fts USING fts5(
          content, title, panel_id,
          content='chunks', content_rowid='id',
          tokenize='porter unicode61'
        );

        CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
          INSERT INTO chunks_fts(rowid, content, title, panel_id)
          VALUES (new.id, new.content, new.title, new.panel_id);
        END;

        CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
          INSERT INTO chunks_fts(chunks_fts, rowid, content, title, panel_id)
          VALUES ('delete', old.id, old.content, old.title, old.panel_id);
        END;
      `);
    }
  }

  /**
   * Replace chunks for a panel capture (delete old, insert new).
   * Returns false if content hash matches last capture (no change).
   */
  insertCapture(panelId: string, url: string, title: string, fullText: string): boolean {
    const hash = crypto.createHash("md5").update(fullText).digest("hex");

    // Check if content changed since last capture for this panel
    const last = this.lastHashStmt.get(panelId) as { content_hash: string } | undefined;
    if (last && last.content_hash === hash) return false;

    const chunks = chunkText(fullText, CHUNK_SIZE, CHUNK_OVERLAP);
    const now = Date.now();

    // Replace strategy: delete old chunks for this panel, insert fresh set
    const replaceAll = this.db.transaction(() => {
      this.deleteByPanelStmt.run(panelId);
      for (let i = 0; i < chunks.length; i++) {
        this.insertStmt.run(panelId, url, title, chunks[i], hash, now, i);
      }
    });
    replaceAll();
    return true;
  }

  /**
   * FTS5 search with BM25 relevance × recency weighting.
   * Returns top-k chunks ranked by combined score.
   */
  search(query: string, limit = 10): ChunkResult[] {
    // Sanitize query for FTS5 — wrap each word in quotes to avoid syntax errors
    const sanitized = query
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .map((w) => `"${w}"`)
      .join(" OR ");

    if (!sanitized) return [];

    try {
      return this.searchStmt.all({ query: sanitized, limit, now: Date.now() }) as ChunkResult[];
    } catch {
      return [];
    }
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

  /** Close the database. */
  close(): void {
    try {
      this.db.close();
    } catch {}
  }
}

// ── Text chunking ───────────────────────────────────────────

function chunkText(text: string, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  const cleaned = text.replace(/\n{3,}/g, "\n\n").trim();
  if (cleaned.length <= chunkSize) return [cleaned];

  const chunks: string[] = [];
  let offset = 0;

  while (offset < cleaned.length) {
    let end = offset + chunkSize;

    // Try to break at paragraph or sentence boundary
    if (end < cleaned.length) {
      const paragraphBreak = cleaned.lastIndexOf("\n\n", end);
      if (paragraphBreak > offset + chunkSize * 0.5) {
        end = paragraphBreak;
      } else {
        const sentenceBreak = cleaned.lastIndexOf(". ", end);
        if (sentenceBreak > offset + chunkSize * 0.5) {
          end = sentenceBreak + 1;
        }
      }
    } else {
      end = cleaned.length;
    }

    chunks.push(cleaned.slice(offset, end));
    offset = end - overlap;
    if (offset >= cleaned.length) break;
  }

  return chunks;
}
