/**
 * adaL ThoughtGlyphEncoder — text → structured glyph.
 *
 * Port of ada/memory/thought_glyph.py. Five layers (perspective/semantic/
 * relational/temporal/direction). Words matched against PrimitiveSpace activate
 * layer/segments; unmatched words become content words. Recall rides primarily
 * on the bag-of-words content vector; the per-layer cortices add structural
 * discrimination.
 */

import { bagOfWords, tokenize, DEFAULT_SEED, DEFAULT_DIM } from "../core/encode";
import { generateSymbol, bind, bundle, type Bipolar } from "../core/ops";
import { PrimitiveSpace } from "./primitives";

// role name → "{layer}_{segment}" attribute key (ada's ROLE_TO_LAYER_SEGMENT).
export const ROLE_TO_LAYER_SEGMENT: Record<string, [string, string]> = {
  self: ["perspective", "self"], other: ["perspective", "other"],
  third: ["perspective", "third"], group: ["perspective", "group"], others: ["perspective", "group"],
  identity: ["semantic", "identity"], quality: ["semantic", "quality"],
  quantity: ["semantic", "quantity"], ordinal: ["semantic", "quantity"],
  emotion: ["semantic", "emotion"], preference: ["semantic", "emotion"],
  affirmation: ["semantic", "category"], negation: ["semantic", "category"],
  absence: ["semantic", "category"], presence: ["semantic", "category"],
  totality: ["semantic", "category"], classification: ["semantic", "category"],
  size: ["semantic", "quality"], speed: ["semantic", "quality"],
  temperature: ["semantic", "quality"], age: ["semantic", "quality"],
  difficulty: ["semantic", "quality"], language: ["semantic", "category"],
  abstract: ["semantic", "category"], topic: ["semantic", "category"],
  equals: ["relational", "equals"], similarity: ["relational", "comparison"],
  difference: ["relational", "comparison"], comparison: ["relational", "comparison"],
  possession: ["relational", "possession"], composition: ["relational", "possession"],
  cause: ["relational", "causation"], effect: ["relational", "causation"],
  causation: ["relational", "causation"], condition: ["relational", "causation"],
  consequence: ["relational", "causation"], action: ["relational", "action"],
  ability: ["relational", "action"], desire: ["relational", "action"],
  obligation: ["relational", "action"], attempt: ["relational", "action"],
  begin: ["relational", "action"], end: ["relational", "action"],
  transfer: ["relational", "action"], knowledge: ["relational", "action"],
  communication: ["relational", "action"], perception: ["relational", "action"],
  purpose: ["relational", "action"], opposition: ["relational", "comparison"],
  accompaniment: ["relational", "possession"], location: ["relational", "action"],
  spatial: ["relational", "action"],
  past: ["temporal", "past"], present: ["temporal", "present"], future: ["temporal", "future"],
  duration: ["temporal", "present"],
  direction: ["direction", "incoming"], incoming: ["direction", "incoming"],
  outgoing: ["direction", "outgoing"],
  question: ["semantic", "category"], intensifier: ["semantic", "quality"],
  modifier: ["semantic", "quality"],
};

export const LAYER_WEIGHTS: Record<string, number> = {
  perspective: 0.25, semantic: 0.3, relational: 0.25, temporal: 0.1, direction: 0.1,
};

export interface ThoughtGlyph {
  contentVector: Bipolar;
  contentWords: string[];
  activatedAttrs: string[];
  layerCortex: Record<string, Bipolar>;
  globalCortex: Bipolar;
  metadata: Record<string, unknown>;
}

export class ThoughtGlyphEncoder {
  private primitives: PrimitiveSpace;
  private seed: number;
  private dim: number;

  constructor(primitives?: PrimitiveSpace, seed = DEFAULT_SEED, dim = DEFAULT_DIM) {
    this.primitives = primitives ?? new PrimitiveSpace();
    this.seed = seed;
    this.dim = dim;
  }

  encodeThought(
    text: string,
    speaker: "incoming" | "outgoing" | "schema" | "curriculum" = "incoming",
    metadata: Record<string, unknown> = {},
  ): ThoughtGlyph {
    let words = tokenize(text);
    if (words.length === 0) words = [text.toLowerCase().trim()];

    // Classify: primitive (structural) vs content (semantic).
    const segmentRoles = new Map<string, string>(); // attrKey → roleName
    const contentWords: string[] = [];
    for (const word of words) {
      const roles = this.primitives.matchRoles(word);
      if (roles.length > 0) {
        for (const role of roles) {
          const ls = ROLE_TO_LAYER_SEGMENT[role];
          if (!ls) continue;
          const attrKey = `${ls[0]}_${ls[1]}`;
          if (!segmentRoles.has(attrKey)) segmentRoles.set(attrKey, role);
        }
      } else {
        contentWords.push(word);
      }
    }

    // Direction segment from speaker.
    const dirKey = `direction_${speaker === "outgoing" ? "outgoing" : "incoming"}`;
    if (!segmentRoles.has(dirKey)) segmentRoles.set(dirKey, speaker);

    const contentVector = bagOfWords(
      contentWords.length ? contentWords.join(" ") : words.join(" "),
      this.seed,
      this.dim,
    );

    // Per-layer cortex: bundle bind(roleSymbol, contentVector) over activated
    // segments in that layer. Captures "shared structure + content".
    const byLayer = new Map<string, Bipolar[]>();
    for (const [attrKey, roleName] of segmentRoles) {
      const layer = attrKey.split("_")[0];
      const roleSym = generateSymbol(this.seed, `role:${attrKey}:${roleName}`, this.dim);
      const segVec = bind(roleSym, contentVector);
      const arr = byLayer.get(layer) ?? [];
      arr.push(segVec);
      byLayer.set(layer, arr);
    }
    const layerCortex: Record<string, Bipolar> = {};
    for (const [layer, vecs] of byLayer) layerCortex[layer] = bundle(vecs);

    const layerVecs = Object.values(layerCortex);
    const globalCortex = layerVecs.length ? bundle(layerVecs) : contentVector;

    const activatedAttrs = [...segmentRoles.keys()].sort();
    return {
      contentVector,
      contentWords,
      activatedAttrs,
      layerCortex,
      globalCortex,
      metadata: { ...metadata },
    };
  }
}
