/**
 * Capability sync — registers this client with yo-server when the
 * "Offer Usage" toggle is on, withdraws when it's off, and re-publishes
 * periodically so the row's last_seen stays fresh.
 *
 * State lives in preferences:
 *   - capabilities.offerEnabled (bool) — user intent
 *   - capabilities.clientId    (uuid)  — owned by capability-collector
 */

import { collectCapabilities, getOrCreateClientId, type CapabilityReport } from "./capability-collector";
import { getPreference, setPreference } from "./preferences";
import { isAuthenticated, serverPostAuthed } from "./auth";

const PREF_ENABLED = "capabilities.offerEnabled";
const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 min — enough to keep `available` rows fresh against server's 5-min default

let refreshTimer: ReturnType<typeof setInterval> | null = null;
let lastReport: CapabilityReport | null = null;
let lastServerView: { derived_tier: string; available: boolean } | null = null;

interface RegisterResponse {
  ok: boolean;
  client_id: string;
  derived_tier: "premiere" | "standard" | "low";
  available: boolean;
  last_seen_at: string;
}

// ── Internal ────────────────────────────────────────────────

async function publish(available: boolean): Promise<RegisterResponse | null> {
  if (!isAuthenticated()) return null;
  try {
    const report = await collectCapabilities({ available });
    lastReport = report;
    const resp = await serverPostAuthed<RegisterResponse>("/api/capabilities/register", report as unknown as Record<string, unknown>);
    lastServerView = { derived_tier: resp.derived_tier, available: resp.available };
    return resp;
  } catch (err) {
    console.error("[capabilities] publish failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

async function withdraw(): Promise<boolean> {
  if (!isAuthenticated()) return false;
  try {
    await serverPostAuthed("/api/capabilities/withdraw", { client_id: getOrCreateClientId() });
    lastServerView = lastServerView ? { ...lastServerView, available: false } : null;
    return true;
  } catch (err) {
    console.error("[capabilities] withdraw failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

function startRefresh(): void {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    if (!getPreference<boolean>(PREF_ENABLED, false)) return;
    void publish(true);
  }, REFRESH_INTERVAL_MS);
}

function stopRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

// ── Public API ──────────────────────────────────────────────

/** Called from main.ts after auth is initialized. Resumes the loop if the user had it on. */
export async function initCapabilities(): Promise<void> {
  // Make sure we have a stable client_id even before the toggle is flipped.
  getOrCreateClientId();
  if (getPreference<boolean>(PREF_ENABLED, false)) {
    await publish(true);
    startRefresh();
  }
}

/** Wired to the renderer toggle. Returns the server's verdict so the UI can show derived_tier. */
export async function setOfferEnabled(enabled: boolean): Promise<{
  ok: boolean;
  enabled: boolean;
  derived_tier?: string;
  client_id?: string;
  error?: string;
}> {
  setPreference(PREF_ENABLED, enabled);

  if (enabled) {
    const resp = await publish(true);
    if (!resp) {
      return { ok: false, enabled, error: "Failed to register with yo-server" };
    }
    startRefresh();
    return {
      ok: true,
      enabled: true,
      derived_tier: resp.derived_tier,
      client_id: resp.client_id,
    };
  }

  stopRefresh();
  await withdraw();
  return { ok: true, enabled: false, client_id: getOrCreateClientId() };
}

/** Returns the most recently collected report + the server's tier verdict, for the UI. */
export async function getCapabilitiesStatus(): Promise<{
  enabled: boolean;
  client_id: string;
  derived_tier: string | null;
  report: CapabilityReport | null;
}> {
  const enabled = getPreference<boolean>(PREF_ENABLED, false);
  const client_id = getOrCreateClientId();
  // If the user is curious mid-session, refresh the report so `yo about` and the
  // settings panel show current numbers — but don't post if we're not enabled.
  const report = await collectCapabilities({ available: enabled }).catch(() => lastReport);
  return {
    enabled,
    client_id,
    derived_tier: lastServerView?.derived_tier ?? null,
    report,
  };
}

/** Stop background work — call on app shutdown. */
export function cleanupCapabilities(): void {
  stopRefresh();
}
