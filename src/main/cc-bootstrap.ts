/**
 * cc-bootstrap — first-run Claude Code login flow.
 *
 * Phase 2 of THE-PIVOT-BYOK. We don't ship our own auth for Claude
 * Code. Instead, when we detect missing creds we open a small in-app
 * BrowserWindow that hosts a real xterm running `claude /login` in a
 * PTY. The user interacts with claude's actual TUI — picks the theme,
 * picks the login method, sees the OAuth URL — and we just provide the
 * surface. No menu-string scraping, no prompt detection, no fragile
 * driving.
 *
 * Optional polish: we still scan PTY output for an OAuth URL and, if
 * we catch one, also open it in a dedicated BrowserWindow so the user
 * doesn't have to copy/paste it. Claude Code's local callback server
 * receives the redirect either way; once creds land on disk the
 * renderer's poll dismisses the gating modal.
 *
 * Surface:
 *   • bootstrapStatus()  — { found, claudePath } for the renderer
 *   • spawnCcLogin()     — open the terminal panel + (optional) OAuth window
 *   • ensureCcAuth()     — pre-flight helper for agent callers
 */

import * as pty from "node-pty";
import * as os from "os";
import * as path from "path";
import { BrowserWindow, ipcMain, type IpcMainEvent } from "electron";
import { getShellPath } from "./shell-path";
import { findCcCredentials, findClaudeCli, type CcCredsResult } from "./cc-creds";
import { hasKey as hasProviderKey } from "./provider-keys";

export interface BootstrapStatus extends CcCredsResult {
  /** Absolute path to `claude` CLI, or null if not installed. */
  claudePath: string | null;
  /** True when the user has a BYOK Anthropic API key configured under
   *  Settings → Providers. When set, the SDK uses that key instead of the
   *  Claude Code OAuth creds, and the CC-bootstrap modal is suppressed. */
  byokAnthropic: boolean;
}

export function bootstrapStatus(): BootstrapStatus {
  const cc = findCcCredentials();
  let byok = false;
  try { byok = hasProviderKey("anthropic"); } catch { /* */ }
  // Either path counts as "found" from the caller's perspective — both
  // result in the SDK being able to call api.anthropic.com.
  return { ...cc, found: cc.found || byok, claudePath: findClaudeCli(), byokAnthropic: byok };
}

/**
 * Returns true when SOME auth path is configured (Claude Code OAuth or BYOK
 * Anthropic key). Otherwise tells the renderer to show the gating bootstrap
 * modal and returns false. With BYOK now an accepted path, users who don't
 * have a Claude subscription can still use the agent.
 */
export function ensureCcAuth(): boolean {
  if (bootstrapStatus().found) return true;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("cc-show-modal");
  }
  return false;
}

let activeOAuthWindow: BrowserWindow | null = null;
let activeTermWindow: BrowserWindow | null = null;
let activeChild: pty.IPty | null = null;

function openOAuthWindow(url: string): void {
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
      partition: "persist:cc-oauth",
    },
  });
  win.loadURL(url);
  win.on("closed", () => { activeOAuthWindow = null; });
  activeOAuthWindow = win;
}

/**
 * Open a small BrowserWindow with an xterm.js terminal running
 * `claude /login`. The user navigates the TUI themselves — robust to
 * menu copy / order changes since we don't try to drive it. We watch
 * the PTY output for an OAuth URL and pop our own BrowserWindow at it
 * if/when we see one (so the user doesn't have to copy-paste).
 */
