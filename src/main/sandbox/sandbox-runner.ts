/**
 * SandboxRunner — OS-native sandbox abstraction for cypher work execution.
 *
 * Backends:
 *   - macOS:   real sandbox via `sandbox-exec` + generated profile (.sb)
 *   - linux:   passthrough today; bwrap impl is a Phase 3.5 swap-in
 *   - windows: passthrough today; AppContainer needs a native addon (Phase 3.5)
 *
 * The interface is intentionally small. Caller passes:
 *   - cwd:           working dir; sandbox restricts fs access to this subtree
 *   - cmd, args:     what to run
 *   - env:           extra env vars (PATH is preserved from process.env)
 *   - allowNetwork:  domains the sandbox may reach (empty = no network);
 *                    enforced on macOS via sandbox-exec's allow rules
 *   - auditPath:     trace destination (sandbox-exec writes here on macOS)
 *
 * Returns the spawned ChildProcess plus an `audit` event emitter that streams
 * sandbox trace lines as they appear (caller decides what to do — typically
 * post them to the cypher feed as `audit` events).
 */

import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { EventEmitter } from "events";
import { generateMacosProfile } from "./sandbox-profile";

export type SandboxBackend = "macos" | "linux" | "windows" | "passthrough";

export function getSandboxBackend(): SandboxBackend {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") return "linux";
  if (process.platform === "win32") return "windows";
  return "passthrough";
}

export interface RunSandboxedOpts {
  cwd: string;
  cmd: string;
  args?: string[];
  env?: Record<string, string>;
  /** Domains the sandbox may reach. Empty = no outbound network. */
  allowNetwork?: string[];
  /** Path to write sandbox trace logs (macOS only). Auto-derived if omitted. */
  auditPath?: string;
}

export interface SandboxHandle {
  child: ChildProcess;
  backend: SandboxBackend;
  /** "audit" event fires with each new trace line (object form, parsed best-effort). */
  audit: EventEmitter;
  /** Resolved when child exits. */
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Best-effort kill the sandboxed process and stop tailing audit. */
  kill: (signal?: NodeJS.Signals) => void;
}

/**
 * Run a command inside the OS-native sandbox. Kernel-level fs/network gating;
 * not a confidentiality wall. See CYPHER-DESIGN.md §3.
 */
export async function runSandboxed(opts: RunSandboxedOpts): Promise<SandboxHandle> {
  const backend = getSandboxBackend();
  const cwdAbs = path.resolve(opts.cwd);
  fs.mkdirSync(cwdAbs, { recursive: true });

  const auditPath = opts.auditPath || path.join(cwdAbs, ".yo-sandbox-audit.log");
  const audit = new EventEmitter();

  let child: ChildProcess;
  if (backend === "macos") {
    child = await spawnMacos(opts, cwdAbs, auditPath);
    tailAuditLog(auditPath, audit);
  } else {
    if (backend !== "passthrough") {
      console.warn(`[sandbox] no native impl for ${backend} yet — running unsandboxed (Phase 3.5)`);
    }
    child = spawn(opts.cmd, opts.args ?? [], {
      cwd: cwdAbs,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  // Forward stdout/stderr as audit events so the cypher feed sees activity even
  // when the kernel-level trace isn't available.
  child.stdout?.on("data", (chunk) => {
    audit.emit("stdout", chunk.toString());
  });
  child.stderr?.on("data", (chunk) => {
    audit.emit("stderr", chunk.toString());
  });

  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => {
      audit.emit("exit", { code, signal });
      resolve({ code, signal });
    });
  });

  return {
    child,
    backend,
    audit,
    done,
    kill: (signal: NodeJS.Signals = "SIGTERM") => {
      try { child.kill(signal); } catch { /* ignore */ }
    },
  };
}

// ── macOS impl ──────────────────────────────────────────────

async function spawnMacos(opts: RunSandboxedOpts, cwdAbs: string, auditPath: string): Promise<ChildProcess> {
  const profileText = generateMacosProfile({
    cwd: cwdAbs,
    allowNetwork: opts.allowNetwork ?? [],
    auditPath,
  });
  const profileFile = path.join(os.tmpdir(), `yo-sandbox-${process.pid}-${Date.now()}.sb`);
  fs.writeFileSync(profileFile, profileText, { mode: 0o600 });

  const args = ["-f", profileFile, opts.cmd, ...(opts.args ?? [])];
  const child = spawn("sandbox-exec", args, {
    cwd: cwdAbs,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Best-effort cleanup of profile file on exit.
  child.on("exit", () => {
    try { fs.unlinkSync(profileFile); } catch { /* ignore */ }
  });

  return child;
}

// ── Audit log tail ──────────────────────────────────────────

function tailAuditLog(file: string, emitter: EventEmitter): void {
  // sandbox-exec writes its trace via `(trace ...)` profile rules. We poll the
  // file (small N, low frequency) and emit each new line as an `audit` event.
  let position = 0;
  const interval = setInterval(() => {
    fs.stat(file, (err, stat) => {
      if (err || stat.size <= position) return;
      const stream = fs.createReadStream(file, { start: position, end: stat.size - 1 });
      let buf = "";
      stream.on("data", (chunk) => { buf += chunk.toString(); });
      stream.on("end", () => {
        position = stat.size;
        for (const line of buf.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          emitter.emit("audit", { raw: trimmed });
        }
      });
    });
  }, 500);
  emitter.on("exit", () => clearInterval(interval));
}
