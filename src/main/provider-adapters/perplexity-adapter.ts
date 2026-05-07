/**
 * Perplexity adapter — Sonar via the user's BYOK key. Throws
 * ProviderNotConfiguredError if no Perplexity key is saved.
 */

import type {
  AgentAdapter, AdapterTurnRequest, AdapterTurnSink, LLMProvider,
} from "./agent-adapter";
import { runByokStream } from "./byok-client";

export class PerplexityAdapter implements AgentAdapter {
  readonly provider: LLMProvider = "perplexity";
  async run(req: AdapterTurnRequest, sink: AdapterTurnSink, signal?: AbortSignal): Promise<string> {
    const model = req.model || "sonar-pro";
    return runByokStream("perplexity", { ...req, model }, sink, signal);
  }
}
