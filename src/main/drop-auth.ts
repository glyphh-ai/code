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
import { getHeartbeatInfo } from "./auth";

const AUTH_SERVER = process.env.YO_AUTH_SERVER || "https://api.yosup.dev";
const SESSION_PATH = path.join(os.homedir(), "yo", ".session.drop");

// ── Fallback encryption when safeStorage is unavailable ─────────────────
// Derives a 256-bit AES key from machine-bound values (hostname, homedir,
// platform, arch). Not as strong as OS Keychain but prevents casual reads.
// Works identically on macOS and Windows.

const FALLBACK_SALT = "yo-drop-session-v1";

function getFallbackKey(): Buffer {
  const material = [os.hostname(), os.homedir(), os.platform(), os.arch()].join("|");
  return crypto.scryptSync(material, FALLBACK_SALT, 32);
}

function fallbackEncrypt(plaintext: string): Buffer {
  const key = getFallbackKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: [iv 12B][tag 16B][ciphertext]
  return Buffer.concat([iv, tag, encrypted]);
}

function fallbackDecrypt(data: Buffer): string {
  const key = getFallbackKey();
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const ciphertext = data.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8");
}

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
  if (!fs.existsSync(SESSION_PATH)) return null;
  let raw: Buffer;
  try {
    raw = fs.readFileSync(SESSION_PATH);
  } catch (err) {
    console.warn("[drop-auth] session file unreadable:", err instanceof Error ? err.message : err);
    return null;
  }
  // Try EVERY decryptor and use whichever yields valid JSON — do NOT branch on
  // safeStorage.isEncryptionAvailable(). On a cold boot the macOS keychain may
  // not be warm yet and that flag transiently reads false; branching on it
  // then ran fallbackDecrypt against safeStorage-encrypted data, failed, and
  // silently logged the user out — until they closed and reopened the app.
  const attempts: Array<[string, () => string]> = [
    ["safeStorage", () => safeStorage.decryptString(raw)],
    ["fallback", () => fallbackDecrypt(raw)],
  ];
  for (const [label, decrypt] of attempts) {
    try {
      const parsed = JSON.parse(decrypt()) as DropSession;
      if (parsed && typeof parsed.accessToken === "string") {
        cached = parsed;
        return parsed;
      }
    } catch {
      /* try the next decryptor */
    }
  }
  console.warn("[drop-auth] session file present but could not be decrypted by any method");
  return null;
}

function writeSession(s: DropSession): void {
  fs.mkdirSync(path.dirname(SESSION_PATH), { recursive: true });
  const json = JSON.stringify(s);
  let enc: Buffer;
  if (safeStorage.isEncryptionAvailable()) {
    enc = safeStorage.encryptString(json);
  } else {
    console.warn("[drop-auth] safeStorage unavailable — using machine-derived AES fallback");
    enc = fallbackEncrypt(json);
  }
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
 * fetch() that transparently retries transient gateway failures — 502/503/504
 * and network errors — with backoff. yo-server can briefly 503 (a cold start,
 * a dyno hiccup) and serve an HTML "Application Error" page; without this the
 * user just sees the failure and has to click sign-in again.
 *
 * Only gateway-level 5xx are retried: a 502/503/504 means the request never
 * reached the app, so retrying the (single-use) OAuth code is safe. App-level
 * 4xx/500 responses are returned as-is — those are real errors.
 */
async function fetchResilient(url: string, init?: RequestInit): Promise<Response> {
  const delays = [800, 2000, 5000];   // 4 attempts total
  let lastErr: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok || ![502, 503, 504].includes(res.status) || attempt === delays.length) {
        return res;
      }
      try { await res.body?.cancel(); } catch { /* ignore */ }
      console.warn(`[drop-auth] ${url} → ${res.status}, retrying (attempt ${attempt + 1})`);
    } catch (err) {
      lastErr = err;
      if (attempt === delays.length) throw err;
      console.warn(`[drop-auth] ${url} network error, retrying (attempt ${attempt + 1})`);
    }
    await new Promise((r) => setTimeout(r, delays[attempt]));
  }
  throw lastErr ?? new Error("fetchResilient: exhausted retries");
}

