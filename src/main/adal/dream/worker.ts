/**
 * adaL dream worker — the heavy half of the dual dream loop, run on a
 * worker_thread so the O(n²) cosine sweeps never touch the Electron main event
 * loop. A trimmed-but-faithful port of ada/memory/glyph_dream.py that rides only
 * on the substrate surfaces actually available in the TS port (content-cosine
 * recall + per-glyph globalCortex), with no reasoning chains / pathway library /
 * primitive minting.
 *
 * Protocol: main posts WorkerIn { type: "localized" | "deep", rows } where rows
 * are raw ThoughtRows (serializable — no glyph, no native deps). The worker
 * rebuilds a ThoughtGlyphSpace from those rows via a tiny in-memory store (the
 * encoder is deterministic, so vectors/ids line up with the authoritative space
 * on main), runs the cycle, and posts back WorkerOut { insights, reinforce }.
 * Reinforce/decay are applied by main against the authoritative space; the
 * worker only *suggests*.
 *
 * Module-scope state (curiosity, convergence, crystallization candidates, seen
 * insights) persists across cycles for the lifetime of the worker, mirroring the
 * long-lived loop object in ada.
 */

import { parentPort } from "worker_threads";
import { cosineSimilarity, bundle, type Bipolar } from "../core/ops";
import { ThoughtGlyphEncoder } from "../thought/encoder";
import {
  ThoughtGlyphSpace,
  type ThoughtRow,
  type ThoughtStore,
  type StoredThought,
} from "../thought/space";
import type { InsightKind, SerInsight, WorkerIn, WorkerOut } from "./protocol";

// ── In-worker store: hydrate a space from posted rows, no persistence ───────

class MemoryThoughtStore implements ThoughtStore {
  constructor(private rows: ThoughtRow[]) {}
  upsert(_row: ThoughtRow): void {}
  delete(_id: string): void {}
  loadAll(): ThoughtRow[] {
    return this.rows;
  }
}

// ── Persistent loop state (lives for the worker's lifetime) ─────────────────

/** thoughtId → accumulated curiosity score (how often it surfaced unresolved). */
const curiosity = new Map<string, number>();
/** "idA|idB" → times this pair co-activated (drives CONNECTION insights). */
const convergence = new Map<string, number>();
/** synthetic-midpoint signature → times it recurred (drives CRYSTALLIZATION). */
const crystallization = new Map<string, number>();
/** insight dedup — content signature → true. */
const seen = new Set<string>();

const SELF_REINFORCE_CAP = 0.5;
const CONNECT_LOW = 0.05;
const CONNECT_HIGH = 0.6;
const CONNECT_TOP = 10;

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function insightSig(kind: InsightKind, atoms: string[]): string {
  return `${kind}:${[...atoms].sort().join("|")}`;
}

function mkInsight(
  kind: InsightKind,
  summary: string,
  atoms: string[],
  confidence: number,
  chainDepth: number,
): SerInsight | null {
  const sig = insightSig(kind, atoms);
  if (seen.has(sig)) return null;
  seen.add(sig);
  return { kind, summary, atoms, confidence, chainDepth, timestamp: Date.now() / 1000 };
}

// ── Localized (REM) cycle — fast associative wander, ~50 thoughts ───────────
//
// Wander: pick a seed from the working set, recall its neighbourhood. Hunt:
// score curiosity for unresolved (mid-similarity) neighbours. Converge: when a
// pair keeps co-activating, surface a CONNECTION and Hebbian-reinforce both.

function localizedCycle(space: ThoughtGlyphSpace): WorkerOut {
  const insights: SerInsight[] = [];
  const reinforce: Array<{ id: string; amount: number }> = [];

  const seeds = space.loadWorkingSet("random", 12);
  for (const seed of seeds) {
    const neighbours = space.recall(seed.content, 5).filter((r) => r.thought.thoughtId !== seed.thoughtId);
    if (neighbours.length === 0) continue;

    // Hunt — mid-similarity neighbours are "interesting but unresolved".
    for (const n of neighbours) {
      const sim = n.similarity;
      if (sim > 0.15 && sim < 0.9) {
        curiosity.set(n.thought.thoughtId, (curiosity.get(n.thought.thoughtId) ?? 0) + sim);
      }
      // Converge — track co-activation of seed↔neighbour.
      const pk = pairKey(seed.thoughtId, n.thought.thoughtId);
      const co = (convergence.get(pk) ?? 0) + 1;
      convergence.set(pk, co);
      if (co >= 3) {
        const ins = mkInsight(
          "convergence",
          `"${seed.content}" and "${n.thought.content}" keep co-activating`,
          [seed.thoughtId, n.thought.thoughtId],
          Math.min(1, n.similarity + 0.1 * co),
          1,
        );
        if (ins) {
          insights.push(ins);
          reinforce.push({ id: seed.thoughtId, amount: Math.min(SELF_REINFORCE_CAP, 0.05 * co) });
          reinforce.push({ id: n.thought.thoughtId, amount: Math.min(SELF_REINFORCE_CAP, 0.05 * co) });
        }
      }
    }
  }

  return { type: "result", cycle: "localized", insights, reinforce };
}

// ── Deep (slow-wave) cycle — survey → connect → generate → crystallize → gaps

