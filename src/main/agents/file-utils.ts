/**
 * Shared file utilities for agent tools.
 *
 * Used by ResearcherAgent, CodingAgent, and SkillRunnerAgent
 * to avoid duplicating file read/search/list logic.
 */

import fs from "fs";
import path from "path";
import os from "os";

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", "__pycache__",
  ".venv", "venv", "Library", ".Trash", "Pictures", "Movies", "Music",
]);

const TEXT_EXTS = new Set([
  ".txt", ".md", ".ts", ".tsx", ".js", ".jsx", ".py", ".json",
  ".yaml", ".yml", ".toml", ".cfg", ".ini", ".sh", ".zsh",
  ".html", ".css", ".scss", ".sql", ".rs", ".go", ".java",
  ".rb", ".php", ".swift", ".kt", ".c", ".cpp", ".h",
  ".svelte", ".vue", ".astro", ".env", ".lock", ".xml",
]);

/** Resolve ~ and normalize path. */
export function resolvePath(p: string): string {
  return path.resolve(p.replace(/^~/, os.homedir()));
}

// ── Read file ───────────────────────────────────────────────

export interface ReadFileOpts {
  maxLines?: number;   // default 500
  offset?: number;     // line offset (0-based), default 0
}

export function readFileContents(filePath: string, opts: ReadFileOpts = {}): string {
  filePath = resolvePath(filePath);
  if (!fs.existsSync(filePath)) return `File not found: ${filePath}`;

  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) return `${filePath} is a directory, not a file. Use list_files instead.`;
    if (stat.size > 2_000_000) return `File too large (${Math.round(stat.size / 1024)}KB). Try search_files instead.`;

    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const maxLines = opts.maxLines ?? 500;
    const offset = opts.offset ?? 0;

    if (offset >= lines.length) return `Offset ${offset} exceeds file length (${lines.length} lines).`;

    const slice = lines.slice(offset, offset + maxLines);
    const end = Math.min(offset + maxLines, lines.length);

    if (end < lines.length) {
      return slice.join("\n") + `\n\n[lines ${offset + 1}-${end} of ${lines.length}. Use offset=${end} to read more]`;
    }
    if (offset > 0) {
      return slice.join("\n") + `\n\n[lines ${offset + 1}-${lines.length} of ${lines.length}]`;
    }
    return content;
  } catch (err) {
    return `Error reading file: ${err instanceof Error ? err.message : err}`;
  }
}

// ── Search files ────────────────────────────────────────────

export interface SearchFilesOpts {
  directory?: string;
  filePattern?: string;
  maxResults?: number;   // default 30
  timeout?: number;      // ms, default 15000
  maxDepth?: number;     // default: 3 for home, 6 otherwise
}

export function searchFileContents(pattern: string, opts: SearchFilesOpts = {}): string {
  let dir = resolvePath(opts.directory || "~");
  if (!fs.existsSync(dir)) return `Directory not found: ${dir}`;

  const results: string[] = [];
  const maxResults = opts.maxResults ?? 30;
  const isHome = dir === os.homedir();
  const maxDepth = opts.maxDepth ?? (isHome ? 3 : 6);
  const deadline = Date.now() + (opts.timeout ?? 15000);
  const filePattern = opts.filePattern || "";

  const search = (d: string, depth: number) => {
    if (depth > maxDepth || results.length >= maxResults || Date.now() > deadline) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (results.length >= maxResults || Date.now() > deadline) break;
      const full = path.join(d, entry.name);

      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name)) {
          search(full, depth + 1);
        }
        continue;
      }

      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!TEXT_EXTS.has(ext)) continue;
      if (filePattern && !entry.name.match(new RegExp(filePattern.replace(/\*/g, ".*")))) continue;

      try {
        const content = fs.readFileSync(full, "utf-8").slice(0, 100000);
        const lines = content.split("\n");
        const regex = new RegExp(pattern, "gi");
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            const preview = lines.slice(Math.max(0, i - 1), i + 3).join("\n");
            results.push(`[${full}:${i + 1}]\n${preview}`);
            if (results.length >= maxResults) break;
          }
          regex.lastIndex = 0;
        }
      } catch { /* skip unreadable */ }
    }
  };

  search(dir, 0);
  if (results.length === 0) return `No files matching "${pattern}" found in ${dir}`;
  return results.join("\n\n");
}

// ── List files ──────────────────────────────────────────────

export interface ListFilesOpts {
  pattern?: string;
  recursive?: boolean;
  maxResults?: number;   // default 100
  maxDepth?: number;     // default: 0 non-recursive, 5 recursive
}

