/**
 * AgentAdapter — provider-agnostic interface for running an agent turn.
 *
 * Phase 3.5 model: every LLM call routes through the yo-server LLM proxy.
 * Clients never BYO key. Adapters are thin shims over POST /api/llm/proxy
 * with provider-specific message shaping (system prompt placement, model
 * defaults, role mapping). The proxy meters tokens and debits yos —
 * adapters don't track usage themselves.
 *
 * Workers (cypher participants doing real work) default to the Claude SDK
 * path through ClaudeSDKAdapter (still talks to the proxy) for tool-loop
 * coverage. Council jammers and one-shot adapters use the simpler
 * proxy-direct adapters: ClaudeMsgAdapter, OpenAIAdapter, GeminiAdapter,
 * XAIAdapter, PerplexityAdapter.
 */

export type LLMProvider = "anthropic" | "openai" | "google" | "xai" | "perplexity";

export interface AdapterMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface AdapterTurnRequest {
  /** Full conversation including the new user message at the end. */
  messages: AdapterMessage[];
  /** Provider-specific model id (e.g. "claude-opus-4-7", "gpt-5", "gemini-2.5-pro"). */
  model: string;
  /** Optional cap on output tokens. Provider-specific clamps apply server-side. */
  maxTokens?: number;
  /** When set, the proxy settles usage against this cypher's kitty. */
  cypherId?: string;
  /** Optional jam_id when cypherId is set. */
  jamId?: string;
  /** The agent_local_id of the calling jammer (for cypher attribution). */
  byAgentId?: string;
}

export interface AdapterTurnSink {
  /** Streamed text chunk. */
  onText?(delta: string): void;
  /** Final usage info, fired once at end. */
  onUsage?(usage: { input_tokens: number; output_tokens: number; yos_amount: number }): void;
  /** Provider error message (terminal). */
  onError?(message: string, code?: string): void;
}

export interface AgentAdapter {
  readonly provider: LLMProvider;
  /** Run one turn. Returns the full text response. Streams deltas through sink. */
  run(req: AdapterTurnRequest, sink: AdapterTurnSink, signal?: AbortSignal): Promise<string>;
}

/** Top-level error thrown when the proxy says the provider isn't configured. */
export class ProviderNotConfiguredError extends Error {
  constructor(public provider: LLMProvider) {
    super(`provider "${provider}" not configured on yo-server`);
    this.name = "ProviderNotConfiguredError";
  }
}
