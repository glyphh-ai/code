/**
 * cc-bootstrap — first-run Claude Code login flow.
 *
 * Phase 2 of THE-PIVOT-BYOK. We don't ship our own auth for Claude
 * Code. Instead, on launch we check whether `~/.claude/.credentials.json`
 * (or platform equivalent) exists; if not, we spawn `claude /login`
 * inside a PTY so it renders its interactive menu, send Enter to pick
 * the default OAuth option, intercept the resulting OAuth URL from the
 * PTY output, and open it inside an in-app BrowserWindow.
 *
 * Claude's embedded localhost callback server still receives the redirect,
 * so the BrowserWindow never has to know how OAuth works — it just
 * navigates and lets claude do its thing.
 *
 * On claude exit the BrowserWindow is closed and the renderer's poll
 * loop catches the freshly-written creds.
 *
 * Surface:
 *   • bootstrapStatus()  — { found, claudePath } for the renderer
 *   • spawnCcLogin()     — pty-spawn claude /login, send Enter to pick
 *                          OAuth, intercept URL, open BrowserWindow.
 *                          Returns whether the spawn launched.
 *   • ensureCcAuth()     — pre-flight helper for agent callers
 */

import * as pty from "node-pty";
import * as os from "os";
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
 * If Claude Code creds are present, return true. Otherwise tell the
 * renderer to show the gating bootstrap modal (which auto-triggers
 * spawnCcLogin) and return false. Callers (agent runners) abort the
 * current call; the modal blocks the user until creds land.
 */
export function ensureCcAuth(): boolean {
  if (bootstrapStatus().found) return true;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("cc-show-modal");
  }
  return false;
}

let activeOAuthWindow: BrowserWindow | null = null;
let activeChild: pty.IPty | null = null;
let activeChildRunning = false;

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
    if (activeChild && activeChildRunning) {
      try { activeChild.kill(); } catch { /* ignore */ }
      activeChild = null;
      activeChildRunning = false;
    }
  });
  activeOAuthWindow = win;
}

/**
 * Spawn `claude /login` in a PTY and host the OAuth flow in-app.
 *
 * Using a PTY (instead of plain spawn) lets claude render its interactive
 * menu — with stdin as /dev/null it gets EOF and never reaches the OAuth
 * URL. We send Enter after 600 ms to accept the default "Anthropic account"
 * option, then watch PTY output for an OAuth URL and load it in a
 * BrowserWindow.
 */
export function spawnCcLogin(): { ok: boolean; error?: string } {
  const claudePath = findClaudeCli();
  if (!claudePath) {
    return { ok: false, error: "claude CLI not found on PATH — install Claude Code first" };
  }

  // Don't double-spawn; refocus the existing window if login is in flight.
  if (activeChild && activeChildRunning) {
    if (activeOAuthWindow && !activeOAuthWindow.isDestroyed()) {
      activeOAuthWindow.focus();
    }
    return { ok: true };
  }

  try {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...process.env, PATH: getShellPath() })) {
      if (v !== undefined) env[k] = v;
    }

    const child = pty.spawn(claudePath, ["/login"], {
      name: "xterm-color",
      cols: 120,
      rows: 30,
      cwd: os.homedir(),
      env,
    });

    activeChild = child;
    activeChildRunning = true;
    console.log("[cc-bootstrap] spawned claude /login pty pid=", child.pid);

    let urlOpened = false;
    let outputBuffer = "";
    let themeAnswered = false;
    let loginMethodAnswered = false;

    const tryOpen = (text: string): void => {
      console.log("[cc-bootstrap] pty:", JSON.stringify(text).slice(0, 200));
      // Strip ANSI escape codes + 1-col-spacer codes before scanning.
      const plain = text
        .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
        .replace(/\x1b\][^\x07]*\x07/g, "");
      outputBuffer += plain;

      // Drive past claude's two interactive prompts by detecting their
      // copy in the buffer and pressing Enter (default option = what we
      // want for both: Dark theme + Claude account/OAuth).
      if (!themeAnswered && /Choose the text style/i.test(outputBuffer)) {
        themeAnswered = true;
        console.log("[cc-bootstrap] answering theme prompt");
        try { child.write("\r"); } catch { /* ignore */ }
      }
      if (!loginMethodAnswered && /Select login method/i.test(outputBuffer)) {
        loginMethodAnswered = true;
        console.log("[cc-bootstrap] answering login method prompt");
        try { child.write("\r"); } catch { /* ignore */ }
      }

      if (urlOpened) return;
      const match = outputBuffer.match(/https:\/\/[^\s\r\n]+/);
      if (!match) return;
      const url = match[0].replace(/[)\].,;'"]+$/, "");
      if (!/claude\.ai|anthropic\.com/.test(url)) return;
      urlOpened = true;
      console.log("[cc-bootstrap] caught oauth url:", url);
      openOAuthWindow(url);
    };

    child.onData((data: string) => tryOpen(data));

    child.onExit(({ exitCode, signal }) => {
      console.log("[cc-bootstrap] claude /login exited code=", exitCode, "signal=", signal);
      activeChildRunning = false;
      activeChild = null;
      // Don't auto-close OAuth window on exit — claude exits as soon as
      // it hands off the URL, but the user still needs the window open
      // to finish authenticating. The window's own "closed" event clears
      // activeOAuthWindow.
    });

    return { ok: true };
  } catch (err) {
    activeChildRunning = false;
    activeChild = null;
    const msg = err instanceof Error ? err.message : "claude /login spawn failed";
    return { ok: false, error: msg };
  }
}
