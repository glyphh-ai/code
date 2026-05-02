/**
 * PreferencesDb — SQLite-backed key-value store for user preferences.
 *
 * Drop-in replacement for the file-based preferences.ts.
 * Same public API shape, backed by the local-db singleton.
 */

import { getLocalDb } from "../local-db";

// ── Public API ─────────────────────────────────────────────

/**
 * Get a preference value by key. Returns `defaultValue` if not found.
 */
export function getPreference<T = unknown>(key: string, defaultValue?: T): T {
  const db = getLocalDb();
  const row = db.prepare(
    "SELECT value FROM preferences WHERE key = ?"
  ).get(key) as { value: string } | undefined;
  if (!row) return defaultValue as T;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return row.value as unknown as T;
  }
}

/**
 * Set a preference value. Serializes to JSON.
 */
export function setPreference(key: string, value: unknown): void {
  const db = getLocalDb();
  db.prepare(
    "INSERT OR REPLACE INTO preferences (key, value) VALUES (?, ?)"
  ).run(key, JSON.stringify(value));
}
