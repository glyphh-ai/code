/**
 * Gemini (Google) adapter — Gemini Pro / Flash via the proxy. Returns 503
 * until GOOGLE_API_KEY is set on yo-server.
 */

import type {
  AgentAdapter, AdapterTurnRequest, AdapterTurnSink, LLMProvider,
} from "./agent-adapter";
import { runProxyStream } from "./proxy-client";

export class GeminiAdapter implements AgentAdapter {
  readonly provider: LLMProvider = "google";
  async run(req: AdapterTurnRequest, sink: AdapterTurnSink, signal?: AbortSignal): Promise<string> {
    const model = req.model || "gemini-2.5-pro";
    return runProxyStream("google", { ...req, model }, sink, signal);
  }
}
