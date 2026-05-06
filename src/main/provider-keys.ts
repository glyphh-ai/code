/**
 * provider-keys — local store for user-supplied LLM provider API keys.
 *
 * Phase 1 of THE-PIVOT-BYOK. Keys live encrypted at ~/yo/.providers.json
 * via Electron's safeStorage. Never sent to yo-server, never logged.
 *
 * Wire format on disk:
 *   { "<provider>": { "encryptedKey": "<base64>", "savedAt": "<iso>",
 *                     "lastTested": "<iso?>", "lastTestOk": <bool?> } }
 *
 * The renderer can ask `list()` for status (configured / not / invalid)
 * but `get()` returns the plaintext key only inside the main process —
 * never exposed via IPC. Only the adapters that actually need the key
 * to call a provider should call `getKey()`.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { safeStorage } from "electron";

export type ProviderId = "anthropic" | "openai" | "google" | "xai" | "perplexity";

export const PROVIDER_IDS: ProviderId[] = ["anthropic", "openai", "google", "xai", "perplexity"];

interface StoredEntry {
  encryptedKey: string;       // base64 of safeStorage-encrypted bytes
  savedAt: string;            // ISO timestamp
  lastTested?: string;        // ISO timestamp of last connectivity test
  lastTestOk?: boolean;       // outcome of last test
  lastTestError?: string;     // truncated error from the last failed test
}

type Store = Partial<Record<ProviderId, StoredEntry>>;

export interface ProviderStatus {
  provider: ProviderId;
  configured: boolean;
  savedAt: string | null;
  lastTested: string | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
}

const CONFIG_DIR = path.join(os.homedir(), "yo");
const STORE_PATH = path.join(CONFIG_DIR, ".providers.json");

function readStore(): Store {
  try {
    if (!fs.existsSync(STORE_PATH)) return {};
    const raw = fs.readFileSync(STORE_PATH, "utf-8");
    return JSON.parse(raw) as Store;
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), { mode: 0o600 });
  // Re-chmod in case the file pre-existed with looser perms
  try { fs.chmodSync(STORE_PATH, 0o600); } catch { /* best-effort */ }
}

function isValidProvider(p: string): p is ProviderId {
  return (PROVIDER_IDS as string[]).includes(p);
}

/** Save a provider key. Encrypts before persisting; never writes plaintext. */
export function setKey(provider: ProviderId, plaintextKey: string): void {
  if (!isValidProvider(provider)) throw new Error(`unknown provider: ${provider}`);
  const trimmed = plaintextKey.trim();
  if (!trimmed) throw new Error("key cannot be empty");
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("OS keychain unavailable — cannot store provider keys securely");
  }
  const encrypted = safeStorage.encryptString(trimmed).toString("base64");
  const store = readStore();
  store[provider] = {
    encryptedKey: encrypted,
    savedAt: new Date().toISOString(),
  };
  writeStore(store);
}

/** Returns the plaintext key for use by an adapter. Main-process only. */
export function getKey(provider: ProviderId): string | null {
  if (!isValidProvider(provider)) return null;
  const entry = readStore()[provider];
  if (!entry) return null;
  try {
    return safeStorage.decryptString(Buffer.from(entry.encryptedKey, "base64"));
  } catch {
    return null;
  }
}

export function hasKey(provider: ProviderId): boolean {
  return getKey(provider) !== null;
}

export function removeKey(provider: ProviderId): void {
  if (!isValidProvider(provider)) return;
  const store = readStore();
  delete store[provider];
  writeStore(store);
}

/** Status for the renderer. Never includes the key value itself. */
export function listStatus(): ProviderStatus[] {
  const store = readStore();
  return PROVIDER_IDS.map((provider) => {
    const entry = store[provider];
    return {
      provider,
      configured: !!entry,
      savedAt: entry?.savedAt ?? null,
      lastTested: entry?.lastTested ?? null,
      lastTestOk: entry?.lastTestOk ?? null,
      lastTestError: entry?.lastTestError ?? null,
    };
  });
}

/** Record the outcome of a connectivity test (called by `testKey`). */
function recordTestResult(provider: ProviderId, ok: boolean, errorMessage?: string): void {
  const store = readStore();
  const entry = store[provider];
  if (!entry) return;
  entry.lastTested = new Date().toISOString();
  entry.lastTestOk = ok;
  entry.lastTestError = ok ? undefined : (errorMessage ?? "unknown error").slice(0, 200);
  store[provider] = entry;
  writeStore(store);
}

/**
 * Fire a 1-token / minimal-cost test against the provider. Returns
 * `{ ok: true }` on a clean response; `{ ok: false, error }` otherwise.
 * Doesn't persist the key — only updates the lastTested marker.
 */
export async function testKey(provider: ProviderId): Promise<{ ok: boolean; error?: string }> {
  if (!isValidProvider(provider)) return { ok: false, error: "unknown provider" };
  const key = getKey(provider);
  if (!key) return { ok: false, error: "no key configured" };

  try {
    const ok = await runProviderHealthCheck(provider, key);
    recordTestResult(provider, true);
    return { ok };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "test failed";
    recordTestResult(provider, false, msg);
    return { ok: false, error: msg };
  }
}

/**
 * Cheapest possible "is this key live" call per provider. Uses HEAD/GET
 * against the provider's models-list or equivalent endpoint where
 * available; falls back to a 1-token completion when no listing is
 * exposed. Implementation lives here (not in adapters) so Phase 1 ships
 * without bundling provider SDKs — that work belongs to Phase 3.
 */
async function runProviderHealthCheck(provider: ProviderId, key: string): Promise<true> {
  const timeoutMs = 10_000;

  if (provider === "anthropic") {
    // Claude /v1/models requires the same key + version header as inference.
    await fetchOk("https://api.anthropic.com/v1/models?limit=1", {
      method: "GET",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    }, timeoutMs);
    return true;
  }
  if (provider === "openai") {
    await fetchOk("https://api.openai.com/v1/models", {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
    }, timeoutMs);
    return true;
  }
  if (provider === "google") {
    await fetchOk(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=1`,
      { method: "GET" },
      timeoutMs,
    );
    return true;
  }
  if (provider === "xai") {
    await fetchOk("https://api.x.ai/v1/models", {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
    }, timeoutMs);
    return true;
  }
  if (provider === "perplexity") {
    // Perplexity has no models endpoint; do a near-empty completion.
    await fetchOk("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "sonar",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
    }, timeoutMs);
    return true;
  }
  throw new Error(`no health check defined for ${provider}`);
}

async function fetchOk(url: string, init: RequestInit, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: controller.signal });
    if (!r.ok) {
      let detail = "";
      try { detail = (await r.text()).slice(0, 200); } catch { /* ignore */ }
      throw new Error(`HTTP ${r.status}${detail ? `: ${detail}` : ""}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
