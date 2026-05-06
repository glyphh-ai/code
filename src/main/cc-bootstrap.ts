/**
 * cc-bootstrap — first-run Claude Code login flow.
 *
 * Phase 2 of THE-PIVOT-BYOK. We don't ship our own auth for Claude
 * Code. Instead, on launch we check whether `~/.claude/.credentials.json`
 * (or platform equivalent) exists; if not, we offer to spawn the user's
 * default terminal running `claude /login` so they can complete the
 * existing CC OAuth flow.
 *
 * This module's surface is two things:
 *   • bootstrapStatus()   — { found, claudePath } for the renderer
 *   • spawnCcLogin()      — opens a terminal subprocess running `claude /login`.
 *                            Cross-platform best effort; returns whether the
 *                            spawn appeared to succeed.
 *
 * The renderer polls bootstrapStatus() periodically after spawnCcLogin()
 * to detect when the user finishes auth in the terminal.
 */

import { spawn } from "child_process";
import { findCcCredentials, findClaudeCli, type CcCredsResult } from "./cc-creds";

export interface BootstrapStatus extends CcCredsResult {
  /** Absolute path to `claude` CLI, or null if not installed. */
  claudePath: string | null;
}

export function bootstrapStatus(): BootstrapStatus {
  return { ...findCcCredentials(), claudePath: findClaudeCli() };
}

/**
 * Spawn the user's default terminal running `claude /login`.
 * Returns true if the spawn launched without error (not whether the
 * user actually completed login — caller should poll bootstrapStatus).
 */
export function spawnCcLogin(): { ok: boolean; error?: string } {
  const claudePath = findClaudeCli();
  if (!claudePath) {
    return { ok: false, error: "claude CLI not found on PATH — install Claude Code first" };
  }

  try {
    if (process.platform === "darwin") {
      // Tell Terminal.app to open a new window running the command.
      // shell-quote `claudePath` defensively; spaces in install paths happen.
      const safePath = claudePath.replace(/(["\\])/g, "\\$1");
      const script = `tell application "Terminal" to do script "${safePath} /login"\nactivate application "Terminal"`;
      const child = spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" });
      child.unref();
      return { ok: true };
    }
    if (process.platform === "win32") {
      // `start` opens cmd, `/k` keeps it open after the command finishes
      // so the user can see any error output.
      const child = spawn("cmd", ["/c", "start", "cmd", "/k", `"${claudePath} /login"`], {
        detached: true, stdio: "ignore", shell: false,
      });
      child.unref();
      return { ok: true };
    }
    // Linux / other Unix — try common terminal emulators.
    const candidates = [
      ["x-terminal-emulator", ["-e", `${claudePath} /login`]],
      ["gnome-terminal", ["--", "sh", "-c", `${claudePath} /login; exec sh`]],
      ["konsole", ["-e", `${claudePath} /login`]],
      ["xterm", ["-e", `${claudePath} /login`]],
    ] as Array<[string, string[]]>;
    for (const [cmd, args] of candidates) {
      try {
        const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
        child.unref();
        return { ok: true };
      } catch {
        continue;
      }
    }
    return { ok: false, error: "no supported terminal emulator found — run `claude /login` manually in any terminal" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "terminal spawn failed" };
  }
}
