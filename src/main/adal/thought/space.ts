/**
 * adaL ThoughtGlyphSpace — long-term memory: absorb, recall, history, drift.
 *
 * Port of ada/memory/thought_space.py. Recall is content-cosine-primary with
 * per-layer structural cosine, activated-segment Jaccard, and Hebbian strength +
 * recency boosts (adaptive weights by content-word count, exactly as ada).
 *
 * Persistence is injectable (ThoughtStore). Rows store raw text + metadata only;
 * vectors are re-derived by the deterministic encoder on load — no vector blobs.
 */

import { cosineSimilarity } from "../core/ops";
import { ThoughtGlyphEncoder, ThoughtGlyph, LAYER_WEIGHTS } from "./encoder";

// Short HDC content vectors carry a high noise floor (~0.17–0.19 cosine for
// fully unrelated short texts), so a low absolute eps can't separate signal
// from noise. The content gate instead demands either lexical overlap (a shared
// content word) or a cosine clearly above that noise floor (genuine semantic
// resonance). Below SEMANTIC_FLOOR with no shared word, a hit is noise.
const SEMANTIC_FLOOR = 0.3;

export type Speaker = "incoming" | "outgoing" | "schema" | "curriculum";

export interface ThoughtRow {
  thoughtId: string;
  content: string;
  speaker: Speaker;
  strength: number;
  createdAt: number;
  lastAccessed: number;
  accessCount: number;
  key: string | null;
  version: number | null;
  metadata: Record<string, unknown>;
}

export interface ThoughtStore {
  upsert(row: ThoughtRow): void;
  delete(id: string): void;
  loadAll(): ThoughtRow[];
}

export interface StoredThought extends ThoughtRow {
  glyph: ThoughtGlyph;
}

export interface RecallResult {
  thought: StoredThought;
  similarity: number;
  layerSimilarities: Record<string, number>;
}

function nowSec(): number {
  return Date.now() / 1000;
}

export class ThoughtGlyphSpace {
  private encoder: ThoughtGlyphEncoder;
  private store: ThoughtStore | null;
  private thoughts = new Map<string, StoredThought>();
  private absorbedTexts = new Set<string>();
  private historyByKey = new Map<string, StoredThought[]>();

  constructor(encoder?: ThoughtGlyphEncoder, store?: ThoughtStore | null) {
    this.encoder = encoder ?? new ThoughtGlyphEncoder();
    this.store = store ?? null;
    if (this.store) this.hydrate();
  }

  private hydrate(): void {
    if (!this.store) return;
    const rows = this.store.loadAll().sort((a, b) => a.createdAt - b.createdAt);
    for (const row of rows) {
      const glyph = this.encoder.encodeThought(row.content, row.speaker, row.metadata);
      const stored: StoredThought = { ...row, glyph };
      this.thoughts.set(stored.thoughtId, stored);
      this.absorbedTexts.add(row.content.trim().toLowerCase());
      if (row.key) {
        const chain = this.historyByKey.get(row.key) ?? [];
        chain.push(stored);
        this.historyByKey.set(row.key, chain);
      }
    }
  }

  get count(): number {
    return this.thoughts.size;
  }

  // ── Absorb ────────────────────────────────────────────────────────────────

  absorb(
    text: string,
    speaker: Speaker = "incoming",
    metadata: Record<string, unknown> = {},
    key: string | null = null,
  ): StoredThought | null {
    const textKey = text.trim().toLowerCase();
    if (!textKey || this.absorbedTexts.has(textKey)) return null;

    const glyph = this.encoder.encodeThought(text, speaker, metadata);

    let version = 1;
    let parentId: string | null = null;
    if (key) {
      const chain = this.historyByKey.get(key) ?? [];
      if (chain.length) {
        const prev = chain[chain.length - 1];
        version = (prev.version ?? 1) + 1;
        parentId = prev.thoughtId;
      }
    }

    const thoughtId = key
      ? `${key}@${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}Z#v${version}`
      : Math.random().toString(36).slice(2, 14);

    const meta = { ...metadata };
    if (key) {
      meta._key = key;
      meta._version = version;
      meta._parentId = parentId;
    }

    const stored: StoredThought = {
      thoughtId,
      content: text,
      speaker,
      strength: 1.0,
      createdAt: nowSec(),
      lastAccessed: nowSec(),
      accessCount: 0,
      key,
      version: key ? version : null,
      metadata: meta,
      glyph,
    };

    this.thoughts.set(thoughtId, stored);
    this.absorbedTexts.add(textKey);
    if (key) {
      const chain = this.historyByKey.get(key) ?? [];
      chain.push(stored);
      this.historyByKey.set(key, chain);
    }
    this.store?.upsert(stored);
    return stored;
  }

