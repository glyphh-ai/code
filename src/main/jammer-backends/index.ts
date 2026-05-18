/**
 * Jammer backend registry — picks the agent-loop backend for a jammer.
 */

import type { AgentConfig, JammerBackend } from "./types";
import { ClaudeBackend } from "./claude-backend";

export * from "./types";

/**
 * Pick the agent-loop backend for a jammer, keyed on `config.modelProvider`
 * (sourced from the agent registry's `model_provider`).
 *
 * Phase 1: routing is live, but only the Claude backend exists — "openai" and
 * "google" fall back to Claude with a warning until CodexBackend (Phase 2) and
 * GeminiBackend (Phase 3) land. At that point this switch gains those cases
 * and the fallback becomes a true unknown-provider guard.
 */
export function selectBackend(config: AgentConfig): JammerBackend {
  const provider = (config.modelProvider || "anthropic").toLowerCase();
  switch (provider) {
    case "anthropic":
      return new ClaudeBackend();
    // Phase 2: case "openai" → new CodexBackend();
    // Phase 3: case "google" → new GeminiBackend();
    default:
      console.warn(
        `[jammer-backends] provider "${provider}" has no backend yet — running this jammer on Claude`,
      );
      return new ClaudeBackend();
  }
}
