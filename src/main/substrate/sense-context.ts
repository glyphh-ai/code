/**
 * sense.context — snapshot of what's around the agent right now.
 *
 * Returned to every skill via ctx.substrate.context, so the agent
 * can reason about its surroundings without having to ask for them.
 */

import { ContextSnapshot } from "./types";

interface ContextDeps {
  getActivePanelId?: () => string | null;
  getAppName?: (panelId: string) => string | null;
  getRecentCaptures?: (limit: number) => Array<{ id: string; source: string; preview: string; at: number }>;
}

let deps: ContextDeps = {};

export function setContextDeps(d: ContextDeps): void { deps = { ...deps, ...d }; }

export function senseContext(opts?: {
  lastUserMessage?: string;
  focusedInputElementInfo?: ContextSnapshot["focusedInputElementInfo"];
}): ContextSnapshot {
  const activePanelId = deps.getActivePanelId?.() ?? null;
  const activeAppName = activePanelId ? deps.getAppName?.(activePanelId) ?? null : null;
  const recentCaptures = (deps.getRecentCaptures?.(5) ?? []).map((c) => ({
    id: c.id,
    source: c.source,
    preview: c.preview.slice(0, 200),
    at: c.at,
  }));
  return {
    activePanelId,
    activeAppName,
    focusedInputElementInfo: opts?.focusedInputElementInfo ?? null,
    recentCaptures,
    lastUserMessage: opts?.lastUserMessage,
  };
}