function deepCycle(space: ThoughtGlyphSpace): WorkerOut {
  const insights: SerInsight[] = [];
  const reinforce: Array<{ id: string; amount: number }> = [];

  // Survey — recent / weak / random thirds, deduped, capped at 200.
  const survey = new Map<string, StoredThought>();
  for (const strat of ["recent", "weak", "random"] as const) {
    for (const t of space.loadWorkingSet(strat, 67)) survey.set(t.thoughtId, t);
    if (survey.size >= 200) break;
  }
  const pool = [...survey.values()].slice(0, 200);
  if (pool.length < 2) return { type: "result", cycle: "deep", insights, reinforce };

  // Connect — pairwise globalCortex cosine in the "non-trivial" band. Keep the
  // strongest CONNECT_TOP links; a recurring link becomes a CONNECTION insight.
  type Link = { a: StoredThought; b: StoredThought; sim: number };
  const links: Link[] = [];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const sim = cosineSimilarity(pool[i].glyph.globalCortex, pool[j].glyph.globalCortex);
      if (sim > CONNECT_LOW && sim < CONNECT_HIGH) links.push({ a: pool[i], b: pool[j], sim });
    }
  }
  links.sort((x, y) => y.sim - x.sim);
  const top = links.slice(0, CONNECT_TOP);

  for (const { a, b, sim } of top) {
    const pk = pairKey(a.thoughtId, b.thoughtId);
    const co = (convergence.get(pk) ?? 0) + 1;
    convergence.set(pk, co);
    if (co >= 2) {
      const ins = mkInsight(
        "connection",
        `"${a.content}" relates to "${b.content}" (${sim.toFixed(2)})`,
        [a.thoughtId, b.thoughtId],
        sim,
        2,
      );
      if (ins) insights.push(ins);
    }

    // Generate — synthesize the midpoint of the link and find the nearest
    // existing thought. A recurring "empty neighbourhood" around a midpoint is a
    // crystallization candidate (a concept the substrate keeps gesturing at).
    const mid = bundle([a.glyph.globalCortex, b.glyph.globalCortex]);
    const near = nearestByGlobal(space, mid, [a.thoughtId, b.thoughtId]);
    if (!near || near.sim < 0.15) {
      const csig = pairKey(a.thoughtId, b.thoughtId);
      const c = (crystallization.get(csig) ?? 0) + 1;
      crystallization.set(csig, c);
      if (c >= 3) {
        const ins = mkInsight(
          "crystallization",
          `a latent concept keeps emerging between "${a.content}" and "${b.content}"`,
          [a.thoughtId, b.thoughtId],
          Math.min(1, 0.3 + 0.1 * c),
          3,
        );
        if (ins) insights.push(ins);
      }
    } else {
      // Bridge exists — Hebbian-reinforce the bridging thought.
      reinforce.push({ id: near.id, amount: Math.min(SELF_REINFORCE_CAP, 0.05) });
    }
  }

  // Gaps — high-curiosity thoughts with sparse neighbourhoods become QUESTIONs.
  for (const [id, score] of [...curiosity.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    const t = space.getThought(id);
    if (!t) {
      curiosity.delete(id);
      continue;
    }
    if (score < 1.0) continue;
    const neigh = space.recall(t.content, 4).filter((r) => r.thought.thoughtId !== id);
    const strong = neigh.filter((r) => r.similarity > 0.4).length;
    if (strong === 0) {
      const ins = mkInsight(
        "question",
        `what connects "${t.content}" to the rest? (curiosity ${score.toFixed(2)}, sparse neighbourhood)`,
        [id],
        Math.min(1, score / 5),
        2,
      );
      if (ins) insights.push(ins);
    }
    // Curiosity cools after inspection.
    curiosity.set(id, score * 0.5);
  }

  return { type: "result", cycle: "deep", insights, reinforce };
}

function nearestByGlobal(
  space: ThoughtGlyphSpace,
  vec: Bipolar,
  exclude: string[],
): { id: string; sim: number } | null {
  const ex = new Set(exclude);
  let best: { id: string; sim: number } | null = null;
  for (const t of space.allThoughts()) {
    if (ex.has(t.thoughtId)) continue;
    const sim = cosineSimilarity(vec, t.glyph.globalCortex);
    if (!best || sim > best.sim) best = { id: t.thoughtId, sim };
  }
  return best;
}

// ── Message pump ────────────────────────────────────────────────────────────

function buildSpace(rows: ThoughtRow[]): ThoughtGlyphSpace {
  return new ThoughtGlyphSpace(new ThoughtGlyphEncoder(), new MemoryThoughtStore(rows));
}

parentPort?.on("message", (msg: WorkerIn) => {
  try {
    const space = buildSpace(msg.rows);
    const out: WorkerOut = msg.type === "deep" ? deepCycle(space) : localizedCycle(space);
    parentPort?.postMessage(out);
  } catch (err) {
    // Never let a cycle crash the worker — emit an empty result so main keeps
    // scheduling.
    const out: WorkerOut = {
      type: "result",
      cycle: msg.type === "deep" ? "deep" : "localized",
      insights: [],
      reinforce: [],
    };
    parentPort?.postMessage(out);
  }
});
