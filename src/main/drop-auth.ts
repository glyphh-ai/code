/**
 * drop-auth — GH OAuth scoped to The Drop panel.
 *
 * THE-PIVOT-GITHUB Phase 1. Sister to `auth.ts` (which manages the main yo
 * session). This module owns:
 *
 *   • Reading / writing ~/yo/.session.drop  (encrypted via safeStorage)
 *   • Opening a child BrowserWindow on /api/auth/github/start
 *   • Intercepting the github → /api/auth/github/callback redirect
 *   • POSTing { code, state } to /api/auth/github/exchange
 *   • Refreshing the Drop session before expiry
 *   • Signing out (zero the session file, leave main yo session alone)
 *
 * SCAFFOLD STATUS (this commit):
 *   • Storage shape + safeStorage encryption: live
 *   • signInWithGitHub() opens the BrowserWindow, intercepts the callback,
 *     and calls /api/auth/github/exchange — but the server endpoint is
 *     currently stubbed at 501, so the returned error is surfaced through
 *     the IPC contract for the renderer to display.
 *   • Token refresh scheduling: scaffolded, no-op until exchange returns
 *     a real token.
 *
 * Once server-side Phase 10 lands (real exchange), nothing in this file
 * changes — the 501 response path becomes the success path.
 */

import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { BrowserWindow, safeStorage } from "electron";

const AUTH_SERVER = process.env.YO_AUTH_SERVER || "https://api.yosup.dev";
const SESSION_PATH = path.join(os.homedir(), "yo", ".session.drop");

export interface DropSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;       // ms epoch
  user: {
    id: string;
    email: string;
    role: string;
    tier: string;
    orgId: string | null;
  };
  github: {
    gh_user_id: number;
    gh_login: string;
    gh_avatar: string;
  };
}

export interface DropAuthStatus {
  signedIn: boolean;
  github: { gh_login: string; gh_avatar: string } | null;
  expiresAt: number | null;
}

let cached: DropSession | null = null;
let activeOAuthWindow: BrowserWindow | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

// ── Storage ──────────────────────────────────────────────────────────────

function readSession(): DropSession | null {
  if (cached) return cached;
  try {
    if (!fs.existsSync(SESSION_PATH)) return null;
    const enc = fs.readFileSync(SESSION_PATH);
    if (!safeStorage.isEncryptionAvailable()) return null;
    const json = safeStorage.decryptString(enc);
    const parsed = JSON.parse(json) as DropSession;
    cached = parsed;
    return parsed;
  } catch {
    return null;
  }
}

function writeSession(s: DropSession): void {
  fs.mkdirSync(path.dirname(SESSION_PATH), { recursive: true });
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("safeStorage encryption not available — cannot persist Drop session");
  }
  const enc = safeStorage.encryptString(JSON.stringify(s));
  fs.writeFileSync(SESSION_PATH, enc, { mode: 0o600 });
  cached = s;
  scheduleRefresh(s);
}

function clearSession(): void {
  cached = null;
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
  try { if (fs.existsSync(SESSION_PATH)) fs.unlinkSync(SESSION_PATH); } catch { /* ignore */ }
}

// ── Public surface ───────────────────────────────────────────────────────

export function getDropAuthStatus(): DropAuthStatus {
  const s = readSession();
  if (!s) return { signedIn: false, github: null, expiresAt: null };
  return {
    signedIn: Date.now() < s.expiresAt,
    github: { gh_login: s.github.gh_login, gh_avatar: s.github.gh_avatar },
    expiresAt: s.expiresAt,
  };
}

export function getDropAccessToken(): string | null {
  const s = readSession();
  if (!s) return null;
  if (Date.now() >= s.expiresAt) return null;
  return s.accessToken;
}

export function signOutDrop(): void {
  clearSession();
}

/**
 * Open the GH OAuth flow in a child BrowserWindow scoped to the drop-session
 * partition. Resolves with the parsed { code, state } once the callback
 * lands, then exchanges with yo-server.
 *
 * Rejects if the user closes the window, the server is unreachable, or the
 * exchange returns non-2xx (including 501 stub).
 */
