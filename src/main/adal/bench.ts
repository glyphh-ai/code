/**
 * adaL scale benchmark — validates the substrate before we roll it out to
 * customers. Answers the three questions that actually matter, because recall
 * runs an O(N) in-memory cosine scan on the critical path of EVERY turn:
 *
 *   1. Latency  — how does recall p50/p99 grow with corpus size N?
 *   2. Memory   — RAM footprint of the in-memory Map (everything is resident).
 *   3. Quality  — does the RIGHT memory still surface as N grows? (precision@5,
 *                 recall@5, MRR over planted topical clusters vs. random noise).
 *
 * It drives the REAL substrate (ThoughtGlyphSpace.recall + .absorb + the real
 * encoder), not a mock — so the curves are what production will do. Pure
 * in-memory by default (the recall hot path never touches SQLite); pass
 * --sqlite to additionally time a hydrate round-trip through a temp DB.
 *
 * Run:  npm run bench:adal              # default N sweep
 *       npm run bench:adal -- 1000,10000,50000,100000
 *       npm run bench:adal -- 50000 --sqlite
 */

import os from "os";
import path from "path";
import fs from "fs";
import { ThoughtGlyphSpace, type Speaker } from "./thought/space";
import { ThoughtGlyphEncoder } from "./thought/encoder";

// ── Synthetic corpus generation ─────────────────────────────────────────────
//
// We plant PROBE_TOPICS topical clusters (each a distinct vocabulary) and bury
// them in random-noise filler. A query is built from one topic's vocabulary;
// the "relevant" set is exactly that topic's planted thoughts. This lets us
// measure precision/recall as the noise floor rises with N.

const PROBE_TOPICS = 24;          // distinct planted clusters
const PER_TOPIC = 8;              // planted thoughts per cluster
const QUERIES_PER_TOPIC = 3;      // distinct queries per cluster (avg the metrics)
const LATENCY_SAMPLES = 60;       // recall() timings per N

// Each topic gets a unique bag of "content words" so its thoughts cluster in
// HDC space. Words are synthetic but lexically distinct (real recall is
// content-cosine primary, so distinct vocab => distinct clusters).
function topicVocab(topicId: number): string[] {
  const stems = [
    "quark", "lattice", "ferment", "glacier", "syntax", "marrow", "trellis",
    "plasma", "cobalt", "nimbus", "verdigris", "obsidian", "saffron", "tundra",
    "zephyr", "basalt", "cinder", "hollow", "meridian", "quartz", "thistle",
    "umbra", "vellum", "willow", "axiom", "bramble", "cipher", "delta",
  ];
  // 6 distinct words per topic, rotated so topics don't overlap.
  const out: string[] = [];
  for (let i = 0; i < 6; i++) out.push(stems[(topicId * 6 + i) % stems.length] + (topicId % 7));
  return out;
}

const FILLER_WORDS = (
  "the system runs a process across many nodes while the user observes output " +
  "data flows through layers and the result returns to the caller after work " +
  "completes in time with memory and compute bounded by the budget we set"
).split(/\s+/);

function fillerSentence(seed: number): string {
  // Deterministic-ish pseudo-random filler, salted with `seed` so every thought
  // is unique (absorb() dedups identical text).
  const words: string[] = [];
  let x = seed * 2654435761 >>> 0;
  const n = 8 + (x % 9);
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    words.push(FILLER_WORDS[x % FILLER_WORDS.length]);
  }
  return `note ${seed}: ${words.join(" ")}`;
}

function plantedThought(topicId: number, idx: number): string {
  const v = topicVocab(topicId);
  return `topic ${topicId} memo ${idx}: ${v[0]} ${v[1]} relates to ${v[2]} and ${v[3]} via ${v[4]} ${v[5]}`;
}

function topicQuery(topicId: number, qIdx: number): string {
  const v = topicVocab(topicId);
  // Vary which subset of the topic vocab the query uses, so it isn't identical
  // to any single planted thought.
  const a = v[qIdx % v.length];
  const b = v[(qIdx + 2) % v.length];
  const c = v[(qIdx + 4) % v.length];
  return `what about ${a} and ${b} ${c}`;
}

// ── Metrics helpers ─────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function fmt(n: number, d = 1): string {
  return n.toFixed(d);
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1) + "MB";
}

// ── One run at a given corpus size ──────────────────────────────────────────

interface RunResult {
  n: number;
  seedMs: number;
  rssMb: number;
  heapMb: number;
  p50: number;
  p99: number;
  max: number;
  precisionAt5: number;
  recallAt5: number;
  mrr: number;
}

