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
import { net } from "electron";

const CONFIG_DIR = path.join(os.homedir(), "yo");
const LICENSE_FILE = path.join(CONFIG_DIR, ".license");
const TRIAL_DAYS = 14;

const LICENSE_SERVER =
  process.env.YO_LICENSE_SERVER || "https://yo.yo.dev";

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
  if (!fs.existsSync(LICENSE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(LICENSE_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function saveLicense(key: string, serverValidated: boolean = false, tier?: string): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const data: LicenseFileData = { key, activated: Date.now(), serverValidated };
  if (tier) data.tier = tier;
  fs.writeFileSync(LICENSE_FILE, JSON.stringify(data), "utf-8");
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
      // Set cloudToken for cloud sync (basic+ tiers)
      if (result.tier && result.tier !== "free") {
        const { setPreference } = await import("./preferences.js");
        setPreference("cloudToken", key);
      }
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
      // Update cloudToken if tier supports sync
      if (result.tier && result.tier !== "free") {
        const { setPreference } = await import("./preferences.js");
        setPreference("cloudToken", data.key);
      }
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

    let responseBody = "";
    request.on("response", (response) => {
      response.on("data", (chunk) => { responseBody += chunk.toString(); });
      response.on("end", () => {
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

    let responseBody = "";
    request.on("response", (response) => {
      response.on("data", (chunk) => { responseBody += chunk.toString(); });
      response.on("end", () => {
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

// ── API key storage ──────────────────────────────────────────

const API_KEY_FILE = path.join(CONFIG_DIR, ".apikey");

export function saveApiKey(key: string): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(API_KEY_FILE, key, "utf-8");
}

export function loadApiKey(): string | null {
  if (!fs.existsSync(API_KEY_FILE)) return null;
  const key = fs.readFileSync(API_KEY_FILE, "utf-8").trim();
  return key || null;
}

export async function validateApiKey(key: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: key });
    await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 16,
      messages: [{ role: "user", content: "Say ok" }],
    });
    return { valid: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    if (msg.includes("401") || msg.includes("authentication") || msg.includes("invalid")) {
      return { valid: false, error: "Invalid API key" };
    }
    return { valid: false, error: msg };
  }
}
