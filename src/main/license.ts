/**
 * License — 14-day trial + Stripe-backed license key validation.
 *
 * Trial: first-launch date stored locally. No server needed.
 * License: key activated against yo-server with machine fingerprint binding.
 */

import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { execSync } from "child_process";
import { net, safeStorage } from "electron";

const CONFIG_DIR = path.join(os.homedir(), "yo");
const LICENSE_FILE = path.join(CONFIG_DIR, ".license");
const SESSION_FILE = path.join(CONFIG_DIR, ".session");
const TRIAL_DAYS = 14;
const REFRESH_MARGIN = 3 * 60 * 1000; // refresh 3 min before expiry

const LICENSE_SERVER =
  process.env.YO_LICENSE_SERVER || "https://api.dotyo.dev";

interface LicenseState {
  status: "trial" | "licensed" | "expired";
  daysRemaining?: number;
  key?: string;
  tier?: string;
}

interface LicenseFileData {
  key: string;
  activated: number;
  serverValidated?: boolean;
  tier?: string;
}

// ── Session (JWT) management ─────────────────────────────────

interface SessionData {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms timestamp
}

let currentSession: SessionData | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function secureWriteLicense(filePath: string, data: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(data);
    fs.writeFileSync(filePath, encrypted, { mode: 0o600 });
  } else {
    fs.writeFileSync(filePath, data, { encoding: "utf-8", mode: 0o600 });
  }
}

function secureReadLicense(filePath: string): string | null {
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

function readSessionFile(): SessionData | null {
  const data = secureReadLicense(SESSION_FILE);
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function saveSessionFile(session: SessionData): void {
  secureWriteLicense(SESSION_FILE, JSON.stringify(session));
  currentSession = session;
  scheduleRefresh(session);
}

function clearSessionFile(): void {
  currentSession = null;
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
  try { fs.unlinkSync(SESSION_FILE); } catch { /* ignore */ }
}

/** Clear all pending timers — call on app shutdown. */
export function cleanupLicenseTimers(): void {
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
}

function scheduleRefresh(session: SessionData): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  const delay = Math.max(0, session.expiresAt - Date.now() - REFRESH_MARGIN);
  refreshTimer = setTimeout(() => { void refreshSessionTokens(); }, delay);
}

async function refreshSessionTokens(): Promise<boolean> {
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
    clearSessionFile();
    return false;
  } catch {
    // Network error — keep existing session if still valid, retry soon
    if (currentSession && currentSession.expiresAt > Date.now()) {
      setTimeout(() => { void refreshSessionTokens(); }, 30_000);
      return true;
    }
    clearSessionFile();
    return false;
  }
}

