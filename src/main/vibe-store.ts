/**
 * VibeStore — file-based registry for the user's Vibe projects.
 *
 * Each vibe is a persisted project under ~/yo/vibes/<id>/:
 *   meta.json   # VibeMeta (below)
 *   plan.md     # the living task list (region 2 of the vibe workspace)
 *   CLAUDE.md   # the methodology fed to the coding agent (editable per project)
 *   code/       # the project being built (the agent cwd)
 *
 * Mirrors agent-store's per-item-on-disk fs/json style (mode 0o600 on writes,
 * mkdirSync recursive). A vibe id is a slug derived from the name (deduped).
 */

import fs from "fs";
import path from "path";
import os from "os";

const VIBES_DIR = path.join(os.homedir(), "yo", "vibes");

// ── Types ───────────────────────────────────────────────────

export type VibeStatus = "active" | "paused" | "completed";

export interface VibeMeta {
  id: string;
  name: string;
  description?: string;
  status: VibeStatus;
  createdAt: string;
  updatedAt: string;
  council_id?: string;
  devServerUrl?: string;
  outputAppId?: string;
}

// ── Seed content ────────────────────────────────────────────

const STARTER_PLAN = `# Plan

- [ ] Describe what you're building
`;

const STARTER_CLAUDE = `# Methodology

This is the coding methodology for this vibe. Edit it to steer how the agent
works on this project.

- Read \`plan.md\` first; keep it checked off as you go.
- Build in \`code/\` (your working directory).
- Prefer small, verifiable steps; keep a running dev server when possible.
`;

// ── Filesystem helpers ──────────────────────────────────────

function ensureRoot(): void {
  fs.mkdirSync(VIBES_DIR, { recursive: true });
}

function assertId(id: string): void {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) {
    throw new Error("Invalid vibe id (use letters, digits, _ or -; must start with a letter or digit)");
  }
}

function vibeDir(id: string): string {
  assertId(id);
  return path.join(VIBES_DIR, id);
}

function metaPath(id: string): string {
  return path.join(vibeDir(id), "meta.json");
}

function safeReadMeta(id: string): VibeMeta | null {
  try {
    const raw = fs.readFileSync(metaPath(id), "utf-8");
    return JSON.parse(raw) as VibeMeta;
  } catch {
    return null;
  }
}

function slugify(name: string): string {
  return (
    name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "vibe"
  );
}

/** Derive a unique slug from a name; dedupe with a numeric suffix. */
function uniqueId(name: string): string {
  ensureRoot();
  const base = slugify(name);
  if (!fs.existsSync(vibeDir(base))) return base;
  for (let n = 2; n < 1000; n++) {
    const cand = `${base}-${n}`;
    if (!fs.existsSync(vibeDir(cand))) return cand;
  }
  return `${base}-${Date.now()}`;
}

// ── Path accessors ──────────────────────────────────────────

export function vibeCodeDir(id: string): string {
  return path.join(vibeDir(id), "code");
}

export function vibePlanPath(id: string): string {
  return path.join(vibeDir(id), "plan.md");
}

export function vibeClaudePath(id: string): string {
  return path.join(vibeDir(id), "CLAUDE.md");
}

// ── Public API ──────────────────────────────────────────────

export function listVibes(): VibeMeta[] {
  ensureRoot();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(VIBES_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: VibeMeta[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const meta = safeReadMeta(e.name);
    if (meta) out.push(meta);
  }
  out.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  return out;
}

export function getVibe(id: string): VibeMeta | null {
  ensureRoot();
  return safeReadMeta(id);
}

export function createVibe(name: string, description?: string): VibeMeta {
  ensureRoot();
  const trimmed = (name || "").trim() || "Untitled vibe";
  const id = uniqueId(trimmed);
  const now = new Date().toISOString();

  // Scaffold the project tree: <id>/code/ + seed plan.md + CLAUDE.md.
  fs.mkdirSync(vibeCodeDir(id), { recursive: true });
  if (!fs.existsSync(vibePlanPath(id))) {
    fs.writeFileSync(vibePlanPath(id), STARTER_PLAN, { mode: 0o600 });
  }
  if (!fs.existsSync(vibeClaudePath(id))) {
    fs.writeFileSync(vibeClaudePath(id), STARTER_CLAUDE, { mode: 0o600 });
  }

  const meta: VibeMeta = {
    id,
    name: trimmed,
    description: description?.trim() || undefined,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2), { mode: 0o600 });
  return meta;
}

export function saveVibe(meta: VibeMeta): void {
  ensureRoot();
  assertId(meta.id);
  fs.mkdirSync(vibeDir(meta.id), { recursive: true });
  const existing = safeReadMeta(meta.id);
  const merged: VibeMeta = {
    ...meta,
    createdAt: existing?.createdAt || meta.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(metaPath(meta.id), JSON.stringify(merged, null, 2), { mode: 0o600 });
}

export function deleteVibe(id: string): boolean {
  ensureRoot();
  try {
    fs.rmSync(vibeDir(id), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
