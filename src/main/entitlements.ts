/**
 * Client-side entitlement enforcement.
 *
 * Mirrors the server's tier limits. The heartbeat provides the authoritative
 * tier; this module gates local operations (add app, create skill, etc.).
 * Internal yo:// apps are excluded from the app count.
 */

import { getHeartbeatInfo } from "./auth.js";

type Tier = "free" | "basic" | "advanced";

export interface Limits {
  maxApps: number;       // 0 = unlimited
  maxSkills: number;
  maxLayouts: number;
  mcp: boolean;
  customLayouts: boolean;
  customDrips: boolean;
  voice: boolean;
  sync: boolean;
}

const TIER_LIMITS: Record<Tier, Limits> = {
  free: {
    maxApps: 10,
    maxSkills: 5,
    maxLayouts: 5,
    mcp: false,
    customLayouts: false,
    customDrips: false,
    voice: false,
    sync: false,
  },
  basic: {
    maxApps: 0,
    maxSkills: 0,
    maxLayouts: 0,
    mcp: false,
    customLayouts: true,
    customDrips: true,
    voice: false,
    sync: false,
  },
  advanced: {
    maxApps: 0,
    maxSkills: 0,
    maxLayouts: 0,
    mcp: true,
    customLayouts: true,
    customDrips: true,
    voice: true,
    sync: true,
  },
};

export function getLimits(tier?: string): Limits {
  return TIER_LIMITS[(tier as Tier)] || TIER_LIMITS.free;
}

export function getCurrentTier(): Tier {
  const hb = getHeartbeatInfo();
  return (hb?.tier as Tier) || "free";
}

export function getCurrentLimits(): Limits {
  return getLimits(getCurrentTier());
}

export type GateResult = { allowed: true } | { allowed: false; reason: string };

export function canAddApp(currentCount: number): GateResult {
  const limits = getCurrentLimits();
  if (limits.maxApps === 0) return { allowed: true };
  if (currentCount >= limits.maxApps) {
    return { allowed: false, reason: `Free plan allows ${limits.maxApps} apps. Upgrade to add more.` };
  }
  return { allowed: true };
}

export function canCreateSkill(currentCount: number): GateResult {
  const limits = getCurrentLimits();
  if (limits.maxSkills === 0) return { allowed: true };
  if (currentCount >= limits.maxSkills) {
    return { allowed: false, reason: `Free plan allows ${limits.maxSkills} skills. Upgrade to add more.` };
  }
  return { allowed: true };
}

export function canSaveLayout(currentCount: number): GateResult {
  const limits = getCurrentLimits();
  if (limits.maxLayouts === 0) return { allowed: true };
  if (currentCount >= limits.maxLayouts) {
    return { allowed: false, reason: `Free plan allows ${limits.maxLayouts} layouts. Upgrade to add more.` };
  }
  return { allowed: true };
}

export function canUseMcp(): GateResult {
  if (!getCurrentLimits().mcp) {
    return { allowed: false, reason: "MCP servers require the Advanced plan." };
  }
  return { allowed: true };
}

export function canUseSync(): GateResult {
  if (!getCurrentLimits().sync) {
    return { allowed: false, reason: "Cloud sync requires the Advanced plan." };
  }
  return { allowed: true };
}

export function canUseVoice(): GateResult {
  if (!getCurrentLimits().voice) {
    return { allowed: false, reason: "Voice requires the Advanced plan." };
  }
  return { allowed: true };
}

export function canUseCustomDrips(): GateResult {
  if (!getCurrentLimits().customDrips) {
    return { allowed: false, reason: "Custom drips require the Basic plan or higher." };
  }
  return { allowed: true };
}
