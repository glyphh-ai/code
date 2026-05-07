/**
 * Claude (Anthropic) adapter — direct-to-Anthropic via the user's BYOK key.
 * Used by Council members on Claude and any one-shot turn that doesn't
 * need the full Agent SDK tool loop. Agent-loop work uses Claude Code
 * directly (see Phase 4).
 */

import type {
  AgentAdapter, AdapterTurnRequest, AdapterTurnSink, LLMProvider,
} from "./agent-adapter";
import { runByokStream } from "./byok-client";

export class ClaudeAdapter implements AgentAdapter {
  readonly provider: LLMProvider = "anthropic";
  async run(req: AdapterTurnRequest, sink: AdapterTurnSink, signal?: AbortSignal): Promise<string> {
    const model = req.model || "claude-sonnet-4-6";
    return runByokStream("anthropic", { ...req, model }, sink, signal);
  }
}
