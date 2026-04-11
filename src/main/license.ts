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

function validateKey(key: string): boolean {
  // TODO: real validation against Stripe license keys
  // For now: any key starting with "YO-" is valid
  return key.startsWith("YO-") && key.length >= 12;
}
