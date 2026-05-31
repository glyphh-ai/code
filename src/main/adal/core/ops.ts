/**
 * adaL HDC ops — hyperdimensional computing over bipolar vectors {-1, +1}.
 *
 * TS port of ada/core/ops.py. Bipolar vectors are Int8Array. Because adaL runs
 * on a FRESH substrate (internal consistency only, no numpy byte-parity), the
 * symbol PRNG is our own deterministic hash-seeded generator rather than
 * numpy's RandomState — same guarantee (same key → same vector), different bits.
 */

import { createHash } from "crypto";

export type Bipolar = Int8Array;

/** Element-wise product of two bipolar vectors (role ⊗ value). */
export function bind(r: Bipolar, v: Bipolar): Bipolar {
  if (r.length !== v.length) {
    throw new Error(`Dimension mismatch: r has ${r.length}, v has ${v.length}`);
  }
  const out = new Int8Array(r.length);
  for (let i = 0; i < r.length; i++) out[i] = (r[i] * v[i]) as number;
  return out;
}

/** Majority-vote aggregation of bipolar vectors (ties resolve to +1). */
export function bundle(vectors: Bipolar[]): Bipolar {
  if (vectors.length === 0) throw new Error("Cannot bundle empty vector list");
  const dim = vectors[0].length;
  const sums = new Int32Array(dim);
  for (let v = 0; v < vectors.length; v++) {
    const vec = vectors[v];
    if (vec.length !== dim) {
      throw new Error(`Dimension mismatch: vector 0 has ${dim}, vector ${v} has ${vec.length}`);
    }
    for (let i = 0; i < dim; i++) sums[i] += vec[i];
  }
  const out = new Int8Array(dim);
  for (let i = 0; i < dim; i++) out[i] = sums[i] >= 0 ? 1 : -1;
  return out;
}

/** Cosine similarity for bipolar vectors: dot / dimension. Range [-1, 1]. */
export function cosineSimilarity(v1: Bipolar, v2: Bipolar): number {
  if (v1.length !== v2.length) {
    throw new Error(`Dimension mismatch: v1 has ${v1.length}, v2 has ${v2.length}`);
  }
  let dot = 0;
  for (let i = 0; i < v1.length; i++) dot += v1[i] * v2[i];
  return dot / v1.length;
}

/** Hamming similarity = (cosine + 1) / 2. Range [0, 1]. */
export function hammingSimilarity(v1: Bipolar, v2: Bipolar): number {
  if (v1.length !== v2.length) {
    throw new Error(`Dimension mismatch: v1 has ${v1.length}, v2 has ${v2.length}`);
  }
  let agree = 0;
  for (let i = 0; i < v1.length; i++) if (v1[i] === v2[i]) agree++;
  return agree / v1.length;
}

// ── Deterministic symbol generation ──────────────────────────────────────
//
// mulberry32: a fast, well-distributed 32-bit PRNG. Seeded from a sha256 of
// (seed, key, dimension) so the same key always yields the same hypervector.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const _symbolCache = new Map<string, Bipolar>();

/** Deterministic bipolar symbol for (seed, key, dimension). Cached. */
export function generateSymbol(seed: number, key: string, dimension: number): Bipolar {
  const cacheKey = `${seed}:${key}:${dimension}`;
  const hit = _symbolCache.get(cacheKey);
  if (hit) return hit;

  const digest = createHash("sha256").update(cacheKey).digest("hex");
  const derived = parseInt(digest.slice(0, 8), 16);
  const rng = mulberry32(derived);
  const out = new Int8Array(dimension);
  for (let i = 0; i < dimension; i++) out[i] = rng() < 0.5 ? -1 : 1;

  _symbolCache.set(cacheKey, out);
  return out;
}