export async function signInWithGitHub(): Promise<{ ok: true; status: DropAuthStatus } | { ok: false; error: string; status?: number }> {
  // 1. Get authorize URL from yo-server
  const startRes = await fetch(`${AUTH_SERVER}/api/auth/github/start?flow=electron-drop`, {
    method: "GET",
  });
  if (!startRes.ok) {
    const body = await startRes.text();
    return { ok: false, error: `auth/github/start failed (${startRes.status}): ${body.slice(0, 200)}`, status: startRes.status };
  }
  const startBody = await startRes.json() as { authorizeUrl: string; state: string };

  // 2. Open BrowserWindow + intercept callback
  const callbackUrl = await openOAuthWindow(startBody.authorizeUrl);
  if (!callbackUrl) return { ok: false, error: "user closed sign-in window" };

  const u = new URL(callbackUrl);
  const code = u.searchParams.get("code");
  const state = u.searchParams.get("state");
  if (!code || !state) return { ok: false, error: "callback missing code/state" };
  if (state !== startBody.state) return { ok: false, error: "state mismatch — possible CSRF" };

  // 3. Exchange with yo-server
  const exchangeRes = await fetch(`${AUTH_SERVER}/api/auth/github/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, state }),
  });
  if (!exchangeRes.ok) {
    const body = await exchangeRes.text();
    return { ok: false, error: `auth/github/exchange failed (${exchangeRes.status}): ${body.slice(0, 200)}`, status: exchangeRes.status };
  }
  const session = await exchangeRes.json() as DropSession;
  writeSession(session);
  return { ok: true, status: getDropAuthStatus() };
}

async function openOAuthWindow(url: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    if (activeOAuthWindow && !activeOAuthWindow.isDestroyed()) {
      activeOAuthWindow.focus();
    }
    const win = new BrowserWindow({
      width: 640,
      height: 800,
      title: "Sign in to GitHub",
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: "persist:drop-session",
      },
    });
    activeOAuthWindow = win;

    let resolved = false;
    const finish = (val: string | null) => {
      if (resolved) return;
      resolved = true;
      activeOAuthWindow = null;
      resolve(val);
      try { if (!win.isDestroyed()) win.close(); } catch { /* ignore */ }
    };

    // Intercept the callback URL before the page actually renders.
    const tryIntercept = (navUrl: string) => {
      try {
        if (!navUrl) return;
        const u = new URL(navUrl);
        if (u.pathname.endsWith("/api/auth/github/callback")) {
          finish(navUrl);
        }
      } catch { /* ignore non-URLs */ }
    };
    win.webContents.on("will-redirect", (_e, navUrl) => tryIntercept(navUrl));
    win.webContents.on("did-navigate", (_e, navUrl) => tryIntercept(navUrl));
    win.on("closed", () => finish(null));

    win.loadURL(url);
  });
}

// ── Refresh ─────────────────────────────────────────────────────────────

function scheduleRefresh(s: DropSession): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  // Refresh at 80% of remaining lifetime, min 30s, max 12h.
  const remaining = Math.max(0, s.expiresAt - Date.now());
  const delay = Math.min(Math.max(remaining * 0.8, 30_000), 12 * 60 * 60 * 1000);
  refreshTimer = setTimeout(() => { void refreshOnce(); }, delay);
}

async function refreshOnce(): Promise<void> {
  const s = readSession();
  if (!s?.refreshToken) return;
  try {
    const res = await fetch(`${AUTH_SERVER}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: s.refreshToken }),
    });
    if (!res.ok) return; // leave the existing token until manual sign-in
    const next = await res.json() as Partial<DropSession>;
    if (!next.accessToken || !next.expiresAt) return;
    const merged: DropSession = { ...s, ...next } as DropSession;
    writeSession(merged);
  } catch {
    /* network blip — let next attempt try again */
  }
}

/** Init at app boot. No-op if there's no existing session file. */
export function initDropAuth(): void {
  const s = readSession();
  if (s) scheduleRefresh(s);
}

/** Best-effort dev/debug — show where the session file lives. */
export function getDropSessionPath(): string {
  return SESSION_PATH;
}
