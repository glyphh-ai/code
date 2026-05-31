/**
 * adaL — public surface over the HDC glyph substrate.
 *
 * The two cognitive surfaces (think = associative recall, ask = targeted
 * retrieval with honest refusal) plus the write path (tell). This is the single
 * entrypoint the agent loop, the adaL_* tools, and the REPL all call.
 *
 * `tell` currently stores via plain absorb (no LLM enrichment — that seam is
 * rerouted into yo's LLM in Phase 3). think/ask ride on the substrate's
 * content-cosine recall.
 */

import { ThoughtGlyphSpace, ThoughtStore, Speaker } from "./thought/space";
import { ThoughtGlyphEncoder } from "./thought/encoder";

export interface AdalThought {
  id: string;
  content: string;
  speaker: string;
  similarity: number;
}

export interface AdalActivation {
  input: string;
  thoughts: AdalThought[];
  /** Pre-rendered block suitable for injecting as a grounded system prefix. */
  groundedContext: string;
  citations: string[];
}

export interface AdalAnswer {
  question: string;
  answer: string;
  confidence: number;
  refused: boolean;
  fact: string | null;
}

export class Adal {
  readonly space: ThoughtGlyphSpace;
  private minConfidence: number;

  constructor(store: ThoughtStore | null = null, minConfidence = 0.35) {
    this.space = new ThoughtGlyphSpace(new ThoughtGlyphEncoder(), store);
    this.minConfidence = minConfidence;
  }

  get count(): number {
    return this.space.count;
  }

  /** Associative wave — surface the constellation of related thoughts. */
  think(input: string, topK = 8): AdalActivation {
    const results = this.space.recall(input, topK);
    const thoughts: AdalThought[] = results.map((r) => ({
      id: r.thought.thoughtId,
      content: r.thought.content,
      speaker: r.thought.speaker,
      similarity: r.similarity,
    }));
    return {
      input,
      thoughts,
      groundedContext: this.space.formatRecall(results, topK),
      citations: thoughts.map((t) => t.content),
    };
  }

  /** Targeted retrieval — one grounded fact + confidence, or honest refusal. */
  ask(question: string): AdalAnswer {
    const results = this.space.recall(question, 5);
    if (results.length === 0) {
      return { question, answer: "I don't know.", confidence: 0, refused: true, fact: null };
    }
    const top = results[0];
    if (top.similarity < this.minConfidence) {
      return { question, answer: "I don't know.", confidence: top.similarity, refused: true, fact: null };
    }
    return {
      question,
      answer: top.thought.content,
      confidence: top.similarity,
      fact: top.thought.content,
      refused: false,
    };
  }

  /** Absorb a fact into the substrate. Returns the stored id, or null if dup. */
  tell(text: string, speaker: Speaker = "incoming", key: string | null = null): string | null {
    const stored = this.space.absorb(text, speaker, {}, key);
    return stored ? stored.thoughtId : null;
  }

  /** Raw ingestion — identical to tell until the enricher seam lands (Phase 3). */
  tellRaw(text: string, speaker: Speaker = "incoming", key: string | null = null): string | null {
    return this.tell(text, speaker, key);
  }

  history(key: string): Array<{ version: number | null; content: string }> {
    return this.space.history(key).map((t) => ({ version: t.version, content: t.content }));
  }

  drift(key: string): ReturnType<ThoughtGlyphSpace["drift"]> {
    return this.space.drift(key);
  }

  schema(): ReturnType<ThoughtGlyphSpace["stats"]> {
    return this.space.stats();
  }

  reinforce(id: string, amount = 0.1): void {
    this.space.reinforce(id, amount);
  }
}

// ── Singleton wiring ────────────────────────────────────────────────────────

let _adal: Adal | null = null;

/** Lazily construct the process-wide adaL instance, backed by SQLite when
 *  available (Electron). Falls back to in-memory if the native module or disk
 *  is unavailable, so the agent loop never hard-fails on substrate init. */
export function getAdal(): Adal {
  if (_adal) return _adal;
  let store: ThoughtStore | null = null;
  try {
    // Lazy require so non-Electron contexts (plain node tests) don't trip the
    // better-sqlite3 native ABI check.
    const { SqliteThoughtStore } = require("./thought/store") as typeof import("./thought/store");
    store = new SqliteThoughtStore();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[adaL] SQLite store unavailable, using in-memory substrate:", err instanceof Error ? err.message : err);
    store = null;
  }
  _adal = new Adal(store);
  return _adal;
}
