/**
 * Adapter registry — provider → adapter instance, plus the cypher-runtime
 * dispatcher. The dispatcher is the prompt handler that gets installed in
 * cypher-runtime; when a `prompt` event arrives, it picks the adapter by
 * the jammer's configured provider/model and runs the turn.
 *
 * Provider/model per jammer is resolved from the local agent registry —
 * the `AgentDef.model_provider` + `AgentDef.model_name` fields set when
 * the agent was created. v1: if no provider set, default to anthropic.
 */

import type { AgentAdapter, AdapterTurnRequest, AdapterTurnSink, LLMProvider } from "./agent-adapter";
import { ClaudeAdapter } from "./claude-adapter";
import { OpenAIAdapter } from "./openai-adapter";
import { GeminiAdapter } from "./gemini-adapter";
import { XAIAdapter } from "./xai-adapter";
import { PerplexityAdapter } from "./perplexity-adapter";
import type {
  PromptHandler, CypherPromptEvent, AgentTurnResult,
} from "../cypher-runtime";

const adapters: Record<LLMProvider, AgentAdapter> = {
  anthropic: new ClaudeAdapter(),
  openai: new OpenAIAdapter(),
  google: new GeminiAdapter(),
  xai: new XAIAdapter(),
  perplexity: new PerplexityAdapter(),
};

const VALID: LLMProvider[] = ["anthropic", "openai", "google", "xai", "perplexity"];

export function getAdapter(provider: string): AgentAdapter {
  const p = (VALID as string[]).includes(provider) ? (provider as LLMProvider) : "anthropic";
  return adapters[p];
}

export function listAdapters(): LLMProvider[] {
  return VALID.slice();
}

/** Resolve the provider/model for a given local agent. v1: best-effort
 *  — if the AgentDef can't be loaded, fall back to anthropic / claude-sonnet-4-6. */
async function resolveAgentConfig(agentLocalId: string): Promise<{ provider: LLMProvider; model: string }> {
  try {
    const { getAgent } = await import("../agent-store");
    const def = getAgent(agentLocalId);
    if (def) {
      const provider = (VALID as string[]).includes(def.model_provider ?? "")
        ? (def.model_provider as LLMProvider)
        : "anthropic";
      const model = def.model_name?.trim() || (provider === "anthropic" ? "claude-sonnet-4-6" : "");
      return { provider, model };
    }
  } catch { /* fall through */ }
  return { provider: "anthropic", model: "claude-sonnet-4-6" };
}

/**
 * Dispatcher — install via setPromptHandler() in cypher-runtime. Looks up
 * the jammer's configured provider/model, calls the adapter, returns the
 * AgentTurnResult so cypher-runtime can post it as a `text` event +
 * (when usage is reported) a `usage` event for kitty settlement.
 *
 * Note: when the proxy is given a cypher_id, it posts the `usage` event
 * itself, so we don't double-post here. This dispatcher is invoked
 * server-events-side (handling incoming prompts) and server-driven settlement
 * happens via the proxy path. We return yos_used: 0 so the runtime doesn't
 * post a duplicate.
 */
export const adapterDispatcher: PromptHandler = async (
  event: CypherPromptEvent,
  byAgentId: string,
): Promise<AgentTurnResult | null> => {
  const { provider, model } = await resolveAgentConfig(byAgentId);
  const adapter = getAdapter(provider);

  const req: AdapterTurnRequest = {
    messages: [
      { role: "user", content: event.prompt },
    ],
    model,
    cypherId: event.cypherId,
    jamId: event.jamId ?? undefined,
    byAgentId,
  };

  let yosFromUsage = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  const sink: AdapterTurnSink = {
    onUsage: (u) => {
      yosFromUsage = u.yos_amount;
      inputTokens = u.input_tokens;
      outputTokens = u.output_tokens;
    },
    onError: (msg, code) => {
      console.warn(`[adapter-dispatch] ${provider}/${model} error (${code ?? "?"}): ${msg}`);
    },
  };

  try {
    const text = await adapter.run(req, sink);
    if (!text) return null;
    return {
      text,
      // Proxy already settled against the kitty when cypher_id was set, so
      // we report 0 here to prevent cypher-runtime from posting a second
      // `usage` event. Meta carries the actuals for downstream visibility.
      yos_used: 0,
      meta: {
        provider, model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        yos_metered: yosFromUsage,
      },
    };
  } catch (err) {
    console.warn(`[adapter-dispatch] ${provider}/${model} failed:`, err instanceof Error ? err.message : err);
    return null;
  }
};
