/**
 * code-index/builder — build the lexical code index for a directory.
 *
 * Walk the source tree, chunk every file, build a BM25 index. No model, no
 * native dependency — fast enough (sub-second to a few seconds for a repo)
 * that there is nothing to persist or do incrementally.
 */

import path from "path";
import { walkSourceFiles, chunkFile, type Chunk } from "./chunker";
import { Bm25Index } from "./bm25";

export function buildCodeIndex(root: string): Bm25Index {
  const chunks: Chunk[] = [];
  for (const abs of walkSourceFiles(root)) {
    chunks.push(...chunkFile(abs, path.relative(root, abs)));
  }
  return Bm25Index.build(root, chunks);
}
