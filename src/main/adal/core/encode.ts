/**
 * adaL bag-of-words encoding — the strongest recall signal in the substrate.
 *
 * Port of the tokenizer + content-vector path from ada/memory/thought_glyph.py.
 * Strips articles/copulas, expands contractions (so structural keywords like
 * "not" survive), then bundles a deterministic symbol per content word.
 */

import { generateSymbol, bundle, type Bipolar } from "./ops";

export const DEFAULT_DIM = 2000;
export const DEFAULT_SEED = 42;

// Articles / copulas / common prepositions: grammatical structure, no content
// signal for HDC cosine. Keep short — only words whose presence shouldn't
// change a recall ranking.
const FILLER = new Set<string>([
  "a", "an", "the",
  "is", "are", "was", "were", "be", "been", "being",
  "of", "to", "in", "on", "at", "by", "for", "with", "from", "as",
  "this", "that", "these", "those", "it", "its",
]);

// Contractions hide primitive keywords: "don't" = "do" + "not". Expand them so
// both structural signals fire.
const CONTRACTIONS: Record<string, string[]> = {
  "don't": ["do", "not"], "doesn't": ["does", "not"], "didn't": ["did", "not"],
  "can't": ["can", "not"], "won't": ["will", "not"], "couldn't": ["could", "not"],
  "shouldn't": ["should", "not"], "wouldn't": ["would", "not"], "isn't": ["is", "not"],
  "aren't": ["are", "not"], "wasn't": ["was", "not"], "weren't": ["were", "not"],
  "haven't": ["have", "not"], "hasn't": ["has", "not"], "hadn't": ["had", "not"],
  "i'm": ["i", "am"], "i've": ["i", "have"], "i'll": ["i", "will"], "i'd": ["i", "would"],
  "you're": ["you", "are"], "you've": ["you", "have"], "you'll": ["you", "will"],
  "he's": ["he", "is"], "she's": ["she", "is"], "it's": ["it", "is"],
  "we're": ["we", "are"], "we've": ["we", "have"], "we'll": ["we", "will"],
  "they're": ["they", "are"], "they've": ["they", "have"], "they'll": ["they", "will"],
  "that's": ["that", "is"], "there's": ["there", "is"], "what's": ["what", "is"],
  "who's": ["who", "is"], "where's": ["where", "is"], "let's": ["let", "us"],
};

/** Lowercase, strip punctuation + filler, expand contractions. */
export function tokenize(text: string): string[] {
  const words: string[] = [];
  for (const raw of text.toLowerCase().split(/\s+/)) {
    const w = raw.replace(/^[?.,!;:'"()\-]+|[?.,!;:'"()\-]+$/g, "");
    if (!w || FILLER.has(w)) continue;
    const expanded = CONTRACTIONS[w];
    if (expanded) words.push(...expanded);
    else words.push(w);
  }
  return words;
}

/**
 * Encode text into a bipolar content vector: bundle of one deterministic
 * symbol per content word. Empty input falls back to the raw lowercased string.
 */
export function bagOfWords(text: string, seed = DEFAULT_SEED, dim = DEFAULT_DIM): Bipolar {
  let toks = tokenize(text);
  if (toks.length === 0) {
    const fallback = text.toLowerCase().trim();
    toks = fallback ? [fallback] : ["∅"];
  }
  const vecs = toks.map((w) => generateSymbol(seed, w, dim));
  return bundle(vecs);
}