export function listFilesAt(dirPath: string, opts: ListFilesOpts = {}): string {
  const dir = resolvePath(dirPath || "~");
  if (!fs.existsSync(dir)) return `Directory not found: ${dir}`;

  const results: string[] = [];
  const maxResults = opts.maxResults ?? 100;
  const maxDepth = opts.maxDepth ?? (opts.recursive ? 5 : 0);
  const deadline = Date.now() + 10000;
  const pattern = opts.pattern;

  const list = (d: string, depth: number) => {
    if (depth > maxDepth || results.length >= maxResults || Date.now() > deadline) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (results.length >= maxResults) break;
      if (entry.name.startsWith(".")) continue;

      const full = path.join(d, entry.name);
      const relative = path.relative(dir, full);
      const isDir = entry.isDirectory();

      if (pattern && !entry.name.match(new RegExp(pattern.replace(/\*/g, ".*")))) {
        if (isDir && opts.recursive && !SKIP_DIRS.has(entry.name)) list(full, depth + 1);
        continue;
      }

      results.push(`${isDir ? "[dir] " : ""}${relative}`);
      if (isDir && opts.recursive && !SKIP_DIRS.has(entry.name)) list(full, depth + 1);
    }
  };

  list(dir, 0);
  if (results.length === 0) return `No files found in ${dir}`;
  return results.join("\n");
}

// ── Write file ──────────────────────────────────────────────

export interface WriteFileOpts {
  createDirs?: boolean;  // default true
}

export function writeFileContents(filePath: string, content: string, opts: WriteFileOpts = {}): string {
  filePath = resolvePath(filePath);

  if (content.length > 1_000_000) return "Content too large (max 1MB).";

  // Block dotfiles/sensitive paths
  const segments = filePath.split(path.sep);
  const sensitive = [".ssh", ".gnupg", ".aws", ".env"];
  for (const seg of segments) {
    if (sensitive.includes(seg)) return `Blocked: cannot write to ${seg} directory.`;
  }

  try {
    const dir = path.dirname(filePath);
    if (opts.createDirs !== false) {
      fs.mkdirSync(dir, { recursive: true });
    } else if (!fs.existsSync(dir)) {
      return `Directory not found: ${dir}`;
    }

    const existed = fs.existsSync(filePath);
    fs.writeFileSync(filePath, content, "utf-8");
    return existed
      ? `Updated ${filePath} (${content.length} chars)`
      : `Created ${filePath} (${content.length} chars)`;
  } catch (err) {
    return `Error writing file: ${err instanceof Error ? err.message : err}`;
  }
}

// ── Edit file (find & replace) ──────────────────────────────

export function editFileContents(filePath: string, search: string, replace: string, all = false): string {
  filePath = resolvePath(filePath);
  if (!fs.existsSync(filePath)) return `File not found: ${filePath}`;

  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 5_000_000) return "File too large to edit (max 5MB).";

    const content = fs.readFileSync(filePath, "utf-8");
    if (!content.includes(search)) return `Search text not found in ${filePath}`;

    const updated = all
      ? content.split(search).join(replace)
      : content.replace(search, replace);

    fs.writeFileSync(filePath, updated, "utf-8");
    const count = all ? content.split(search).length - 1 : 1;
    return `Edited ${filePath}: ${count} replacement(s) made.`;
  } catch (err) {
    return `Error editing file: ${err instanceof Error ? err.message : err}`;
  }
}

// ── Move / Copy / Delete ────────────────────────────────────

export function moveFile(source: string, destination: string): string {
  source = resolvePath(source);
  destination = resolvePath(destination);

  if (!fs.existsSync(source)) return `Source not found: ${source}`;

  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(source, destination);
    return `Moved ${source} → ${destination}`;
  } catch (err) {
    return `Error moving file: ${err instanceof Error ? err.message : err}`;
  }
}

export function copyFile(source: string, destination: string): string {
  source = resolvePath(source);
  destination = resolvePath(destination);

  if (!fs.existsSync(source)) return `Source not found: ${source}`;

  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    return `Copied ${source} → ${destination}`;
  } catch (err) {
    return `Error copying file: ${err instanceof Error ? err.message : err}`;
  }
}

export function deleteFile(filePath: string): string {
  filePath = resolvePath(filePath);
  if (!fs.existsSync(filePath)) return `Not found: ${filePath}`;

  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(filePath);
      if (entries.length > 0) return `Directory not empty: ${filePath}. Remove contents first.`;
      fs.rmdirSync(filePath);
      return `Deleted directory: ${filePath}`;
    }
    fs.unlinkSync(filePath);
    return `Deleted: ${filePath}`;
  } catch (err) {
    return `Error deleting: ${err instanceof Error ? err.message : err}`;
  }
}

export function createDirectory(dirPath: string, recursive = true): string {
  dirPath = resolvePath(dirPath);

  try {
    if (fs.existsSync(dirPath)) return `Directory already exists: ${dirPath}`;
    fs.mkdirSync(dirPath, { recursive });
    return `Created directory: ${dirPath}`;
  } catch (err) {
    return `Error creating directory: ${err instanceof Error ? err.message : err}`;
  }
}
