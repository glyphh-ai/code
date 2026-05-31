/**
 * adaL — public surface over the HDC glyph substrate.
 *
 * The two cognitive surfaces (think = associative recall, ask = targeted
 * retrieval with honest refusal) plus the write path (tell). This is the single
 * entrypoint the agent loop, the adaL_* tools, and the REPL all call.
 *
 * `tell` attaches an offline heuristic structure parse to the stored row's
 * metadata. `tellSmart` and `answer` reach into yo's LLM (sdkComplete) for the
 * richer enrich / render seams ported from ada, degrading gracefully when the
 * LLM is unavailable. think/ask ride on the substrate's content-cosine recall.
 */

import { ThoughtGlyphSpace, ThoughtStore, Speaker } from "./thought/space";
import { ThoughtGlyphEncoder } from "./thought/encoder";
import { enrichFact, heuristicEnrich, renderAnswer, type StructuredFact } from "./llm";
import { GlyphDreamLoop } from "./dream";
import type { SerInsight } from "./dream/protocol";

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
  readonly dream: GlyphDreamLoop;
  private minConfidence: number;

  constructor(store: ThoughtStore | null = null, minConfidence = 0.35) {
    this.space = new ThoughtGlyphSpace(new ThoughtGlyphEncoder(), store);
    this.dream = new GlyphDreamLoop(this.space);
    this.minConfidence = minConfidence;
  }

  get count(): number {
    return this.space.count;
  }

  /** Begin the background dream loop. Safe to call repeatedly (idempotent) and a
   *  no-op when worker_threads are unavailable. */
  startDream(): void {
    this.dream.start();
  }

  /** Drain accumulated dream insights (FIFO). */
  drainInsights(): SerInsight[] {
    return this.dream.drainInsights();
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

  /** Absorb a fact into the substrate. Returns the stored id, or null if dup.
   *  Attaches an offline heuristic structure parse to metadata — inert for the
   *  content-cosine recall path, but persisted for introspection and the LLM
   *  seams. Use `tellSmart` for LLM-grade structure. */
  tell(text: string, speaker: Speaker = "incoming", key: string | null = null): string | null {
    const structured = heuristicEnrich(text);
    const stored = this.space.absorb(text, speaker, this.factMetadata(structured), key);
    if (stored) this.dream.notifyAbsorb();
    return stored ? stored.thoughtId : null;
  }

  /** Raw ingestion — no enrichment, no structure metadata. */
  tellRaw(text: string, speaker: Speaker = "incoming", key: string | null = null): string | null {
    const stored = this.space.absorb(text, speaker, {}, key);
    if (stored) this.dream.notifyAbsorb();
    return stored ? stored.thoughtId : null;
  }

  /** LLM-enriched ingestion (ada's HaikuEnricher/UniversalEnricher seam, routed
   *  through yo's LLM). Falls back to heuristic structure on LLM failure. */
  async tellSmart(text: string, speaker: Speaker = "incoming", key: string | null = null): Promise<string | null> {
    const structured = await enrichFact(text);
    const stored = this.space.absorb(text, speaker, this.factMetadata(structured), key);
    if (stored) this.dream.notifyAbsorb();
    return stored ? stored.thoughtId : null;
  }

  /** Grounded natural-language answer (ada's generate.py renderer seam). Recalls
   *  context, then renders via yo's LLM; falls back to the top recalled fact
   *  (or honest refusal) when the LLM is unavailable. */
  async answer(question: string, topK = 5): Promise<{ answer: string; refused: boolean; rendered: boolean }> {
    const results = this.space.recall(question, topK);
    if (results.length === 0 || results[0].similarity < this.minConfidence) {
      return { answer: "I don't know.", refused: true, rendered: false };
    }
    const context = this.space.formatRecall(results, topK);
    const rendered = await renderAnswer(context, question);
    if (rendered) return { answer: rendered, refused: false, rendered: true };
    return { answer: results[0].thought.content, refused: false, rendered: false };
  }

  private factMetadata(f: StructuredFact): Record<string, unknown> {
    if (!f.subject && !f.predicate && !f.object) return {};
    return { structured: { subject: f.subject, predicate: f.predicate, object: f.object, topic: f.topic } };
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
  // Kick off the background dream loop. Degrades to a no-op if worker_threads
  // aren't available, so this never hard-fails substrate init.
  try {
    _adal.startDream();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[adaL] dream loop failed to start:", err instanceof Error ? err.message : err);
  }
  return _adal;
}