  // ── Recall ──────────────────────────────────────────────────────────────

  recall(
    query: string,
    topK = 5,
    minSimilarity = 0.01,
    speaker: Speaker = "incoming",
    opts: { contentGate?: boolean; relativeFloor?: number } = {},
  ): RecallResult[] {
    if (this.thoughts.size === 0) return [];

    const q = this.encoder.encodeThought(query, speaker);
    const qNorm = query.trim().toLowerCase().replace(/[?.! ]+$/, "");
    const qActivated = new Set(q.activatedAttrs);
    const qContentWords = new Set(q.contentWords);
    const nContent = q.contentWords.length;

    let wContent: number, wRole: number, wStruct: number;
    if (nContent >= 2) [wContent, wRole, wStruct] = [0.55, 0.3, 0.15];
    else if (nContent === 1) [wContent, wRole, wStruct] = [0.4, 0.4, 0.2];
    else [wContent, wRole, wStruct] = [0.1, 0.65, 0.25];

    const results: RecallResult[] = [];
    for (const stored of this.thoughts.values()) {
      const sNorm = stored.content.trim().toLowerCase().replace(/[?.! ]+$/, "");
      if (sNorm === qNorm) continue;

      const contentSim = Math.max(0, cosineSimilarity(q.contentVector, stored.glyph.contentVector));

      // Content gate — when the query carries real content words, a hit that
      // matches only on speaker-role + recency is noise, not memory. Keep it
      // only if it shares a content word or resonates semantically above the
      // short-text noise floor, so a contentful /think doesn't dredge up
      // unrelated greetings that happen to share a speaker.
      if (opts.contentGate && nContent >= 2) {
        const sharesWord = stored.glyph.contentWords.some((w) => qContentWords.has(w));
        if (!sharesWord && contentSim < SEMANTIC_FLOOR) continue;
      }

      // Layer similarity — weighted per-layer cortex cosine over query-activated layers.
      const sActivated = new Set(stored.glyph.activatedAttrs);
      const layerSims: Record<string, number> = {};
      let weighted = 0;
      let totalWeight = 0;
      for (const [layer, qCortex] of Object.entries(q.layerCortex)) {
        const sCortex = stored.glyph.layerCortex[layer];
        if (!sCortex) continue;
        const w = LAYER_WEIGHTS[layer] ?? 0.1;
        const sim = Math.max(0, cosineSimilarity(qCortex, sCortex));
        layerSims[layer] = sim;
        weighted += sim * w;
        totalWeight += w;
      }
      const roleSim = totalWeight > 0 ? weighted / totalWeight : 0;

      // Structural overlap — Jaccard of activated segments.
      let inter = 0;
      for (const a of qActivated) if (sActivated.has(a)) inter++;
      const union = new Set([...qActivated, ...sActivated]).size || 1;
      const structural = inter / union;

      const similarity = contentSim * wContent + roleSim * wRole + structural * wStruct;

      const strengthBoost = 1.0 + Math.log(1.0 + stored.strength);
      const idleHours = (nowSec() - stored.lastAccessed) / 3600;
      const recencyBoost = 0.3 + 0.7 * Math.exp(-0.05 * idleHours);
      const combined = similarity * strengthBoost * recencyBoost;

      if (combined >= minSimilarity) {
        results.push({ thought: stored, similarity: combined, layerSimilarities: layerSims });
      }
    }

    results.sort((a, b) => b.similarity - a.similarity);

    // Relative floor — once there's a clear top hit, trim the long tail of weak
    // matches that sit far below it. Adapts to the query instead of a fixed
    // absolute cutoff, which is unreliable given strength/recency multipliers.
    if (opts.relativeFloor && results.length > 1) {
      const cutoff = results[0].similarity * opts.relativeFloor;
      return results.filter((r) => r.similarity >= cutoff).slice(0, topK);
    }
    return results.slice(0, topK);
  }

