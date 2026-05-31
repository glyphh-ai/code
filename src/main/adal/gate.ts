/**
 * adaL activation gate — the single chokepoint that decides whether the
 * cognitive substrate is live for this account. Replaces ada's standalone REPL
 * license check; the verdict comes from the yo server's heartbeat
 * (entitlements.canUseAdaL). Fail-open: if the entitlements layer can't be
 * reached (e.g. a non-Electron test context), adaL stays on.
 *
 * Every adaL surface (agent loop, adaL_* tools, the REPL, the .ada runner, the
 * dream loop) consults adalEnabled() so a server-side downgrade takes effect
 * within one heartbeat without a restart.
 */

export const ADAL_DISABLED_MESSAGE =
  "adaL is not active on this account. The cognitive substrate is gated by your yo plan.";

export function adalEnabled(): boolean {
  try {
    const { canUseAdaL } = require("../entitlements") as typeof import("../entitlements");
    return canUseAdaL().allowed;
  } catch {
    return true;
  }
}
