/**
 * Perplexity adapter — Sonar via the proxy. Returns 503 until PPLX_API_KEY
 * is set on yo-server.
 */

import type {
  AgentAdapter, AdapterTurnRequest, AdapterTurnSink, LLMProvider,
} from "./agent-adapter";
import { runProxyStream } from "./proxy-client";

export class PerplexityAdapter implements AgentAdapter {
  readonly provider: LLMProvider = "perplexity";
  async run(req: AdapterTurnRequest, sink: AdapterTurnSink, signal?: AbortSignal): Promise<string> {
    const model = req.model || "sonar-pro";
    return runProxyStream("perplexity", { ...req, model }, sink, signal);
  }
}
