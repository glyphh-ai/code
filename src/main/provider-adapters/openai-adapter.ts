/**
 * OpenAI adapter — GPT / Codex via the user's BYOK key. Throws
 * ProviderNotConfiguredError if the user hasn't saved an OpenAI key
 * in Settings → Providers.
 */

import type {
  AgentAdapter, AdapterTurnRequest, AdapterTurnSink, LLMProvider,
} from "./agent-adapter";
import { runByokStream } from "./byok-client";

export class OpenAIAdapter implements AgentAdapter {
  readonly provider: LLMProvider = "openai";
  async run(req: AdapterTurnRequest, sink: AdapterTurnSink, signal?: AbortSignal): Promise<string> {
    const model = req.model || "gpt-5";
    return runByokStream("openai", { ...req, model }, sink, signal);
  }
}