  // ── Versioned-concept queries ──────────────────────────────────────────────

  history(key: string): StoredThought[] {
    return [...(this.historyByKey.get(key) ?? [])];
  }

  drift(key: string): {
    key: string;
    versions: number;
    consecutiveSimilarities?: number[];
    firstToLastSimilarity?: number;
    driftRate?: number;
  } {
    const hist = this.history(key);
    if (hist.length < 2) return { key, versions: hist.length };
    const consecutive: number[] = [];
    for (let i = 1; i < hist.length; i++) {
      consecutive.push(cosineSimilarity(hist[i - 1].glyph.globalCortex, hist[i].glyph.globalCortex));
    }
    const firstLast = cosineSimilarity(hist[0].glyph.globalCortex, hist[hist.length - 1].glyph.globalCortex);
    return {
      key,
      versions: hist.length,
      consecutiveSimilarities: consecutive,
      firstToLastSimilarity: firstLast,
      driftRate: 1.0 - firstLast,
    };
  }

  // ── Maintenance ───────────────────────────────────────────────────────────

  reinforce(thoughtId: string, amount = 0.1): void {
    const t = this.thoughts.get(thoughtId);
    if (!t) return;
    t.strength = Math.min(3.0, t.strength + amount / (1.0 + 0.1 * t.strength));
    t.lastAccessed = nowSec();
    t.accessCount += 1;
    this.store?.upsert(t);
  }

  decayAll(factor = 0.98, idleThresholdHours = 1.0): number {
    let archived = 0;
    for (const [id, t] of [...this.thoughts]) {
      const idleHours = (nowSec() - t.lastAccessed) / 3600;
      if (idleHours > idleThresholdHours) t.strength = Math.max(0, t.strength * factor);
      if (t.strength < 0.05) {
        this.thoughts.delete(id);
        this.absorbedTexts.delete(t.content.trim().toLowerCase());
        this.store?.delete(id);
        archived++;
      } else {
        this.store?.upsert(t);
      }
    }
    return archived;
  }

  loadWorkingSet(strategy: "recent" | "weak" | "random" = "recent", size = 50): StoredThought[] {
    const arr = [...this.thoughts.values()];
    if (strategy === "recent") arr.sort((a, b) => b.createdAt - a.createdAt);
    else if (strategy === "weak") arr.sort((a, b) => a.strength - b.strength);
    else if (strategy === "random") arr.sort(() => Math.random() - 0.5);
    return arr.slice(0, size);
  }

  allThoughts(): StoredThought[] {
    return [...this.thoughts.values()].sort((a, b) => b.strength - a.strength);
  }

  getThought(id: string): StoredThought | undefined {
    return this.thoughts.get(id);
  }

  stats(): { count: number; avgStrength: number; primitives: unknown } {
    const arr = [...this.thoughts.values()];
    return {
      count: arr.length,
      avgStrength: arr.length ? arr.reduce((s, t) => s + t.strength, 0) / arr.length : 0,
      primitives: { lexicon: true },
    };
  }

  formatRecall(results: RecallResult[], maxResults = 5): string {
    if (!results.length) return "";
    const lines = results.slice(0, maxResults).map((r) => {
      const who = r.thought.speaker === "incoming" ? "the user said" : "adaL said";
      return `[${r.similarity.toFixed(2)}] ${who}: "${r.thought.content}"`;
    });
    return "adaL remembers:\n" + lines.join("\n");
  }
}
