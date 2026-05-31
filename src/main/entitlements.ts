/**
 * Entitlements ��� all features unlocked.
 *
 * The only gate is yos balance, enforced server-side on LLM proxy calls.
 * These functions exist as no-op stubs so callers compile without changes
 * during the transition. They always return { allowed: true }.
 */

export type GateResult = { allowed: true } | { allowed: false; reason: string };

const ALLOWED: GateResult = { allowed: true };

export function canAddApp(_currentCount?: number): GateResult { return ALLOWED; }
export function canCreateSkill(_currentCount?: number): GateResult { return ALLOWED; }
export function canSaveLayout(_currentCount?: number): GateResult { return ALLOWED; }
export function canUseMcp(): GateResult { return ALLOWED; }
export function canUseSync(): GateResult { return ALLOWED; }
export function canUseVoice(): GateResult { return ALLOWED; }
export function canUseCustomDrips(): GateResult { return ALLOWED; }

/**
 * adaL cognitive substrate gate. Replaces ada's standalone REPL license check
 * with the yo server's heartbeat. Fail-open like the rest of this module: adaL
 * is on unless the server explicitly turns it off via the heartbeat
 * (`entitlements.adaL === false`) or the account is no longer active. A missing
 * heartbeat (offline / pre-first-poll) never blocks.
 */
export function canUseAdaL(): GateResult {
  try {
    const { getHeartbeatInfo } = require("./auth") as typeof import("./auth");
    const hb = getHeartbeatInfo();
    if (!hb) return ALLOWED;
    if (hb.status === "expired" || hb.status === "disabled")
      return { allowed: false, reason: "account inactive" };
    if (hb.entitlements && hb.entitlements.adaL === false)
      return { allowed: false, reason: "not included in your plan" };
    return ALLOWED;
  } catch {
    return ALLOWED;
  }
}

export function getCurrentLimits() {
  return {
    maxApps: 0,
    maxSkills: 0,
    maxLayouts: 0,
    mcp: true,
    customLayouts: true,
    customDrips: true,
    voice: true,
    sync: true,
  };
}
