/**
 * Jammer backend registry — picks the agent-loop backend for a jammer.
 */

import type { AgentConfig, JammerBackend } from "./types";
import { ClaudeBackend } from "./claude-backend";

export * from "./types";

/**
 * Pick the agent-loop backend for a jammer.
 *
 * Phase 0: always Claude. Phase 1 branches on `config.modelProvider`
 * ("openai" → Codex, "google" → Gemini), defaulting to Claude.
 */
export function selectBackend(_config: AgentConfig): JammerBackend {
  return new ClaudeBackend();
}
