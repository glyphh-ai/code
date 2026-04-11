/**
 * License — 14-day trial + license key validation.
 *
 * Trial: first-launch date stored locally. No server needed.
 * License: key entered after trial, validated against a simple hash.
 */

import fs from "fs";
import path from "path";
import os from "os";

const CONFIG_DIR = path.join(os.homedir(), "yo");
const LICENSE_FILE = path.join(CONFIG_DIR, ".license");
const TRIAL_DAYS = 14;

interface LicenseState {
  status: "trial" | "licensed" | "expired";
  daysRemaining?: number;
  key?: string;
}

export function checkLicense(): LicenseState {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  // Check for license key
  if (fs.existsSync(LICENSE_FILE)) {
    const data = JSON.parse(fs.readFileSync(LICENSE_FILE, "utf-8"));
    if (data.key && validateKey(data.key)) {
      return { status: "licensed", key: data.key };
    }
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

export function activateLicense(key: string): boolean {
  if (!validateKey(key)) return false;
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(
    LICENSE_FILE,
    JSON.stringify({ key, activated: Date.now() }),
    "utf-8"
  );
  return true;
}

// Dev key — hash so it's not plaintext in the binary
const DEV_KEY_HASH = "4ca7e4e4"; // hash of YO-DEV-GLYPHH-2026

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

function validateKey(key: string): boolean {
  // Dev key — internal use only
  if (simpleHash(key) === DEV_KEY_HASH) return true;
  // TODO: real validation against Stripe license keys
  return key.startsWith("YO-") && key.length >= 12;
}

// ── API key storage ─────��────────────────────────────────

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
