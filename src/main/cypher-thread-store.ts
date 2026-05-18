/**
 * cypher-thread-store — persists cypher orchestration + agent threads locally.
 *
 * Storage layout:
 *   ~/yo/cyphers/<cypher-id>/stage.jsonl     — orchestrator output segments
 *   ~/yo/cyphers/<cypher-id>/agents/<name>.jsonl — per-agent threads
 *
 * Each line is a JSON object: { ts, kind, content, ?toolId, ?toolName }
 * Append-only. On panel init, the main process reads these back and sends
 * them to the renderer to restore state.
 */

import path from "path";
import os from "os";
import fs from "fs";

const CYPHERS_DIR = path.join(os.homedir(), "yo", "cyphers");

function stageFile(cypherId: string): string {
  return path.join(CYPHERS_DIR, cypherId, "stage.jsonl");
}

function agentFile(cypherId: string, agentName: string): string {
  const safe = agentName.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(CYPHERS_DIR, cypherId, "agents", `${safe}.jsonl`);
}

function ensureDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export interface StageEntry {
  ts: number;
  kind: "text" | "tool" | "tool-result" | "done";
  content: string;
  toolId?: string;
  toolName?: string;
}

export interface AgentEntry {
  ts: number;
  kind: "text" | "tool" | "error";
  content: string;
}

export function appendStage(cypherId: string, entry: StageEntry): void {
  const fp = stageFile(cypherId);
  ensureDir(fp);
  fs.appendFileSync(fp, JSON.stringify(entry) + "\n");
}

export function appendAgent(cypherId: string, agentName: string, entry: AgentEntry): void {
  const fp = agentFile(cypherId, agentName);
  ensureDir(fp);
  fs.appendFileSync(fp, JSON.stringify(entry) + "\n");
}

export function loadStage(cypherId: string): StageEntry[] {
  const fp = stageFile(cypherId);
  if (!fs.existsSync(fp)) return [];
  const lines = fs.readFileSync(fp, "utf-8").split("\n").filter(Boolean);
  const entries: StageEntry[] = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch { /* skip corrupt lines */ }
  }
  return entries;
}

export function loadAgent(cypherId: string, agentName: string): AgentEntry[] {
  const fp = agentFile(cypherId, agentName);
  if (!fs.existsSync(fp)) return [];
  const lines = fs.readFileSync(fp, "utf-8").split("\n").filter(Boolean);
  const entries: AgentEntry[] = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch { /* skip corrupt lines */ }
  }
  return entries;
}

export function listAgentThreads(cypherId: string): string[] {
  const dir = path.join(CYPHERS_DIR, cypherId, "agents");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.replace(/\.jsonl$/, ""));
}

// ── Feed persistence ─────────────────────────────────────────────────

export interface FeedEntry {
  ts: number;
  from: string;
  kind: string;
  body: string;
  tags?: string[];
  /** Server-assigned monotonic event id. Persisted so the renderer can dedup
   *  loaded entries against the live SSE stream (and against itself). */
  seq?: number;
}

function feedFile(cypherId: string): string {
  return path.join(CYPHERS_DIR, cypherId, "feed.jsonl");
}

export function appendFeed(cypherId: string, entry: FeedEntry): void {
  const fp = feedFile(cypherId);
  ensureDir(fp);
  fs.appendFileSync(fp, JSON.stringify(entry) + "\n");
}

export function loadFeed(cypherId: string, limit = 200): FeedEntry[] {
  const fp = feedFile(cypherId);
  if (!fs.existsSync(fp)) return [];
  const lines = fs.readFileSync(fp, "utf-8").split("\n").filter(Boolean);
  const entries: FeedEntry[] = [];
  const start = Math.max(0, lines.length - limit);
  for (let i = start; i < lines.length; i++) {
    try { entries.push(JSON.parse(lines[i])); } catch { /* skip corrupt */ }
  }
  return entries;
}
