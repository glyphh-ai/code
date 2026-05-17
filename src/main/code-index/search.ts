/**
 * code-index/search — query the lexical code index.
 *
 * The index for the current working directory is cached in-process; it is
 * (re)built lazily on first query and refreshed by the IPC layer. Building is
 * cheap, so a stale-ish cache is fine and a missing one self-heals.
 */

import { buildCodeIndex } from "./builder";
import { Bm25Index, type SearchHit } from "./bm25";

let current: Bm25Index | null = null;

/** Replace the cached index (used by the IPC background (re)build). */
export function setCurrentIndex(idx: Bm25Index | null): void { current = idx; }
export function getCurrentIndex(): Bm25Index | null { return current; }

export interface CodeSearchResult {
  hits: SearchHit[];
  mode: "lexical";
}

/** Search the code index for `root`. Builds the index on demand. */
export function searchCode(query: string, root: string, k = 8): CodeSearchResult {
  if (!current || current.root !== root) {
    current = buildCodeIndex(root);
  }
  return { hits: current.search(query, k), mode: "lexical" };
}
