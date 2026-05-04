/**
 * work-package-runner — executes a cypher's setup steps inside a jammer sandbox.
 *
 * Steps come from the cypher's manifest (cypher.json). Each step is a small
 * declarative kind (git_clone, r2_download, unzip, git_branch, read). The runner
 * resolves all paths against the jammer's sandbox cwd and refuses anything that
 * escapes it.
 *
 * Cross-platform via Node fs/path + system git + adm-zip. No shell, no string
 * concatenation of paths — ever path is normalized through path.resolve and
 * compared against the sandbox root.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import AdmZip from "adm-zip";
import { net } from "electron";
import { AUTH_SERVER, getAuthToken } from "./auth";

const execFileAsync = promisify(execFile);

// ── Types ───────────────────────────────────────────────────

export type SetupStep =
  | { kind: "git_clone"; url: string; branch?: string; into?: string }
  | { kind: "git_branch"; name: string }
  | { kind: "r2_download"; key: string; into: string }
  | { kind: "unzip"; archive: string; into?: string }
  | { kind: "read"; path: string; into_prompt?: boolean };

export interface SetupStepLog {
  step: SetupStep;
  ok: boolean;
  duration_ms: number;
  message: string;
  /** For `read` steps with `into_prompt`, the file contents joined into the
   *  agent's first turn. Empty for other kinds. */
  prompt_addition?: string;
}

export interface RunResult {
  ok: boolean;
  logs: SetupStepLog[];
  /** Concatenated `read` outputs ready to prepend to the agent's startPrompt. */
  prompt_addition: string;
}

// ── Path gate ───────────────────────────────────────────────

/**
 * Resolve `rel` against `sandbox` and refuse if the result escapes the sandbox
 * root. Returns the absolute path on success, throws otherwise.
 *
 * Handles ".." traversal, absolute paths in the input, and symlink-style
 * surface-level attacks. Symlink-content traversal is a v2 concern (would
 * need `fs.realpath` after creation).
 */
function safeResolve(sandbox: string, rel: string | undefined, what: string): string {
  const sandboxAbs = path.resolve(sandbox);
  const target = rel ? path.resolve(sandboxAbs, rel) : sandboxAbs;
  // Normalize trailing slashes for the prefix check
  const root = sandboxAbs.endsWith(path.sep) ? sandboxAbs : sandboxAbs + path.sep;
  if (target !== sandboxAbs && !target.startsWith(root)) {
    throw new Error(`path-gate: ${what} resolves outside sandbox (${target} not in ${sandboxAbs})`);
  }
  return target;
}

// ── Step executors ─────────────────────────────────────────

async function runGitClone(step: SetupStep & { kind: "git_clone" }, sandbox: string): Promise<string> {
  const into = safeResolve(sandbox, step.into ?? ".", "git_clone.into");
  fs.mkdirSync(into, { recursive: true });
  const args = ["clone"];
  if (step.branch) args.push("--branch", step.branch);
  args.push("--depth", "1", step.url, into);
  await execFileAsync("git", args, { cwd: sandbox });
  return `Cloned ${step.url}${step.branch ? ` (${step.branch})` : ""} → ${path.relative(sandbox, into) || "."}`;
}

async function runGitBranch(step: SetupStep & { kind: "git_branch" }, sandbox: string): Promise<string> {
  // Find the first git checkout under the sandbox to operate on. v1: assumes
  // a single repo at the sandbox root or one of its top-level subdirs.
  const candidates = [sandbox, ...fs.readdirSync(sandbox)
    .map((d) => path.join(sandbox, d))
    .filter((p) => fs.statSync(p).isDirectory())];
  let cwd: string | null = null;
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, ".git"))) { cwd = c; break; }
  }
  if (!cwd) throw new Error("git_branch: no git repo found under sandbox");
  await execFileAsync("git", ["checkout", "-b", step.name], { cwd });
  return `Created branch ${step.name} in ${path.relative(sandbox, cwd) || "."}`;
}

