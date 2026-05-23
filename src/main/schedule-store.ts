/**
 * schedule-store — standalone scheduled tasks, decoupled from skills.
 *
 * A schedule is just "run this prompt on this cadence" — it does NOT have to be
 * a skill. Stored as ~/yo/schedules/<id>.json. Skills remain separately
 * schedulable (skill `schedule:` frontmatter via SkillScheduler); this store is
 * for plain-prompt schedules so creating one no longer pollutes the skills dir.
 */

import fs from "fs";
import path from "path";
import os from "os";

const DIR = path.join(os.homedir(), "yo", "schedules");

export interface Schedule {
  id: string;
  name: string;
  description?: string;
  prompt: string;
  /** cron expression, or "" for manual-only. */
  cron: string;
  model?: string;
  /** "auto" run automatically, or "ask" before running. */
  ask?: string;
  paused?: boolean;
  meta?: { createdAt: string; updatedAt: string };
}

function ensureDir(): void { fs.mkdirSync(DIR, { recursive: true }); }

function pathFor(id: string): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) throw new Error("invalid schedule id");
  return path.join(DIR, `${id}.json`);
}

function safeRead(file: string): Schedule | null {
  try { return JSON.parse(fs.readFileSync(file, "utf-8")) as Schedule; } catch { return null; }
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || `schedule-${Date.now()}`;
}

export function listSchedules(): Schedule[] {
  ensureDir();
  const out: Schedule[] = [];
  for (const f of fs.readdirSync(DIR).filter((f) => f.endsWith(".json"))) {
    const s = safeRead(path.join(DIR, f));
    if (s) out.push(s);
  }
  out.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  return out;
}

export function getSchedule(id: string): Schedule | null {
  ensureDir();
  try { return safeRead(pathFor(id)); } catch { return null; }
}

export function saveSchedule(cfg: Schedule): Schedule {
  ensureDir();
  const now = new Date().toISOString();
  const id = cfg.id && /^[a-z0-9][a-z0-9_-]*$/i.test(cfg.id) ? cfg.id : slugify(cfg.name || "");
  const existing = safeRead(pathFor(id));
  const merged: Schedule = { ...cfg, id, meta: { createdAt: existing?.meta?.createdAt || now, updatedAt: now } };
  fs.writeFileSync(pathFor(id), JSON.stringify(merged, null, 2), { mode: 0o600 });
  return merged;
}

export function removeSchedule(id: string): boolean {
  ensureDir();
  try { fs.unlinkSync(pathFor(id)); return true; } catch { return false; }
}
