/**
 * AgentAdapter — provider-agnostic interface for running an agent turn.
 *
 * Post-BYOK model (Phase 3 of THE-PIVOT-BYOK): every adapter calls the
 * provider's HTTPS endpoint directly using the user's locally-stored
 * API key (Settings → Providers). yo-server never sees inference. The
 * old proxy path (POST /api/llm/proxy) is gone.
 *
 * Workers that need the full Claude tool loop use Claude Code as a
 * subprocess (see Phase 4). Council members and one-shot turns use the
 * simple direct adapters here: ClaudeAdapter, OpenAIAdapter,
 * GeminiAdapter, XAIAdapter, PerplexityAdapter.
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

/** Thrown when the user hasn't saved a key for this provider in Settings → Providers. */
export class ProviderNotConfiguredError extends Error {
  constructor(public provider: LLMProvider) {
    super(`provider "${provider}" not configured — add an API key in Settings → Providers`);
    this.name = "ProviderNotConfiguredError";
  }
}