function runAt(targetN: number, useSqlite: boolean): RunResult {
  const encoder = new ThoughtGlyphEncoder();

  let store: import("./thought/space").ThoughtStore | null = null;
  let tmpDbPath: string | null = null;
  if (useSqlite) {
    try {
      const { SqliteThoughtStore } = require("./thought/store") as typeof import("./thought/store");
      tmpDbPath = path.join(os.tmpdir(), `adal-bench-${Date.now()}-${targetN}.sqlite`);
      store = new SqliteThoughtStore(tmpDbPath);
    } catch (err) {
      console.warn("  [sqlite unavailable, falling back to in-memory]:", err instanceof Error ? err.message : err);
      store = null;
    }
  }

  const space = new ThoughtGlyphSpace(encoder, store);

  // Plant topical clusters first, then fill the rest with noise up to targetN.
  const planted = PROBE_TOPICS * PER_TOPIC;
  const fillerCount = Math.max(0, targetN - planted);

  const t0 = Date.now();
  for (let topic = 0; topic < PROBE_TOPICS; topic++) {
    for (let i = 0; i < PER_TOPIC; i++) {
      space.absorb(plantedThought(topic, i), "incoming" as Speaker);
    }
  }
  for (let i = 0; i < fillerCount; i++) {
    space.absorb(fillerSentence(i), "incoming" as Speaker);
  }
  const seedMs = Date.now() - t0;

  // ── Latency: time recall() on a spread of queries ──
  const latencies: number[] = [];
  for (let s = 0; s < LATENCY_SAMPLES; s++) {
    const topic = s % PROBE_TOPICS;
    const q = topicQuery(topic, s % QUERIES_PER_TOPIC);
    const t = process.hrtime.bigint();
    space.recall(q, 5, 0.01, "incoming", { contentGate: true, relativeFloor: 0.6 });
    latencies.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  latencies.sort((a, b) => a - b);

  // ── Quality: precision@5 / recall@5 / MRR over every planted topic query ──
  let precSum = 0, recSum = 0, mrrSum = 0, qCount = 0;
  for (let topic = 0; topic < PROBE_TOPICS; topic++) {
    for (let qi = 0; qi < QUERIES_PER_TOPIC; qi++) {
      const q = topicQuery(topic, qi);
      const res = space.recall(q, 5, 0.01, "incoming", { contentGate: true, relativeFloor: 0.6 });
      const tag = `topic ${topic} `;
      const hits = res.map((r) => r.thought.content.startsWith(tag));
      const relevantInTop5 = hits.filter(Boolean).length;
      precSum += res.length ? relevantInTop5 / res.length : 0;   // precision@5
      recSum += relevantInTop5 / PER_TOPIC;                       // recall@5
      const firstRank = hits.indexOf(true);
      mrrSum += firstRank >= 0 ? 1 / (firstRank + 1) : 0;         // reciprocal rank
      qCount++;
    }
  }

  const memNow = process.memoryUsage();

  if (tmpDbPath) {
    try { fs.rmSync(tmpDbPath, { force: true }); fs.rmSync(tmpDbPath + "-wal", { force: true }); fs.rmSync(tmpDbPath + "-shm", { force: true }); } catch { /* ignore */ }
  }

  return {
    n: space.count,
    seedMs,
    rssMb: memNow.rss,
    heapMb: memNow.heapUsed,
    p50: percentile(latencies, 50),
    p99: percentile(latencies, 99),
    max: latencies[latencies.length - 1],
    precisionAt5: precSum / qCount,
    recallAt5: recSum / qCount,
    mrr: mrrSum / qCount,
  };
}

// ── Driver ──────────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const useSqlite = args.includes("--sqlite");
  const sizeArg = args.find((a) => !a.startsWith("--"));
  const sizes = sizeArg
    ? sizeArg.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => n > 0)
    : [1000, 10000, 50000, 100000];

  console.log("\nadaL scale benchmark — recall is an O(N) in-memory cosine scan on every turn.");
  console.log(`planted clusters: ${PROBE_TOPICS} topics × ${PER_TOPIC} thoughts; sqlite: ${useSqlite ? "yes (hydrate timed)" : "no (in-memory)"}\n`);

  const header = ["N", "seed", "rss", "heap", "recall p50", "p99", "max", "prec@5", "recall@5", "MRR"];
  const widths = [9, 7, 8, 8, 11, 8, 8, 8, 9, 6];
  const pad = (s: string, w: number) => s.padStart(w);
  console.log(header.map((h, i) => pad(h, widths[i])).join("  "));
  console.log(widths.map((w) => "─".repeat(w)).join("  "));

  for (const size of sizes) {
    const r = runAt(size, useSqlite);
    const row = [
      String(r.n),
      r.seedMs >= 1000 ? fmt(r.seedMs / 1000) + "s" : r.seedMs + "ms",
      mb(r.rssMb),
      mb(r.heapMb),
      fmt(r.p50, 2) + "ms",
      fmt(r.p99, 2) + "ms",
      fmt(r.max, 2) + "ms",
      fmt(r.precisionAt5 * 100, 0) + "%",
      fmt(r.recallAt5 * 100, 0) + "%",
      fmt(r.mrr, 2),
    ];
    console.log(row.map((s, i) => pad(s, widths[i])).join("  "));
  }

  console.log("\nRead:");
  console.log("  • recall p99 is the per-turn latency tax — pick an SLO (e.g. <50ms) and find the N that blows it.");
  console.log("  • prec@5 dropping as N grows = the noise floor swallowing real memories (the real customer risk).");
  console.log("  • rss is the resident cost per user — the whole store lives in a Map, so it grows linearly.\n");
}

main();
