/**
 * Preferences — simple JSON key-value store at ~/yo/.preferences
 */

import fs from "fs";
import path from "path";
import os from "os";

const PREFS_FILE = path.join(os.homedir(), "yo", ".preferences");

let cache: Record<string, unknown> | null = null;

function load(): Record<string, unknown> {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(PREFS_FILE, "utf-8"));
  } catch {
    cache = {};
  }
  return cache!;
}

function save() {
  fs.mkdirSync(path.dirname(PREFS_FILE), { recursive: true });
  fs.writeFileSync(PREFS_FILE, JSON.stringify(cache, null, 2), "utf-8");
}

export function getPreference<T = unknown>(key: string, fallback?: T): T {
  const prefs = load();
  return (prefs[key] as T) ?? fallback!;
}

export function setPreference(key: string, value: unknown): void {
  load();
  cache![key] = value;
  save();
}
