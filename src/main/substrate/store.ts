/**
 * Substrate store — SQLite-backed memory for `reflex.remember` and `sense.recall`.
 *
 * Schema:
 *   runs(id, intent, skill, chain_json, outcome, duration_ms, at, input_digest, output_digest)
 *
 * Indexed by (intent, skill) for fast pattern lookup.
 */

import path from "path";
import os from "os";
import fs from "fs";
import Database from "better-sqlite3";
import { Intent, RememberedRun } from "./types";

const SUBSTRATE_DIR = path.join(os.homedir(), "yo", "substrate");
const DB_PATH = path.join(SUBSTRATE_DIR, "memory.sqlite");

let db: Database.Database | null = null;

function ensureDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(SUBSTRATE_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      intent TEXT NOT NULL,
      skill TEXT NOT NULL,
      chain_json TEXT NOT NULL,
      outcome TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      at INTEGER NOT NULL,
      input_digest TEXT,
      output_digest TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runs_intent_skill ON runs (intent, skill);
    CREATE INDEX IF NOT EXISTS idx_runs_at ON runs (at DESC);
  `);
  return db;
}

export function closeSubstrateDb(): void {
  if (db) { try { db.close(); } catch {} db = null; }
}

export function recordRun(run: RememberedRun): void {
  const d = ensureDb();
  d.prepare(`
    INSERT OR REPLACE INTO runs
      (id, intent, skill, chain_json, outcome, duration_ms, at, input_digest, output_digest)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    run.id,
    run.intent,
    run.skill,
    JSON.stringify(run.chain),
    run.outcome,
    run.durationMs,
    run.at,
    run.inputDigest ?? null,
    run.outputDigest ?? null,
  );
}

export function findSimilarRuns(intent: Intent, skill: string, limit = 5): RememberedRun[] {
  const d = ensureDb();
  const rows = d.prepare(`
    SELECT id, intent, skill, chain_json AS chainJson, outcome, duration_ms AS durationMs, at,
           input_digest AS inputDigest, output_digest AS outputDigest
    FROM runs WHERE intent = ? AND skill = ?
    ORDER BY at DESC LIMIT ?
  `).all(intent, skill, limit) as Array<RememberedRun & { chainJson: string }>;
  return rows.map((r) => ({ ...r, chain: JSON.parse(r.chainJson) }));
}

export function countMatchingRuns(intent: Intent, skill: string, outcome: "success" | "error"): number {
  const d = ensureDb();
  const row = d.prepare(`
    SELECT COUNT(*) AS n FROM runs WHERE intent = ? AND skill = ? AND outcome = ?
  `).get(intent, skill, outcome) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function recentRuns(limit = 50): RememberedRun[] {
  const d = ensureDb();
  const rows = d.prepare(`
    SELECT id, intent, skill, chain_json AS chainJson, outcome, duration_ms AS durationMs, at,
           input_digest AS inputDigest, output_digest AS outputDigest
    FROM runs ORDER BY at DESC LIMIT ?
  `).all(limit) as Array<RememberedRun & { chainJson: string }>;
  return rows.map((r) => ({ ...r, chain: JSON.parse(r.chainJson) }));
}

export function clearMemory(): void {
  if (!db) return;
  db.exec("DELETE FROM runs");
}