async function runR2Download(step: SetupStep & { kind: "r2_download" }, sandbox: string): Promise<string> {
  const into = safeResolve(sandbox, step.into, "r2_download.into");
  fs.mkdirSync(path.dirname(into), { recursive: true });
  // R2 access goes through yo-server's blob endpoint so we don't need direct R2 creds
  // on the client. The key is server-namespaced (e.g. cypher-<id>/...).
  const url = `${AUTH_SERVER || "https://api.yosup.dev"}/api/blob/${encodeURIComponent(step.key)}`;
  const token = getAuthToken();
  if (!token) throw new Error("r2_download: not authenticated");

  await new Promise<void>((resolve, reject) => {
    const req = net.request({ url, method: "GET" });
    req.setHeader("Authorization", `Bearer ${token}`);
    const ws = fs.createWriteStream(into);
    req.on("response", (resp) => {
      if (resp.statusCode && resp.statusCode >= 400) {
        reject(new Error(`r2_download: HTTP ${resp.statusCode}`));
        ws.close();
        return;
      }
      resp.on("data", (chunk) => ws.write(chunk));
      resp.on("end", () => { ws.end(); resolve(); });
      resp.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });

  return `Downloaded ${step.key} → ${path.relative(sandbox, into)}`;
}

async function runUnzip(step: SetupStep & { kind: "unzip" }, sandbox: string): Promise<string> {
  const archive = safeResolve(sandbox, step.archive, "unzip.archive");
  const into = safeResolve(sandbox, step.into ?? ".", "unzip.into");
  if (!fs.existsSync(archive)) throw new Error(`unzip: archive not found at ${path.relative(sandbox, archive)}`);
  fs.mkdirSync(into, { recursive: true });
  const zip = new AdmZip(archive);
  // Validate every entry stays inside `into` before extracting (zip-slip defense).
  const intoRoot = into.endsWith(path.sep) ? into : into + path.sep;
  for (const e of zip.getEntries()) {
    const target = path.resolve(into, e.entryName);
    if (target !== into && !target.startsWith(intoRoot)) {
      throw new Error(`unzip: entry ${e.entryName} escapes target dir`);
    }
  }
  zip.extractAllTo(into, /* overwrite */ true);
  return `Unzipped ${path.relative(sandbox, archive)} → ${path.relative(sandbox, into) || "."}`;
}

async function runRead(step: SetupStep & { kind: "read" }, sandbox: string): Promise<{ message: string; prompt_addition: string }> {
  const target = safeResolve(sandbox, step.path, "read.path");
  if (!fs.existsSync(target)) throw new Error(`read: not found at ${path.relative(sandbox, target)}`);
  const content = fs.readFileSync(target, "utf-8");
  const promptAddition = step.into_prompt
    ? `\n\n--- ${path.relative(sandbox, target)} ---\n${content}\n`
    : "";
  return {
    message: `Read ${path.relative(sandbox, target)} (${content.length} chars)${step.into_prompt ? " → prompt" : ""}`,
    prompt_addition: promptAddition,
  };
}

// ── Public API ──────────────────────────────────────────────

/**
 * Execute setup steps in order against `sandbox`. Stops on first failure and
 * returns a result with logs. Idempotent on re-run only insofar as each step
 * type is — git_clone of an existing dir will fail, etc. Caller decides whether
 * to wipe the sandbox before re-running.
 */
export async function runWorkPackage(
  steps: SetupStep[],
  sandbox: string,
): Promise<RunResult> {
  const sandboxAbs = path.resolve(sandbox);
  fs.mkdirSync(sandboxAbs, { recursive: true });

  const logs: SetupStepLog[] = [];
  let promptAddition = "";

  for (const step of steps) {
    const t0 = Date.now();
    try {
      let message = "";
      let extraPrompt = "";
      switch (step.kind) {
        case "git_clone":   message = await runGitClone(step, sandboxAbs); break;
        case "git_branch":  message = await runGitBranch(step, sandboxAbs); break;
        case "r2_download": message = await runR2Download(step, sandboxAbs); break;
        case "unzip":       message = await runUnzip(step, sandboxAbs); break;
        case "read": {
          const r = await runRead(step, sandboxAbs);
          message = r.message;
          extraPrompt = r.prompt_addition;
          break;
        }
      }
      logs.push({ step, ok: true, duration_ms: Date.now() - t0, message, prompt_addition: extraPrompt || undefined });
      if (extraPrompt) promptAddition += extraPrompt;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logs.push({ step, ok: false, duration_ms: Date.now() - t0, message });
      return { ok: false, logs, prompt_addition: promptAddition };
    }
  }

  return { ok: true, logs, prompt_addition: promptAddition };
}

/** Default sandbox for a (cypher, jammer) pair. */
export function jammerSandboxPath(cypherId: string, agentLocalId: string): string {
  return path.join(os.homedir(), ".yo", "cyphers", cypherId, "jammers", agentLocalId);
}
