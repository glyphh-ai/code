/**
 * cc-creds — detect whether the user has logged in to Claude Code.
 *
 * Phase 2 of THE-PIVOT-BYOK. Mirrors /yo/src/dotyo/lib/cc_creds.py.
 *
 * Claude Code stores credentials per-platform:
 *   • macOS: Keychain entry "Claude Code-credentials"
 *   • Linux / older: file at ~/.claude/.credentials.json (or .json without dot)
 *   • Windows: %APPDATA%\Claude\credentials.json
 *
 * We never read the contents — only detect existence. The Claude Agent
 * SDK pulls them itself when it actually fires.
 */

import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

export interface CcCredsResult {
  found: boolean;
  location: string | null;
  kind: "file" | "keychain" | null;
}

function fileCandidates(): string[] {
  const home = os.homedir();
  const paths = [
    path.join(home, ".claude", ".credentials.json"),
    path.join(home, ".claude", "credentials.json"),
    path.join(home, ".config", "claude", "credentials.json"),
  ];
  if (process.platform === "darwin") {
    paths.push(path.join(home, "Library", "Application Support", "Claude", "credentials.json"));
  } else if (process.platform === "win32") {
    const appdata = process.env.APPDATA;
    if (appdata) paths.push(path.join(appdata, "Claude", "credentials.json"));
  }
  return paths;
}

function checkMacosKeychain(): boolean {
  try {
    const r = spawnSync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials"],
      { encoding: "utf-8", timeout: 3000 },
    );
    return r.status === 0;
  } catch {
    return false;
  }
}

export function findCcCredentials(): CcCredsResult {
  for (const p of fileCandidates()) {
    if (fs.existsSync(p)) return { found: true, location: p, kind: "file" };
  }
  if (process.platform === "darwin" && checkMacosKeychain()) {
    return { found: true, location: "macOS Keychain (Claude Code-credentials)", kind: "keychain" };
  }
  return { found: false, location: null, kind: null };
}

/**
 * Resolve `claude` on PATH. Returns the absolute path or null if missing.
 * Used to surface "install Claude Code first" guidance when needed.
 */
export function findClaudeCli(): string | null {
  const cmd = process.platform === "win32" ? "where" : "which";
  try {
    const r = spawnSync(cmd, ["claude"], { encoding: "utf-8", timeout: 2000 });
    if (r.status !== 0) return null;
    const first = (r.stdout || "").trim().split(/\r?\n/)[0];
    return first || null;
  } catch {
    return null;
  }
}
