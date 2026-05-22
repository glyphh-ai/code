/**
 * code-index/chunker — turn a source tree into embeddable chunks.
 *
 * Chunks are fixed line windows with overlap (language-agnostic — no parser).
 * Each chunk's *embed text* is context-enriched with the file path and the
 * nearest enclosing definition signature, so the vector reflects "where" the
 * code lives, not just the raw lines. The *raw text* is what we hand back to
 * the agent.
 */

import fs from "fs";
import path from "path";

export interface Chunk {
  file: string;        // path relative to the index root
  startLine: number;   // 1-based, inclusive
  endLine: number;     // 1-based, inclusive
  text: string;        // raw snippet — returned to the agent
  embedText: string;   // context-enriched — what gets embedded
}

const MAX_CHUNK_LINES = 40;
const OVERLAP_LINES = 8;
const STEP = MAX_CHUNK_LINES - OVERLAP_LINES;

const MAX_FILE_BYTES = 512 * 1024;

// Hard cap on indexed files. The walk + chunk is synchronous and blocks the
// main process, so an unbounded tree (a working dir set to $HOME, or a giant
// monorepo) freezes the app on the boot warm-up. A real project is well under
// this; hitting it means the root is too broad and a partial index is the
// right tradeoff over a multi-second main-thread stall.
const MAX_INDEX_FILES = 4000;

const SOURCE_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java", "kt",
  "c", "h", "cc", "cpp", "hpp", "cs", "rb", "php", "swift", "scala", "sh",
  "css", "scss", "less", "html", "vue", "svelte", "sql", "json", "yaml", "yml",
]);

const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "out", ".git", ".yo", ".next", "coverage",
  "vendor", "target", "__pycache__", ".venv", "venv", ".cache", "tmp",
]);

/** Looks like the start of a definition we can use as context. */
const SIGNATURE_RE =
  /^\s*(export\s+)?(default\s+)?(public\s+|private\s+|protected\s+|static\s+|abstract\s+)*(async\s+)?(function|class|interface|type|enum|struct|def|func|fn|impl|trait|module|namespace|component)\b/;

/** Recursively collect indexable source files under `root`. */
export function walkSourceFiles(root: string): string[] {
  const out: string[] = [];
  let capped = false;
  const visit = (dir: string) => {
    if (capped) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (capped) return;
      if (e.name.startsWith(".") && e.name !== ".") {
        if (e.isDirectory()) continue; // skip dotdirs (.git etc.)
      }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) visit(full);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).slice(1).toLowerCase();
        if (SOURCE_EXTS.has(ext)) {
          out.push(full);
          if (out.length >= MAX_INDEX_FILES) {
            console.warn(`[code-index] file cap (${MAX_INDEX_FILES}) reached under ${root} — root too broad; index will be partial`);
            capped = true;
            return;
          }
        }
      }
    }
  };
  visit(root);
  return out;
}

/** Split one file into context-enriched chunks. Returns [] for unreadable,
 *  binary, oversized, or minified files. */
export function chunkFile(absPath: string, relPath: string): Chunk[] {
  let raw: string;
  try {
    const stat = fs.statSync(absPath);
    if (stat.size > MAX_FILE_BYTES) return [];
    raw = fs.readFileSync(absPath, "utf-8");
  } catch {
    return [];
  }
  if (raw.includes("\0")) return []; // binary

  const lines = raw.split("\n");
  if (lines.length === 0) return [];
  // Skip minified / generated single-blob files.
  const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
  if (longest > 5000) return [];

  const chunks: Chunk[] = [];
  for (let start = 0; start < lines.length; start += STEP) {
    const end = Math.min(start + MAX_CHUNK_LINES, lines.length);
    const slice = lines.slice(start, end);
    if (slice.join("").trim().length === 0) continue; // all whitespace

    // Nearest enclosing definition above this chunk, for context.
    let context = "";
    for (let i = start; i >= 0 && i > start - 400; i--) {
      if (SIGNATURE_RE.test(lines[i] || "")) { context = lines[i].trim(); break; }
    }

    const text = slice.join("\n");
    const embedText =
      `file: ${relPath}\n` +
      (context ? `context: ${context}\n` : "") +
      `\n${text}`;

    chunks.push({
      file: relPath,
      startLine: start + 1,
      endLine: end,
      text,
      embedText,
    });
    if (end >= lines.length) break;
  }
  return chunks;
}
