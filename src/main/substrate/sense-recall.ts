/**
 * sense.recall — "have I done something like this before?"
 *
 * Combines two sources:
 *   1. Substrate memory (past run patterns: intent + skill chain → outcome)
 *   2. Vector search across captures + library notes (delegated to caller)
 */

import { Intent, RecallMatch } from "./types";
import { findSimilarRuns } from "./store";

interface RecallDeps {
  vectorSearch?: (query: string, limit: number) => Promise<Array<{ id: string; preview: string; score: number }>>;
}

let deps: RecallDeps = {};

export function setRecallDeps(d: RecallDeps): void { deps = { ...deps, ...d }; }

export async function senseRecall(intent: Intent, skill: string, query?: string, limit = 5): Promise<{
  patterns: RecallMatch[];
  evidence: Array<{ id: string; preview: string; score: number }>;
}> {
  const past = findSimilarRuns(intent, skill, limit);
  const patterns: RecallMatch[] = past.map((r) => ({
    intent: r.intent,
    skills: r.chain,
    outcome: r.outcome,
    durationMs: r.durationMs,
    at: r.at,
  }));

  let evidence: Array<{ id: string; preview: string; score: number }> = [];
  if (query && deps.vectorSearch) {
    try {
      evidence = await deps.vectorSearch(query, Math.max(3, limit));
    } catch {
      evidence = [];
    }
  }

  return { patterns, evidence };
}