/**
 * Open the GH OAuth flow in a child BrowserWindow scoped to the drop-session
 * partition. Resolves with the parsed { code, state } once the callback
 * lands, then exchanges with yo-server.
 *
 * Rejects if the user closes the window, the server is unreachable, or the
 * exchange returns non-2xx (including 501 stub).
 */
let signInInFlight = false;

export async function signInWithGitHub(): Promise<{ ok: true; status: DropAuthStatus } | { ok: false; error: string; status?: number }> {
  // Guard against a second sign-in flow starting while one is mid-exchange
  // (e.g. the user clicking the button again after a transient error) —
  // concurrent OAuth windows + a shared activeOAuthWindow handle is a
  // recipe for bad state.
  if (signInInFlight) {
    return { ok: false, error: "Sign-in is already in progress." };
  }
  signInInFlight = true;
  try {
    return await doSignInWithGitHub();
  } finally {
    signInInFlight = false;
  }
}

async function doSignInWithGitHub(): Promise<{ ok: true; status: DropAuthStatus } | { ok: false; error: string; status?: number }> {
  // 1. Get authorize URL from yo-server
  // Bind to the platform user so the GH token is stored under the same user ID
  const platformUserId = getHeartbeatInfo()?.user?.id;
  console.log("[drop-auth] signInWithGitHub bind_user_id:", platformUserId ?? "(heartbeat not available)");
  const qs = new URLSearchParams({ flow: "electron-drop" });
  if (platformUserId) qs.set("bind_user_id", platformUserId);
  const startRes = await fetchResilient(`${AUTH_SERVER}/api/auth/github/start?${qs}`, {
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
  const exchangeRes = await fetchResilient(`${AUTH_SERVER}/api/auth/github/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, state }),
  });
  if (!exchangeRes.ok) {
    const body = await exchangeRes.text();
    return { ok: false, error: `auth/github/exchange failed (${exchangeRes.status}): ${body.slice(0, 200)}`, status: exchangeRes.status };
  }
  // Server returns expiresAt as ISO8601 string; we store ms epoch internally.
  const raw = await exchangeRes.json() as Omit<DropSession, "expiresAt"> & { expiresAt: string | number };
  const session: DropSession = {
    ...raw,
    expiresAt: typeof raw.expiresAt === "string" ? Date.parse(raw.expiresAt) : raw.expiresAt,
  };
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
    // Server refresh endpoint is /api/session/refresh — NOT /api/auth/refresh.
    // The wrong path 404'd every time, so the token silently expired whenever
    // The Drop sat idle past its lifetime.
    const res = await fetch(`${AUTH_SERVER}/api/session/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: s.refreshToken }),
    });
    if (!res.ok) {
      // 401 → the refresh token itself is dead; only a manual sign-in helps.
      // Anything else (5xx, network) is transient — retry soon so one blip
      // doesn't kill the refresh loop and let the token lapse.
      if (res.status !== 401) scheduleRefreshRetry();
      return;
    }
    const next = await res.json() as Partial<DropSession>;
    if (!next.accessToken || !next.expiresAt) { scheduleRefreshRetry(); return; }
    const merged: DropSession = { ...s, ...next } as DropSession;
    writeSession(merged);
    scheduleRefresh(merged); // arm the next refresh
  } catch {
    scheduleRefreshRetry(); // network blip — try again, don't give up
  }
}

/** Re-arm a refresh after a transient failure so the loop never dies. */
function scheduleRefreshRetry(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { void refreshOnce(); }, 60_000);
}

/** Init at app boot. No-op if there's no existing session file. */
export function initDropAuth(): void {
  const s = readSession();
  if (s) { scheduleRefresh(s); return; }

  // No session in hand. If a file exists, safeStorage may simply not be warm
  // yet on a cold boot (the Drop opens before the Keychain is ready). Retry a
  // few times before giving up so we don't strand the user as "logged out".
  if (!fs.existsSync(SESSION_PATH)) return;
  let attempts = 0;
  const retry = setInterval(() => {
    attempts++;
    cached = null; // force a fresh decrypt attempt
    const late = readSession();
    if (late) { clearInterval(retry); scheduleRefresh(late); return; }
    if (attempts >= 5) clearInterval(retry);
  }, 1000);
}

/** Best-effort dev/debug — show where the session file lives. */
export function getDropSessionPath(): string {
  return SESSION_PATH;
}
