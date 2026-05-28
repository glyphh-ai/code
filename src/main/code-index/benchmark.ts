/**
 * code-index/benchmark — does code_search save the agent tokens?
 *
 * Builds a BM25 index of this repo, runs a labelled query set, and per query
 * compares
 *   - code_search: tokens in the top-K ranked chunks
 *   - grep+read:   tokens an agent burns running a keyword grep then Reading
 *                  the highest-matching files in full (the usual loop)
 * plus hit@K — does a top-K chunk actually come from the answer file.
 *
 * Run with:  npm run bench:code-index
 * Pure node, no model, no native dependency — runs on any platform.
 */

import fs from "fs";
import { buildCodeIndex } from "./builder";
import { walkSourceFiles } from "./chunker";

const K = 8;

/** ~4 chars/token — the standard rough proxy for the Claude tokenizer. */
const tok = (chars: number) => Math.ceil(chars / 4);

// Each answer file is a path suffix; a query "hits" if a top-K chunk's file
// ends with one of them.
const QUERIES: Array<{ q: string; answerFiles: string[] }> = [
  { q: "where is the prompt-injection firewall applied to untrusted input", answerFiles: ["firewall.ts"] },
  { q: "how is the working directory folder persisted across sessions", answerFiles: ["working-directory.ts"] },
  { q: "where are browser view panel bounds computed with the left inset", answerFiles: ["panel-manager.ts"] },
  { q: "how does the file-open router pick which app opens a file by extension", answerFiles: ["main.ts"] },
  { q: "where does the path gate enforce the trust boundary on tool calls", answerFiles: ["path-gate.ts"] },
  { q: "where is the claude agent SDK cwd set to the working directory", answerFiles: ["yo-agent.ts"] },
  { q: "how are text embeddings produced with the ONNX model", answerFiles: ["embedder-worker.ts"] },
  { q: "where does the panel slide animation move the old view out", answerFiles: ["panel-manager.ts"] },
  { q: "how does run_command restrict shell commands to an allowlist", answerFiles: ["tools.ts"] },
];

/** Model the grep+read loop: a keyword grep, then Read the top matching files
 *  in full. Returns estimated input tokens. */
const READ_LINE_CAP = 2000; // the Read tool's default line cap

function grepReadTokens(query: string, root: string): number {
  const terms = query.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 3);
  const files = new Map<string, { score: number; chars: number; lines: number }>();
  let matchLines = 0;
  for (const abs of walkSourceFiles(root)) {
    let raw: string;
    try {
      if (fs.statSync(abs).size > 512 * 1024) continue;
      raw = fs.readFileSync(abs, "utf-8");
    } catch { continue; }
    if (raw.includes("\0")) continue;
    const lines = raw.split("\n");
    let score = 0;
    for (const line of lines) {
      const l = line.toLowerCase();
      if (terms.some((t) => l.includes(t))) { score++; matchLines++; }
    }
    if (score > 0) files.set(abs, { score, chars: raw.length, lines: lines.length });
  }
  // grep output: matching lines, ~90 chars each (path:line:text), capped.
  const grepOutChars = Math.min(matchLines, 250) * 90;
  // The agent Reads the 3 highest-matching files — each capped at the Read
  // tool's 2000-line default, so the baseline matches real agent behaviour.
  const readChars = [...files.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .reduce((s, f) => s + (f.lines > READ_LINE_CAP ? f.chars * (READ_LINE_CAP / f.lines) : f.chars), 0);
  return tok(grepOutChars) + tok(readChars);
}

function main(): void {
  const root = process.cwd();
  console.log(`[bench] code index of ${root}`);

  const t0 = Date.now();
  const index = buildCodeIndex(root);
  console.log(`[bench] indexed ${index.size} chunks in ${Date.now() - t0}ms\n`);

  console.log(`── per query (top-${K}) ───────────────────────────────────────`);
  let hits = 0;
  let totalSearch = 0;
  let totalGrep = 0;
  for (const { q, answerFiles } of QUERIES) {
    const result = index.search(q, K);
    const rank = result.findIndex((h) => answerFiles.some((a) => h.file.endsWith(a)));
    if (rank >= 0) hits++;
    const searchTok = result.reduce((s, h) => s + tok(h.text.length), 0);
    const grepTok = grepReadTokens(q, root);
    totalSearch += searchTok;
    totalGrep += grepTok;
    console.log(
      `  ${rank >= 0 ? "HIT @" + (rank + 1) : "miss  "}  ` +
      `code_search ${String(searchTok).padStart(5)}t   ` +
      `grep+read ${String(grepTok).padStart(6)}t   ${q}`,
    );
  }

  const n = QUERIES.length;
  const saved = (1 - totalSearch / totalGrep) * 100;
  console.log(`\n── results ───────────────────────────────────────────────────`);
  console.log(`  hit@${K}:           ${hits}/${n}  (${((hits / n) * 100).toFixed(0)}%)`);
  console.log(`  avg code_search:  ${Math.round(totalSearch / n)} tokens`);
  console.log(`  avg grep+read:    ${Math.round(totalGrep / n)} tokens`);
  console.log(`  token savings:    ${saved.toFixed(1)}%`);
  console.log(`  (proxy estimate — confirm with a real agent A/B before relying on it)\n`);
}

main();
