/**
 * Auth — BrowserWindow-based authentication via platform.dotyo.dev.
 *
 * Flow:
 *   1. Open BrowserWindow to platform.dotyo.dev/auth?flow=electron (register or login)
 *   2. User completes auth on the platform
 *   3. Web generates a one-time device code and redirects to /auth/callback?code=XXX
 *   4. We intercept the navigation, extract the code, exchange it for JWT tokens
 *   5. Tokens stored encrypted via safeStorage
 *   6. Heartbeat polls server every 4 hours for tier/entitlements
 */

import fs from "fs";
import path from "path";
import os from "os";
import { BrowserWindow, net, safeStorage, shell } from "electron";

const CONFIG_DIR = path.join(os.homedir(), "yo");
const SESSION_FILE = path.join(CONFIG_DIR, ".session");
const REFRESH_MARGIN = 3 * 60 * 1000; // refresh 3 min before expiry
const HEARTBEAT_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours

export const AUTH_SERVER =
  process.env.YO_AUTH_SERVER || "https://api.dotyo.dev";
export const PLATFORM_URL =
  process.env.YO_PLATFORM_URL || "https://platform.dotyo.dev";

// ── Types ────────────────────────────────────────────────────

export interface SessionData {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms timestamp
}

export interface AccountInfo {
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  orgName: string;
  orgSlug: string;
  tier: string;
  billingStatus: string;
}

export interface HeartbeatResult {
  status: "active" | "expired" | "disabled";
  tier: string;
  billingStatus: string;
  entitlements: Record<string, unknown>;
  org: { id: string; name: string; maxSeats: number } | null;
  user: { id: string; email: string; firstName: string | null; lastName: string | null; role: string };
}

// ── State ────────────────────────────────────────────────────

let currentSession: SessionData | null = null;
let cachedAccount: AccountInfo | null = null;
let cachedHeartbeat: HeartbeatResult | null = null;
let heartbeatObserver: ((result: HeartbeatResult) => void) | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let authWindow: BrowserWindow | null = null;

// ── Re-auth gate ─────────────────────────────────────────────
// Fired when the session can't be kept alive (refresh rejected, or an authed
// call hit 401 with no usable token) so the UI can surface the login screen
// instead of silently degrading. Debounced so a burst of failing calls only
// pops one prompt.
let reauthHandler: (() => void) | null = null;
let lastReauthAt = 0;

/** Register the callback that surfaces the login gate (set by main.ts). */
export function setReauthHandler(fn: () => void): void { reauthHandler = fn; }

/** Signal that the user must re-authenticate. Debounced (30s). */
function triggerReauth(): void {
  const now = Date.now();
  if (now - lastReauthAt < 30_000) return;
  lastReauthAt = now;
  console.warn("[auth] session cannot be refreshed — prompting re-login");
  try { reauthHandler?.(); } catch { /* noop */ }
}

// ── Encrypted storage ────────────────────────────────────────

function secureWrite(filePath: string, data: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(data);
    fs.writeFileSync(filePath, encrypted, { mode: 0o600 });
  } else {
    fs.writeFileSync(filePath, data, { encoding: "utf-8", mode: 0o600 });
  }
}

function secureRead(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath);
    if (safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.decryptString(raw);
      } catch {
        return raw.toString("utf-8");
      }
    }
    return raw.toString("utf-8");
  } catch {
    return null;
  }
}

// ── Session persistence ──────────────────────────────────────

function readSessionFile(): SessionData | null {
  const data = secureRead(SESSION_FILE);
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function saveSessionFile(session: SessionData): void {
  secureWrite(SESSION_FILE, JSON.stringify(session));
  currentSession = session;
  scheduleRefresh(session);
}

function clearSessionFile(): void {
  currentSession = null;
  cachedAccount = null;
  cachedHeartbeat = null;
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
  try { fs.unlinkSync(SESSION_FILE); } catch { /* ignore */ }
}

// ── Token refresh ────────────────────────────────────────────

function scheduleRefresh(session: SessionData): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  const delay = Math.max(0, session.expiresAt - Date.now() - REFRESH_MARGIN);
  refreshTimer = setTimeout(() => { void refreshTokens(); }, delay);
}