async function createSessionTokens(): Promise<boolean> {
  const data = readLicenseFile();
  if (!data?.key) return false;
  if (validateDevKey(data.key)) return false; // dev keys don't use sessions

  const machineId = getMachineFingerprint();

  try {
    const result = await serverPost<{
      ok: boolean;
      accessToken?: string;
      refreshToken?: string;
      expiresIn?: number;
      error?: string;
    }>("/api/session", { key: data.key, machineId });

    if (result.ok && result.accessToken && result.refreshToken && result.expiresIn) {
      saveSessionFile({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: Date.now() + result.expiresIn * 1000,
      });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Get current auth token — prefers JWT session, falls back to license key. */
function getAuthToken(): string | null {
  if (currentSession && currentSession.expiresAt > Date.now()) {
    return currentSession.accessToken;
  }
  // Fallback to license key (server still accepts it)
  const data = readLicenseFile();
  return data?.key || null;
}

/** Initialize session — call on app startup after license check. */
export async function initSession(): Promise<void> {
  const saved = readSessionFile();
  if (saved) {
    currentSession = saved;
    if (saved.expiresAt - Date.now() < REFRESH_MARGIN) {
      await refreshSessionTokens();
    } else {
      scheduleRefresh(saved);
    }
  } else {
    await createSessionTokens();
  }
}

// ── Machine fingerprint ──────────────────────────────────────

function getMachineFingerprint(): string {
  const parts: string[] = [os.hostname()];

  // MAC address
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets)) {
    if (!iface) continue;
    for (const info of iface) {
      if (!info.internal && info.mac && info.mac !== "00:00:00:00:00:00") {
        parts.push(info.mac);
        break;
      }
    }
    if (parts.length > 1) break;
  }

  // OS serial (macOS only, fallback gracefully)
  if (process.platform === "darwin") {
    try {
      const serial = execSync(
        "ioreg -rd1 -c IOPlatformExpertDevice | awk '/IOPlatformSerialNumber/ {print $NF}'",
        { encoding: "utf-8" },
      ).trim().replace(/"/g, "");
      if (serial) parts.push(serial);
    } catch { /* ignore */ }
  }

  return crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
}

// ── License file helpers ─────────────────────────────────────

function readLicenseFile(): LicenseFileData | null {
  const data = secureReadLicense(LICENSE_FILE);
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function saveLicense(key: string, serverValidated: boolean = false, tier?: string): void {
  const data: LicenseFileData = { key, activated: Date.now(), serverValidated };
  if (tier) data.tier = tier;
  secureWriteLicense(LICENSE_FILE, JSON.stringify(data));
}

// ── License check ────────────────────────────────────────────

export function checkLicense(): LicenseState {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  // Check for license key
  const data = readLicenseFile();
  if (data?.key && validateKeyLocal(data.key)) {
    // Dev keys and server-validated keys are trusted
    if (validateDevKey(data.key) || data.serverValidated) {
      return { status: "licensed", key: data.key, tier: data.tier || "basic" };
    }
    // Key exists but was never validated by server — treat as unlicensed
  }

  // Check trial
  const trialFile = path.join(CONFIG_DIR, ".trial");
  let firstLaunch: number;

  if (fs.existsSync(trialFile)) {
    firstLaunch = parseInt(fs.readFileSync(trialFile, "utf-8"), 10);
  } else {
    firstLaunch = Date.now();
    fs.writeFileSync(trialFile, firstLaunch.toString(), "utf-8");
  }

  const elapsed = Date.now() - firstLaunch;
  const daysUsed = Math.floor(elapsed / (1000 * 60 * 60 * 24));
  const remaining = TRIAL_DAYS - daysUsed;

  if (remaining <= 0) {
    return { status: "expired", daysRemaining: 0 };
  }

  return { status: "trial", daysRemaining: remaining };
}

// ── Activate license (server-side) ───────────────────────────

export async function activateLicense(key: string): Promise<boolean> {
  // Dev key — local-only fast path
  if (validateDevKey(key)) {
    saveLicense(key, true);
    return true;
  }

  // Basic format check before hitting server
  if (!key.startsWith("YO-") || key.length < 12) return false;

  const machineId = getMachineFingerprint();

  try {
    const result = await serverPost<{ ok: boolean; tier?: string; error?: string }>(
      "/api/license/activate",
      { key, machineId },
    );
    if (result.ok) {
      saveLicense(key, true, result.tier);
      // Set cloudToken for cloud sync
      const { setPreference } = await import("./preferences.js");
      setPreference("cloudToken", key);
      // Swap license key for a machine-bound JWT session
      await createSessionTokens();
      return true;
    }
    console.error("License activation failed:", result.error);
    return false;
  } catch (err) {
    console.error("License server unreachable");
    // Only allow offline if this key was previously validated by the server
    const existing = readLicenseFile();
    if (existing && existing.key === key && existing.serverValidated) {
      return true;
    }
    return false;
  }
}

// ── Periodic revalidation ────────────────────────────────────

export async function revalidateLicense(): Promise<boolean> {
  const data = readLicenseFile();
  if (!data?.key) return false;
  if (validateDevKey(data.key)) return true;

  const machineId = getMachineFingerprint();

  try {
    const result = await serverPost<{ valid: boolean; tier?: string; error?: string }>(
      "/api/license/validate",
      { key: data.key, machineId },
    );
    if (result.valid) {
      // Refresh serverValidated flag + tier
      saveLicense(data.key, true, result.tier);
      // Update cloudToken for cloud sync
      const { setPreference } = await import("./preferences.js");
      setPreference("cloudToken", data.key);
      return true;
    }
    // Server says invalid — clear serverValidated
    saveLicense(data.key, false, data.tier);
    return false;
  } catch {
    // Offline — only trust if previously server-validated
    return data.serverValidated === true;
  }
}

// ── Checkout URL ─────────────────────────────────────────────

export async function getCheckoutUrl(plan: string = "basic"): Promise<string | null> {
  try {
    const data = readLicenseFile();
    const keyParam = data?.key ? `&key=${encodeURIComponent(data.key)}` : "";
    const result = await serverGet<{ url: string }>(`/api/checkout/url?plan=${plan}${keyParam}`);
    return result.url;
  } catch {
    return null;
  }
}

// ── Billing portal (Stripe customer portal for manage/cancel) ──

export async function getBillingPortalUrl(): Promise<string | null> {
  try {
    const data = readLicenseFile();
    if (!data?.key) return null;
    const result = await serverGet<{ url: string }>(
      `/api/billing/portal?key=${encodeURIComponent(data.key)}`,
    );
    return result.url;
  } catch {
    return null;
  }
}

// ── Support ticket ───────────────────────────────────────────

export async function submitSupportTicket(ticket: {
  subject: string;
  description: string;
  appVersion: string;
  os: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const data = readLicenseFile();
    const licenseKey = data?.key || undefined;
    const tier = data?.tier || undefined;
    return await serverPost<{ ok: boolean; error?: string }>(
      "/api/support/ticket",
      { ...ticket, licenseKey, tier },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

// ── Dev key ──────────────────────────────────────────────────

const DEV_KEY_HASH = "4ca7e4e4";

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

function validateDevKey(key: string): boolean {
  // Dev key only available in development builds
  if (process.env.NODE_ENV === "production") return false;
  return simpleHash(key) === DEV_KEY_HASH;
}

function validateKeyLocal(key: string): boolean {
  if (validateDevKey(key)) return true;
  return key.startsWith("YO-") && key.length >= 12;
}

// ── Server communication (uses Electron net for proxy support) ──

function serverPost<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const url = `${LICENSE_SERVER}${endpoint}`;
    const data = JSON.stringify(body);
    const request = net.request({
      url,
      method: "POST",
    });
    request.setHeader("Content-Type", "application/json");
    const timer = setTimeout(() => { request.abort(); reject(new Error("Request timeout")); }, 10_000);

    let responseBody = "";
    request.on("response", (response) => {
      const status = response.statusCode ?? 500;
      clearTimeout(timer);
      response.on("data", (chunk) => { responseBody += chunk.toString(); });
      response.on("end", () => {
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

function serverGet<T>(endpoint: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const url = `${LICENSE_SERVER}${endpoint}`;
    const request = net.request({ url, method: "GET" });
    const timer = setTimeout(() => { request.abort(); reject(new Error("Request timeout")); }, 10_000);

    let responseBody = "";
    request.on("response", (response) => {
      const status = response.statusCode ?? 500;
      clearTimeout(timer);
      response.on("data", (chunk) => { responseBody += chunk.toString(); });
      response.on("end", () => {
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

function serverPostAuthed<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  const token = getAuthToken();
  if (!token) return Promise.reject(new Error("Not authenticated"));

  return new Promise((resolve, reject) => {
    const url = `${LICENSE_SERVER}${endpoint}`;
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

function serverGetAuthed<T>(endpoint: string): Promise<T> {
  const token = getAuthToken();
  if (!token) return Promise.reject(new Error("Not authenticated"));

  return new Promise((resolve, reject) => {
    const url = `${LICENSE_SERVER}${endpoint}`;
    const request = net.request({ url, method: "GET" });
    request.setHeader("Authorization", `Bearer ${token}`);
    const timer = setTimeout(() => { request.abort(); reject(new Error("Request timeout")); }, 10_000);

    let responseBody = "";
    request.on("response", (response) => {
      const status = response.statusCode ?? 500;
      clearTimeout(timer);
      response.on("data", (chunk) => { responseBody += chunk.toString(); });
      response.on("end", () => {
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

// ── API key storage (use llm-config.ts secureWrite/secureRead) ──
// Legacy plaintext saveApiKey/loadApiKey removed — all API key
// storage now goes through llm-config.ts which uses safeStorage.

// validateApiKey removed — use validateLLMConfig from llm-config.ts
