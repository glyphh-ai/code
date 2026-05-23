/**
 * Council store — saved council templates + run history.
 *
 *   ~/yo/councils/<id>.json            — a reusable council template
 *   ~/yo/councils/.runs/<id>/<ts>.json — one saved run (transcript + summary)
 *
 * Mirrors agent-store.ts. Templates hold the council config (prompt, members,
 * style, rounds) plus an optional cron `schedule`. Runs capture each execution.
 */

import fs from "fs";
import path from "path";
import os from "os";

const COUNCILS_DIR = path.join(os.homedir(), "yo", "councils");
const RUNS_DIR = path.join(COUNCILS_DIR, ".runs");

export interface CouncilTemplateMember {
  provider: string;
  model: string;
  startup_prompt: string;
}

export interface CouncilTemplate {
  id: string;
  name: string;
  council_prompt: string;
  style: "chained" | "free_for_all" | "debate";
  round_cap: number;
  members: CouncilTemplateMember[];
  /** Optional cron expression — when set, the scheduler auto-runs this council. */
  schedule?: string;
  paused?: boolean;
  meta?: { createdAt: string; updatedAt: string };
}

export interface CouncilRun {
  runId: string;
  councilId: string;
  name: string;
  startedAt: string;
  trigger: "manual" | "schedule" | "agent";
  status: "ok" | "error" | "running";
  rounds: number;
  transcript: Array<{ round: number; member_id: string; text: string }>;
  summary?: string;
  summaryPath?: string;
  error?: string;
}

// ── Filesystem helpers ──────────────────────────────────────

function ensureDir(): void {
  fs.mkdirSync(COUNCILS_DIR, { recursive: true });
}

function pathFor(id: string): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) {
    throw new Error("Invalid council id (letters, digits, _ or -; must start with a letter or digit)");
  }
  return path.join(COUNCILS_DIR, `${id}.json`);
}

function safeRead<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

export function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return base || `council-${Date.now()}`;
}

// ── Template CRUD ───────────────────────────────────────────

export function listCouncils(): CouncilTemplate[] {
  ensureDir();
  const out: CouncilTemplate[] = [];
  for (const f of fs.readdirSync(COUNCILS_DIR).filter((f) => f.endsWith(".json"))) {
    const cfg = safeRead<CouncilTemplate>(path.join(COUNCILS_DIR, f));
    if (cfg) out.push(cfg);
  }
  out.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  return out;
}

export function getCouncilTemplate(id: string): CouncilTemplate | null {
  ensureDir();
  return safeRead<CouncilTemplate>(pathFor(id));
}

export function saveCouncil(cfg: CouncilTemplate): CouncilTemplate {
  ensureDir();
  const now = new Date().toISOString();
  const existing = safeRead<CouncilTemplate>(pathFor(cfg.id));
  const merged: CouncilTemplate = {
    ...cfg,
    meta: { createdAt: existing?.meta?.createdAt || now, updatedAt: now },
  };
  fs.writeFileSync(pathFor(cfg.id), JSON.stringify(merged, null, 2), { mode: 0o600 });
  return merged;
}

export function removeCouncil(id: string): boolean {
  ensureDir();
  try {
    fs.unlinkSync(pathFor(id));
    return true;
  } catch {
    return false;
  }
}

export function idAvailable(id: string): boolean {
  ensureDir();
  try { return !fs.existsSync(pathFor(id)); } catch { return false; }
}

// ── Run history ─────────────────────────────────────────────

function runsDirFor(councilId: string): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(councilId)) throw new Error("Invalid council id");
  return path.join(RUNS_DIR, councilId);
}

export function saveRun(run: CouncilRun): void {
  const dir = runsDirFor(run.councilId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${run.runId}.json`), JSON.stringify(run, null, 2), { mode: 0o600 });
}

export function listRuns(councilId: string): CouncilRun[] {
  let dir: string;
  try { dir = runsDirFor(councilId); } catch { return []; }
  if (!fs.existsSync(dir)) return [];
  const out: CouncilRun[] = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const r = safeRead<CouncilRun>(path.join(dir, f));
    if (r) out.push(r);
  }
  out.sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
  return out;
}

export function getRun(councilId: string, runId: string): CouncilRun | null {
  let dir: string;
  try { dir = runsDirFor(councilId); } catch { return null; }
  return safeRead<CouncilRun>(path.join(dir, `${runId}.json`));
}
