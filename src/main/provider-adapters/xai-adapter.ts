/**
 * xAI adapter — Grok via the proxy. Returns 503 until XAI_API_KEY is set
 * on yo-server.
 */

import type {
  AgentAdapter, AdapterTurnRequest, AdapterTurnSink, LLMProvider,
} from "./agent-adapter";
import { runProxyStream } from "./proxy-client";

export class XAIAdapter implements AgentAdapter {
  readonly provider: LLMProvider = "xai";
  async run(req: AdapterTurnRequest, sink: AdapterTurnSink, signal?: AbortSignal): Promise<string> {
    const model = req.model || "grok-4";
    return runProxyStream("xai", { ...req, model }, sink, signal);
  }
}
