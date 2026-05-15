/**
 * path-gate — enforce the .yo trust boundary on tool invocations.
 *
 * The cypher's local execution model rests on a simple invariant: nothing
 * outside the user's `.yo/` directory should be readable or writable by an
 * agent. When a jammer is running in cypher mode, the boundary tightens
 * further to that jammer's per-cypher sandbox.
 *
 * This module resolves any filesystem-style argument (`path`, `file`, `cwd`,
 * `pattern`, etc.) of a tool call and rejects the call if any resolved
 * absolute path escapes the active boundary. It returns an error string
 * instead of executing the tool.
 *
 * Two thresholds:
 *   - solo mode  → boundary is `~/.yo/`
 *   - cypher mode → boundary is `~/.yo/cyphers/<id>/jammers/<jammer>/`
 *
 * Cross-platform via `os.homedir()` and `path.resolve`. Works on macOS,
 * Linux, and Windows.
 */

import os from "os";
import path from "path";
import fs from "fs";

const HOME = os.homedir();
const YO_ROOT = path.join(HOME, ".yo");

/**
 * Resolve an absolute path through any symlinks. The target may not exist yet
 * (e.g. a Write creating a new file), so we realpath the longest *existing*
 * ancestor and re-append the non-existent tail. This is what defeats
 * symlink-traversal escapes — `path.normalize` alone follows the textual path
 * and would happily accept `<sandbox>/link/passwd` where `link → /etc`.
 */
function realResolve(abs: string): string {
  let cur = path.normalize(abs);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.normalize(abs); // hit root — nothing resolved
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

// Common keys used by tool calls that carry filesystem paths.
// We check every value at these keys; missing / non-string keys are skipped.
const PATH_KEYS = [
  "path", "file", "filepath", "file_path", "filename", "cwd",
  "pattern", "glob", "input_path", "output_path", "src", "dst",
];

export interface PathGateOptions {
  /** When set, narrows the boundary further to this absolute path. */
  cypherSandbox?: string;
}

/** Check a single resolved absolute path. Returns null if OK, error string otherwise. */
function checkAbs(abs: string, boundary: string): string | null {
  const root = boundary.endsWith(path.sep) ? boundary : boundary + path.sep;
  if (abs === boundary) return null;
  if (abs.startsWith(root)) return null;
  return `path-gate: ${abs} is outside ${boundary}`;
}

/**
 * Inspect a tool call's input. If any path-shaped value resolves outside the
 * active boundary, return a violation message. Otherwise return null.
 *
 * Resolves relative paths against the cypher sandbox (if active) or against
 * the current process cwd. The boundary is always either the sandbox or
 * `~/.yo/`.
 */
export function checkToolCall(input: Record<string, unknown>, opts: PathGateOptions = {}): string | null {
  // Resolve the boundary itself through symlinks so a symlinked sandbox/HOME
  // doesn't make every legitimate path look "outside".
  const boundary = realResolve(opts.cypherSandbox ?? YO_ROOT);
  const baseDir = opts.cypherSandbox ?? process.cwd();

  for (const key of PATH_KEYS) {
    const v = input[key];
    if (typeof v !== "string" || v.length === 0) continue;
    const abs = path.isAbsolute(v) ? v : path.resolve(baseDir, v);
    const err = checkAbs(realResolve(abs), boundary);
    if (err) return err;
  }

  // Heuristic check for `command`/`cmd` strings (e.g. Bash). Shell strings
  // can't be fully parsed, so this stays conservative but catches the common
  // escapes: absolute/`~` path tokens AND `cd` into an absolute/`~` dir.
  const cmd = (input.command ?? input.cmd) as unknown;
  if (typeof cmd === "string") {
    const tokens = cmd.match(/(?:~\/|\/)[^\s'"]+/g) ?? [];
    const cdTargets = [...cmd.matchAll(/\bcd\s+(['"]?)((?:~|\/)[^\s'"]*)\1/g)].map((m) => m[2]);
    for (const t of [...tokens, ...cdTargets]) {
      const abs = t.startsWith("~") ? path.join(HOME, t.slice(1)) : path.normalize(t);
      const err = checkAbs(realResolve(abs), boundary);
      if (err) return `${err} (in command "${cmd.slice(0, 80)}")`;
    }
  }

  return null;
}

/** Convenience: get the .yo root for code that needs to know the trust boundary. */
export function yoRoot(): string {
  return YO_ROOT;
}
