/**
 * Messages exchanged between the dream-loop manager (Electron main) and the
 * dream worker (worker_thread). Rows are raw ThoughtRows (no glyph) — the worker
 * re-encodes them deterministically with the same encoder, so vectors and ids
 * line up with the authoritative space on main.
 */

import type { ThoughtRow } from "../thought/space";

export type InsightKind =
  | "connection"
  | "contradiction"
  | "convergence"
  | "question"
  | "crystallization";

export interface SerInsight {
  kind: InsightKind;
  summary: string;
  atoms: string[];
  confidence: number;
  chainDepth: number;
  timestamp: number;
}

export type WorkerIn =
  | { type: "localized"; rows: ThoughtRow[] }
  | { type: "deep"; rows: ThoughtRow[] };

export interface WorkerOut {
  type: "result";
  cycle: "localized" | "deep";
  insights: SerInsight[];
  /** thoughtId → strength delta to apply on the authoritative space. */
  reinforce: Array<{ id: string; amount: number }>;
}
