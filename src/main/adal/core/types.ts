/**
 * adaL core types — TS port of the parts of ada/core/types.py the live
 * think/tell/ask path actually uses. Bipolar vectors are Int8Array (see ops.ts);
 * the Vector wrapper carries the space_id for cross-space consistency checks.
 */

import { createHash } from "crypto";
import type { Bipolar } from "./ops";

export interface Vector {
  data: Bipolar;
  dimension: number;
  spaceId: string;
}

export function makeVector(data: Bipolar, spaceId: string): Vector {
  return { data, dimension: data.length, spaceId };
}

export interface Concept {
  name: string;
  attributes: Record<string, string>;
  metadata: Record<string, unknown>;
}

/**
 * A Glyph in the live path is, in practice, its global content vector plus
 * metadata. The full layer/segment hierarchy from ada exists for inspection
 * but recall rides on the content vector (see thought_glyph `_content_vector`).
 */
export interface Glyph {
  identifier: string;
  name: string;
  spaceId: string;
  globalCortex: Vector;
  contentVector: Bipolar;
  metadata: Record<string, unknown>;
}

/** Deterministic 16-char vector-space id from dimension + seed + config. */
export function computeSpaceId(dimension: number, seed: number, configJson: string): string {
  const digest = createHash("sha256")
    .update(`${dimension}:${seed}:${configJson}`)
    .digest("hex");
  return digest.slice(0, 16);
}