export function spawnCcLogin(): { ok: boolean; error?: string } {
  const claudePath = findClaudeCli();
  if (!claudePath) {
    return { ok: false, error: "claude CLI not found on PATH — install Claude Code first" };
  }

  // Don't double-spawn; refocus the existing terminal window if a login
  // session is already running.
  if (activeTermWindow && !activeTermWindow.isDestroyed()) {
    activeTermWindow.focus();
    return { ok: true };
  }

  try {
    const win = new BrowserWindow({
      width: 720,
      height: 520,
      title: "Sign in to Claude Code",
      autoHideMenuBar: true,
      backgroundColor: "#0d0d14",
      webPreferences: {
        preload: path.join(__dirname, "terminal-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    activeTermWindow = win;
    // ?font=11 → smaller font in xterm so claude's ~96-col TUI fits in
    // a 720-wide window without wrapping.
    win.loadFile(
      path.join(__dirname, "..", "renderer", "terminal.html"),
      { search: "font=11" },
    );

    let urlOpened = false;
    let outputBuffer = "";

    const tryCatchUrl = (text: string): void => {
      if (urlOpened) return;
      // Strip ANSI just for URL scanning (display passes through raw).
      const plain = text
        .replace(/\x1b\[(\d+)C/g, (_, n) => " ".repeat(Math.min(parseInt(n, 10), 80)))
        .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
        .replace(/\x1b\][^\x07]*\x07/g, "");
      outputBuffer += plain;
      const match = outputBuffer.match(/https:\/\/[^\s\r\n]+/);
      if (!match) return;
      const url = match[0].replace(/[)\].,;'"]+$/, "");
      if (!/claude\.ai|anthropic\.com/.test(url)) return;
      urlOpened = true;
      console.log("[cc-bootstrap] caught oauth url:", url);
      openOAuthWindow(url);
    };

    const onWriteHandler = (e: IpcMainEvent, data: string) => {
      if (e.sender !== win.webContents) return;
      try { activeChild?.write(data); } catch { /* ignore */ }
    };
    const onResizeHandler = (e: IpcMainEvent, cols: number, rows: number) => {
      if (e.sender !== win.webContents) return;
      try { activeChild?.resize(cols, rows); } catch { /* ignore */ }
    };

    // Wait for the renderer to report its actual xterm size before spawning
    // — claude's banner / menu render at first-output dimensions, so getting
    // them right up front avoids jumbled wrapping when xterm later resizes.
    const onFirstResize = (e: IpcMainEvent, cols: number, rows: number) => {
      if (e.sender !== win.webContents) return;
      ipcMain.removeListener("terminal:resize", onFirstResize);

      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries({ ...process.env, PATH: getShellPath() })) {
        if (v !== undefined) env[k] = v;
      }
      const child = pty.spawn(claudePath, ["/login"], {
        name: "xterm-256color",
        cols: cols || 100,
        rows: rows || 28,
        cwd: os.homedir(),
        env,
      });
      activeChild = child;
      console.log("[cc-bootstrap] spawned claude /login pty pid=", child.pid, "size=", cols, "x", rows);

      child.onData((data: string) => {
        if (!win.isDestroyed()) win.webContents.send("terminal:data", data);
        tryCatchUrl(data);
      });
      child.onExit(({ exitCode, signal }) => {
        console.log("[cc-bootstrap] claude /login exited code=", exitCode, "signal=", signal);
        if (!win.isDestroyed()) win.webContents.send("terminal:exit", exitCode);
        activeChild = null;
      });

      ipcMain.on("terminal:write", onWriteHandler);
      ipcMain.on("terminal:resize", onResizeHandler);
    };
    ipcMain.on("terminal:resize", onFirstResize);

    win.on("closed", () => {
      activeTermWindow = null;
      ipcMain.removeListener("terminal:resize", onFirstResize);
      ipcMain.removeListener("terminal:write", onWriteHandler);
      ipcMain.removeListener("terminal:resize", onResizeHandler);
      if (activeChild) {
        try { activeChild.kill(); } catch { /* ignore */ }
        activeChild = null;
      }
    });

    return { ok: true };
  } catch (err) {
    activeTermWindow = null;
    const msg = err instanceof Error ? err.message : "claude /login spawn failed";
    return { ok: false, error: msg };
  }
}
