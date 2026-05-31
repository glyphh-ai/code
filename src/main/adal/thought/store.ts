/**
 * adaL SQLite thought store — persists raw thought rows to ~/yo/substrate/adal.sqlite.
 *
 * Stores text + metadata only; vectors are re-derived by the deterministic
 * encoder on load (ThoughtGlyphSpace.hydrate). This keeps the DB encoder-version
 * agnostic — change the encoder, restart, and recall recomputes cleanly.
 */

import path from "path";
import os from "os";
import fs from "fs";
import Database from "better-sqlite3";
import type { ThoughtStore, ThoughtRow, Speaker } from "./space";

const SUBSTRATE_DIR = path.join(os.homedir(), "yo", "substrate");
const DB_PATH = path.join(SUBSTRATE_DIR, "adal.sqlite");

export class SqliteThoughtStore implements ThoughtStore {
  private db: Database.Database;

  constructor(dbPath: string = DB_PATH) {
    if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS thoughts (
        thought_id    TEXT PRIMARY KEY,
        content       TEXT NOT NULL,
        speaker       TEXT NOT NULL,
        strength      REAL NOT NULL,
        created_at    REAL NOT NULL,
        last_accessed REAL NOT NULL,
        access_count  INTEGER NOT NULL,
        key           TEXT,
        version       INTEGER,
        metadata_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_thoughts_key ON thoughts (key);
      CREATE INDEX IF NOT EXISTS idx_thoughts_created ON thoughts (created_at);
    `);
  }

  upsert(row: ThoughtRow): void {
    this.db
      .prepare(`
        INSERT INTO thoughts
          (thought_id, content, speaker, strength, created_at, last_accessed, access_count, key, version, metadata_json)
        VALUES (@thoughtId, @content, @speaker, @strength, @createdAt, @lastAccessed, @accessCount, @key, @version, @metadataJson)
        ON CONFLICT(thought_id) DO UPDATE SET
          content=excluded.content,
          speaker=excluded.speaker,
          strength=excluded.strength,
          last_accessed=excluded.last_accessed,
          access_count=excluded.access_count,
          metadata_json=excluded.metadata_json
      `)
      .run({
        thoughtId: row.thoughtId,
        content: row.content,
        speaker: row.speaker,
        strength: row.strength,
        createdAt: row.createdAt,
        lastAccessed: row.lastAccessed,
        accessCount: row.accessCount,
        key: row.key,
        version: row.version,
        metadataJson: JSON.stringify(row.metadata ?? {}),
      });
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM thoughts WHERE thought_id = ?`).run(id);
  }

  loadAll(): ThoughtRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM thoughts`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      thoughtId: r.thought_id as string,
      content: r.content as string,
      speaker: r.speaker as Speaker,
      strength: r.strength as number,
      createdAt: r.created_at as number,
      lastAccessed: r.last_accessed as number,
      accessCount: r.access_count as number,
      key: (r.key as string) ?? null,
      version: (r.version as number) ?? null,
      metadata: JSON.parse((r.metadata_json as string) || "{}"),
    }));
  }
}
