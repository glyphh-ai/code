/**
 * cc-bootstrap — first-run Claude Code login flow.
 *
 * Phase 2 of THE-PIVOT-BYOK. We don't ship our own auth for Claude
 * Code. Instead, on launch we check whether `~/.claude/.credentials.json`
 * (or platform equivalent) exists; if not, we spawn `claude /login`
 * directly (no terminal popup) — the CLI opens the user's browser for
 * OAuth and writes creds when done. The renderer polls for creds
 * appearing and auto-closes the modal.
 *
 * Why direct spawn instead of an osascript-driven Terminal.app: the
 * AppleEvents path needs `com.apple.security.automation.apple-events`
 * in entitlements (we don't have it), gets blocked by hardenedRuntime
 * + notarization in prod, and ignores users on iTerm2/Warp/Ghostty
 * anyway. Direct spawn works on all three platforms identically and
 * needs no special entitlements.
 *
 * Surface:
 *   • bootstrapStatus()  — { found, claudePath } for the renderer
 *   • spawnCcLogin()     — fires `claude /login` headless; the CLI
 *                          handles browser-opening on every platform.
 *                          Returns whether the spawn launched (not
 *                          whether the user actually completed sign-in
 *                          — caller polls bootstrapStatus).
 */

import { spawn } from "child_process";
import { getShellPath } from "./shell-path";
import { findCcCredentials, findClaudeCli, type CcCredsResult } from "./cc-creds";

export interface BootstrapStatus extends CcCredsResult {
  /** Absolute path to `claude` CLI, or null if not installed. */
  claudePath: string | null;
}

export function bootstrapStatus(): BootstrapStatus {
  return { ...findCcCredentials(), claudePath: findClaudeCli() };
}

/**
 * Spawn `claude /login` directly (no terminal). Claude Code opens the
 * default browser for OAuth and writes credentials when the callback
 * fires. Returns true if the spawn launched without error — caller
 * polls bootstrapStatus to know when sign-in actually completed.
 */
export function spawnCcLogin(): { ok: boolean; error?: string } {
  const claudePath = findClaudeCli();
  if (!claudePath) {
    return { ok: false, error: "claude CLI not found on PATH — install Claude Code first" };
  }

  try {
    // Use the user's interactive-shell PATH, not the launch-services
    // PATH that Electron inherits when launched from Finder. Without
    // this, claude can't find git/node/etc. it depends on at runtime.
    const env = { ...process.env, PATH: getShellPath() };
    const child = spawn(claudePath, ["/login"], {
      detached: true,
      stdio: "ignore",
      env,
    });
    child.unref();
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "claude /login spawn failed";
    return { ok: false, error: msg };
  }
}
