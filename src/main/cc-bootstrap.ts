/**
 * cc-bootstrap — first-run Claude Code login flow.
 *
 * Phase 2 of THE-PIVOT-BYOK. We don't ship our own auth for Claude
 * Code. Instead, on launch we check whether `~/.claude/.credentials.json`
 * (or platform equivalent) exists; if not, we spawn `claude /login`,
 * intercept its OAuth URL from stdout, and open it inside an in-app
 * BrowserWindow (same pattern as the main platform login). Claude's
 * embedded localhost callback server still receives the redirect, so
 * the BrowserWindow never has to know how OAuth works — it just
 * navigates and lets claude do its thing.
 *
 * On claude exit, the BrowserWindow is closed and the renderer's
 * poll loop catches the freshly-written creds.
 *
 * Surface:
 *   • bootstrapStatus()  — { found, claudePath } for the renderer
 *   • spawnCcLogin()     — pipe-spawn claude /login, intercept URL,
 *                          open BrowserWindow. Returns whether the
 *                          spawn launched. Caller polls bootstrapStatus.
 */

import { spawn, ChildProcess } from "child_process";
import { BrowserWindow } from "electron";
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
 * If Claude Code creds are present, return true. Otherwise open the
 * in-app OAuth window via spawnCcLogin() and return false. Use this
 * before any agent-loop launch so users on a fresh machine never see
 * a raw SDK auth error — they see the panel-based sign-in flow instead.
 *
 * Caller should surface a brief "Signing in…" message to the user and
 * either abort the current call (next try will succeed once creds land)
 * or await re-check via bootstrapStatus().
 */
export function ensureCcAuth(): boolean {
  if (bootstrapStatus().found) return true;
  spawnCcLogin();
  return false;
}

let activeOAuthWindow: BrowserWindow | null = null;
let activeChild: ChildProcess | null = null;

function closeOAuthWindow(): void {
  if (activeOAuthWindow && !activeOAuthWindow.isDestroyed()) {
    try { activeOAuthWindow.close(); } catch { /* ignore */ }
  }
  activeOAuthWindow = null;
}

function openOAuthWindow(url: string): void {
  // Reuse an existing window if one's already up (rapid double-clicks).
  if (activeOAuthWindow && !activeOAuthWindow.isDestroyed()) {
    activeOAuthWindow.loadURL(url);
    activeOAuthWindow.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 600,
    height: 800,
    title: "Sign in to Claude Code",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: "persist:cc-oauth", // isolated cookie jar from the main app
    },
  });
  win.loadURL(url);
  win.on("closed", () => {
    activeOAuthWindow = null;
    // If the user closed the OAuth window before claude finished,
    // kill the child so we don't leak processes.
    if (activeChild && activeChild.exitCode === null) {
      try { activeChild.kill(); } catch { /* ignore */ }
      activeChild = null;
    }
  });
  activeOAuthWindow = win;
}

/**
 * Spawn `claude /login` and host the OAuth flow in-app.
 *
 * Pipes claude's stdout/stderr, watches for an OAuth URL (matches
 * claude.ai/anthropic.com hosts), and loads it in a BrowserWindow.
 * If claude doesn't print a URL within ~6s we let the spawn run on
 * its own — claude itself falls back to opening the system browser
 * via xdg-open/open/start, so the user still gets a working flow.
 */
export function spawnCcLogin(): { ok: boolean; error?: string } {
  const claudePath = findClaudeCli();
  if (!claudePath) {
    return { ok: false, error: "claude CLI not found on PATH — install Claude Code first" };
  }

  // Don't double-spawn. If a login is already in flight, just refocus
  // the existing OAuth window.
  if (activeChild && activeChild.exitCode === null) {
    if (activeOAuthWindow && !activeOAuthWindow.isDestroyed()) {
      activeOAuthWindow.focus();
    }
    return { ok: true };
  }

  try {
    const env = { ...process.env, PATH: getShellPath() };
    const child = spawn(claudePath, ["/login"], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });

    let urlOpened = false;
    const tryOpen = (chunk: Buffer): void => {
      if (urlOpened) return;
      const text = chunk.toString();
      const match = text.match(/https:\/\/[^\s]+/);
      if (!match) return;
      const url = match[0].replace(/[)\].,;]+$/, ""); // strip trailing punctuation
      if (!/claude\.ai|anthropic\.com/.test(url)) return;
      urlOpened = true;
      openOAuthWindow(url);
    };

    child.stdout?.on("data", tryOpen);
    child.stderr?.on("data", tryOpen);

    child.on("exit", () => {
      closeOAuthWindow();
      activeChild = null;
    });
    child.on("error", () => {
      activeChild = null;
    });

    activeChild = child;
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "claude /login spawn failed";
    return { ok: false, error: msg };
  }
}
