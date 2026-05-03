/**
 * Claude (Anthropic) adapter — proxy-direct path for council jammers and
 * one-shot turns. Worker agents that need the full SDK tool loop should
 * use the existing yo-agent.ts / Claude Agent SDK path; that's a separate
 * runner and converges with this adapter at the proxy boundary.
 */

import type {
  AgentAdapter, AdapterTurnRequest, AdapterTurnSink, LLMProvider,
} from "./agent-adapter";
import { runProxyStream } from "./proxy-client";

export class ClaudeAdapter implements AgentAdapter {
  readonly provider: LLMProvider = "anthropic";
  async run(req: AdapterTurnRequest, sink: AdapterTurnSink, signal?: AbortSignal): Promise<string> {
    const model = req.model || "claude-sonnet-4-6";
    return runProxyStream("anthropic", { ...req, model }, sink, signal);
  }
}
