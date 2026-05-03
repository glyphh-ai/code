/**
 * OpenAI adapter — GPT / Codex via the proxy. Returns 503 from the proxy
 * until OPENAI_API_KEY is set on yo-server.
 */

import type {
  AgentAdapter, AdapterTurnRequest, AdapterTurnSink, LLMProvider,
} from "./agent-adapter";
import { runProxyStream } from "./proxy-client";

export class OpenAIAdapter implements AgentAdapter {
  readonly provider: LLMProvider = "openai";
  async run(req: AdapterTurnRequest, sink: AdapterTurnSink, signal?: AbortSignal): Promise<string> {
    const model = req.model || "gpt-5";
    return runProxyStream("openai", { ...req, model }, sink, signal);
  }
}
