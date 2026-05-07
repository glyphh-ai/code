/**
 * Gemini (Google) adapter — Gemini Pro / Flash via the user's BYOK key.
 * Throws ProviderNotConfiguredError if no Google key is saved.
 */

import type {
  AgentAdapter, AdapterTurnRequest, AdapterTurnSink, LLMProvider,
} from "./agent-adapter";
import { runByokStream } from "./byok-client";

export class GeminiAdapter implements AgentAdapter {
  readonly provider: LLMProvider = "google";
  async run(req: AdapterTurnRequest, sink: AdapterTurnSink, signal?: AbortSignal): Promise<string> {
    const model = req.model || "gemini-2.5-pro";
    return runByokStream("google", { ...req, model }, sink, signal);
  }
}
