/**
 * xAI adapter — Grok via the user's BYOK key. Throws
 * ProviderNotConfiguredError if no xAI key is saved.
 */

import type {
  AgentAdapter, AdapterTurnRequest, AdapterTurnSink, LLMProvider,
} from "./agent-adapter";
import { runByokStream } from "./byok-client";

export class XAIAdapter implements AgentAdapter {
  readonly provider: LLMProvider = "xai";
  async run(req: AdapterTurnRequest, sink: AdapterTurnSink, signal?: AbortSignal): Promise<string> {
    const model = req.model || "grok-4";
    return runByokStream("xai", { ...req, model }, sink, signal);
  }
}
