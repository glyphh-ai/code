/**
 * code-index/bm25 — lexical relevance ranking over code chunks.
 *
 * BM25 is the classic term-frequency / inverse-document-frequency ranker.
 * Over code it is genuinely strong: queries and code share vocabulary, and
 * scoring at the *chunk* level (not whole files) is where the token savings
 * come from. Zero dependencies — runs on every platform, instantly.
 */

import type { Chunk } from "./chunker";

export interface SearchHit {
  file: string;
  startLine: number;
  endLine: number;
  text: string;
  score: number;
}

const K1 = 1.2;
const B = 0.75;

/**
 * Tokenise code: split on non-alphanumerics, break camelCase, lowercase, and
 * keep both the parts and the joined whole (so `workingDirectory` matches a
 * query of "working directory" and "workingdirectory").
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[^A-Za-z0-9]+/)) {
    if (!raw) continue;
    const parts = raw.split(/(?<=[a-z0-9])(?=[A-Z])/);
    for (const p of parts) {
      const t = p.toLowerCase();
      if (t.length >= 2 && t.length <= 40) out.push(t);
    }
    if (parts.length > 1) {
      const whole = raw.toLowerCase();
      if (whole.length <= 40) out.push(whole);
    }
  }
  return out;
}

interface Doc {
  chunk: Chunk;
  tf: Map<string, number>;
  len: number;
}

export class Bm25Index {
  readonly root: string;
  private docs: Doc[] = [];
  private df = new Map<string, number>();
  private avgdl = 1;

  private constructor(root: string) {
    this.root = root;
  }

  get size(): number { return this.docs.length; }

  /** Build an index from chunks. The file path + enclosing signature ride
   *  along in `embedText`, so a query matches a chunk by *where* it lives too. */
  static build(root: string, chunks: Chunk[]): Bm25Index {
    const index = new Bm25Index(root);
    let totalLen = 0;
    for (const chunk of chunks) {
      const tokens = tokenize(chunk.embedText);
      if (tokens.length === 0) continue;
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
      for (const t of tf.keys()) index.df.set(t, (index.df.get(t) || 0) + 1);
      index.docs.push({ chunk, tf, len: tokens.length });
      totalLen += tokens.length;
    }
    index.avgdl = index.docs.length ? totalLen / index.docs.length : 1;
    return index;
  }

  /** BM25 top-k. */
  search(query: string, k: number): SearchHit[] {
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0 || this.docs.length === 0) return [];
    const N = this.docs.length;

    const idf = new Map<string, number>();
    for (const t of terms) {
      const n = this.df.get(t) || 0;
      idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
    }

    const scored: SearchHit[] = [];
    for (const doc of this.docs) {
      let score = 0;
      for (const t of terms) {
        const f = doc.tf.get(t);
        if (!f) continue;
        const denom = f + K1 * (1 - B + B * (doc.len / this.avgdl));
        score += idf.get(t)! * ((f * (K1 + 1)) / denom);
      }
      if (score > 0) {
        scored.push({
          file: doc.chunk.file,
          startLine: doc.chunk.startLine,
          endLine: doc.chunk.endLine,
          text: doc.chunk.text,
          score,
        });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }
}