// Single-flight: the refresh token is single-use (the server rotates it), so
// overlapping refreshes would double-spend it and the second would 401 → a
// spurious logout. Coalesce concurrent callers onto one in-flight refresh.
let refreshInFlight: Promise<boolean> | null = null;
function refreshTokens(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = doRefreshTokens().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

async function doRefreshTokens(): Promise<boolean> {
  const session = currentSession || readSessionFile();
  if (!session?.refreshToken) return false;

  try {
    const result = await serverPost<{
      ok: boolean;
      accessToken?: string;
      refreshToken?: string;
      expiresIn?: number;
      error?: string;
    }>("/api/session/refresh", { refreshToken: session.refreshToken });

    if (result.ok && result.accessToken && result.refreshToken && result.expiresIn) {
      saveSessionFile({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: Date.now() + result.expiresIn * 1000,
      });
      return true;
    }
    // 2xx but not ok — treat as an invalid refresh token → must re-login.
    clearSessionFile();
    triggerReauth();
    return false;
  } catch (err) {
    // Only a genuine 401 means the refresh token is invalid/revoked → re-login.
    // Everything else (5xx during a deploy, network blip, timeout) is TRANSIENT:
    // keep the existing session if still valid and retry — do NOT bounce the
    // user to the login screen over a momentary server hiccup.
    const is401 = /HTTP 401\b/.test(String((err as Error)?.message || ""));
    if (!is401 && currentSession && currentSession.expiresAt > Date.now()) {
      setTimeout(() => { void refreshTokens(); }, 30_000);
      return true;
    }
    clearSessionFile();
    triggerReauth();
    return false;
  }
}

// ── Public API ───────────────────────────────────────────────

/** Check if user is authenticated (has valid session). */
export function isAuthenticated(): boolean {
  if (currentSession && currentSession.expiresAt > Date.now()) return true;
  const saved = readSessionFile();
  if (saved && saved.expiresAt > Date.now()) {
    currentSession = saved;
    return true;
  }
  return false;
}

/** Get current access token, or null if not authenticated. */
export function getAuthToken(): string | null {
  if (currentSession && currentSession.expiresAt > Date.now()) {
    return currentSession.accessToken;
  }
  return null;
}

/** Initialize auth — restore session, schedule refresh, start heartbeat. */
export async function initAuth(): Promise<void> {
  const saved = readSessionFile();
  if (saved) {
    currentSession = saved;
    if (saved.expiresAt - Date.now() < REFRESH_MARGIN) {
      await refreshTokens();
    } else {
      scheduleRefresh(saved);
    }
    // Fetch account info + heartbeat on boot
    void fetchAccountInfo();
    void fetchHeartbeat();
  }
  startHeartbeat();
}

/** Clean up timers — call on app shutdown. */
export function cleanupAuthTimers(): void {
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

/** Log out — clear session and cached data. */
export function logout(): void {
  clearSessionFile();
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

/** Get cached account info. */
export function getAccountInfo(): AccountInfo | null {
  return cachedAccount;
}

/** Get cached heartbeat result. */
export function getHeartbeatInfo(): HeartbeatResult | null {
  return cachedHeartbeat;
}

/**
 * Get auth status for the boot sequence.
 * Returns trial/account info without requiring a license key.
 */
export function getAuthStatus(): {
  authenticated: boolean;
  status: "active" | "expired" | "disabled" | "unauthenticated";
  tier?: string;
} {
  if (!isAuthenticated()) {
    return { authenticated: false, status: "unauthenticated" };
  }
  if (cachedHeartbeat) {
    return {
      authenticated: true,
      status: cachedHeartbeat.status,
      tier: cachedHeartbeat.tier,
    };
  }
  return { authenticated: true, status: "active" };
}

// ── BrowserWindow auth flow ──────────────────────────────────

/**
 * Open auth window for registration or login.
 * Returns a promise that resolves when auth is complete (tokens stored).
 */
export function startAuthFlow(mode: "register" | "login" = "register"): Promise<boolean> {
  return new Promise((resolve) => {
    // Close any existing auth window
    if (authWindow && !authWindow.isDestroyed()) {
      authWindow.close();
    }

    const authPath = mode === "login" ? "/auth/login" : "/auth";
    const authUrl = `${PLATFORM_URL}${authPath}?flow=electron`;

    authWindow = new BrowserWindow({
      width: 520,
      height: 700,
      title: "Sign in to Yo",
      resizable: false,
      minimizable: false,
      maximizable: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    authWindow.setMenuBarVisibility(false);

    // Watch for navigation to the callback URL
    authWindow.webContents.on("will-navigate", async (_event, url) => {
      if (url.includes("/auth/callback")) {
        const parsed = new URL(url);
        const code = parsed.searchParams.get("code");
        if (code) {
          // Exchange device code for JWT
          const success = await exchangeDeviceCode(code);
          if (success) {
            // Fetch account info immediately
            await fetchAccountInfo();
            await fetchHeartbeat();
          }
          if (authWindow && !authWindow.isDestroyed()) {
            authWindow.close();
          }
          resolve(success);
        }
      }
    });

    // Also watch for redirects (the callback may be a server-side redirect)
    authWindow.webContents.on("will-redirect", async (_event, url) => {
      if (url.includes("/auth/callback")) {
        const parsed = new URL(url);
        const code = parsed.searchParams.get("code");
        if (code) {
          const success = await exchangeDeviceCode(code);
          if (success) {
            await fetchAccountInfo();
            await fetchHeartbeat();
          }
          if (authWindow && !authWindow.isDestroyed()) {
            authWindow.close();
          }
          resolve(success);
        }
      }
    });

    authWindow.on("closed", () => {
      authWindow = null;
      // If the window was closed without completing auth, resolve false
      resolve(false);
    });

    authWindow.loadURL(authUrl);
  });
}

/** Exchange a one-time device code for JWT tokens. */
async function exchangeDeviceCode(code: string): Promise<boolean> {
  try {
    const result = await serverPost<{
      ok: boolean;
      accessToken?: string;
      refreshToken?: string;
      expiresIn?: number;
      error?: string;
    }>("/api/auth/device-exchange", { code });

    if (result.ok && result.accessToken && result.refreshToken && result.expiresIn) {
      saveSessionFile({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: Date.now() + result.expiresIn * 1000,
      });
      return true;
    }
    console.error("Device code exchange failed:", result.error);
    return false;
  } catch (err) {
    console.error("Device code exchange error:", err);
    return false;
  }
}

// ── Heartbeat ────────────────────────────────────────────────

function startHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (isAuthenticated()) {
      void fetchHeartbeat();
    }
  }, HEARTBEAT_INTERVAL);
}

async function fetchHeartbeat(): Promise<HeartbeatResult | null> {
  try {
    const result = await serverGetAuthed<HeartbeatResult>("/api/heartbeat");
    cachedHeartbeat = result;
    // Notify the observer so the app can gate access when a trial ends or an
    // account is disabled — the heartbeat is the authoritative trial check.
    try { heartbeatObserver?.(result); } catch { /* observer must not break the poll */ }
    return result;
  } catch {
    return null;
  }
}

/**
 * Register an observer notified on every heartbeat result. Used to lock the
 * client out of the workspace the moment a trial expires (status "expired")
 * or an account is disabled.
 */
export function setHeartbeatObserver(cb: ((result: HeartbeatResult) => void) | null): void {
  heartbeatObserver = cb;
}

async function fetchAccountInfo(): Promise<AccountInfo | null> {
  try {
    const result = await serverGetAuthed<{
      email: string;
      firstName: string;
      lastName: string;
      role: string;
      orgName: string;
      orgSlug: string;
      tier: string;
      billingStatus: string;
    }>("/api/user/me");
    cachedAccount = result;
    return result;
  } catch {
    return null;
  }
}

/** Force a heartbeat check now (e.g. after returning from billing portal). */
export async function refreshHeartbeat(): Promise<HeartbeatResult | null> {
  return fetchHeartbeat();
}

// ── Server communication (Electron net for proxy support) ────

function serverPost<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const url = `${AUTH_SERVER}${endpoint}`;
    const data = JSON.stringify(body);
    const request = net.request({ url, method: "POST" });
    request.setHeader("Content-Type", "application/json");
    const timer = setTimeout(() => { request.abort(); reject(new Error("Request timeout")); }, 10_000);

    let responseBody = "";
    request.on("response", (response) => {
      const status = response.statusCode ?? 500;
      clearTimeout(timer);
      response.on("data", (chunk) => { responseBody += chunk.toString(); });
      response.on("end", () => {
        // Note: unauthed POST (login/refresh/device-exchange). A 401 here does
        // NOT pop the login gate — the refresh flow decides re-login itself, so
        // a transient 401 can't bounce the user.
        if (status < 200 || status >= 300) {
          reject(new Error(`HTTP ${status}: ${responseBody.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(responseBody) as T);
        } catch {
          reject(new Error("Invalid server response"));
        }
      });
    });
    request.on("error", reject);
    request.write(data);
    request.end();
  });
}

export function serverGetAuthed<T>(endpoint: string): Promise<T> {
  const token = getAuthToken();
  if (!token) { void refreshTokens(); return Promise.reject(new Error("Not authenticated")); }

  return new Promise((resolve, reject) => {
    const url = `${AUTH_SERVER}${endpoint}`;
    const request = net.request({ url, method: "GET" });
    request.setHeader("Authorization", `Bearer ${token}`);
    const timer = setTimeout(() => { request.abort(); reject(new Error("Request timeout")); }, 10_000);

    let responseBody = "";
    request.on("response", (response) => {
      const status = response.statusCode ?? 500;
      clearTimeout(timer);
      response.on("data", (chunk) => { responseBody += chunk.toString(); });
      response.on("end", () => {
        if (status === 401) void refreshTokens();   // try a refresh first; only a failed refresh re-logs-in
        if (status < 200 || status >= 300) {
          reject(new Error(`HTTP ${status}: ${responseBody.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(responseBody) as T);
        } catch {
          reject(new Error("Invalid server response"));
        }
      });
    });
    request.on("error", reject);
    request.end();
  });
}

export function serverDeleteAuthed<T>(endpoint: string): Promise<T> {
  const token = getAuthToken();
  if (!token) { void refreshTokens(); return Promise.reject(new Error("Not authenticated")); }

  return new Promise((resolve, reject) => {
    const url = `${AUTH_SERVER}${endpoint}`;
    const request = net.request({ url, method: "DELETE" });
    request.setHeader("Authorization", `Bearer ${token}`);
    const timer = setTimeout(() => { request.abort(); reject(new Error("Request timeout")); }, 10_000);

    let responseBody = "";
    request.on("response", (response) => {
      const status = response.statusCode ?? 500;
      clearTimeout(timer);
      response.on("data", (chunk) => { responseBody += chunk.toString(); });
      response.on("end", () => {
        if (status === 401) void refreshTokens();   // try a refresh first; only a failed refresh re-logs-in
        if (status < 200 || status >= 300) {
          reject(new Error(`HTTP ${status}: ${responseBody.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(responseBody) as T);
        } catch {
          reject(new Error("Invalid server response"));
        }
      });
    });
    request.on("error", reject);
    request.end();
  });
}

export function serverPostAuthed<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  const token = getAuthToken();
  if (!token) { void refreshTokens(); return Promise.reject(new Error("Not authenticated")); }

  return new Promise((resolve, reject) => {
    const url = `${AUTH_SERVER}${endpoint}`;
    const data = JSON.stringify(body);
    const request = net.request({ url, method: "POST" });
    request.setHeader("Content-Type", "application/json");
    request.setHeader("Authorization", `Bearer ${token}`);
    const timer = setTimeout(() => { request.abort(); reject(new Error("Request timeout")); }, 10_000);

    let responseBody = "";
    request.on("response", (response) => {
      const status = response.statusCode ?? 500;
      clearTimeout(timer);
      response.on("data", (chunk) => { responseBody += chunk.toString(); });
      response.on("end", () => {
        if (status === 401) void refreshTokens();   // try a refresh first; only a failed refresh re-logs-in
        if (status < 200 || status >= 300) {
          reject(new Error(`HTTP ${status}: ${responseBody.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(responseBody) as T);
        } catch {
          reject(new Error("Invalid server response"));
        }
      });
    });
    request.on("error", reject);
    request.write(data);
    request.end();
  });
}

// ── API key storage (use llm-config.ts secureWrite/secureRead) ──
// Legacy plaintext saveApiKey/loadApiKey removed — all API key
// storage now goes through llm-config.ts which uses safeStorage.

// validateApiKey removed — use validateLLMConfig from llm-config.ts
