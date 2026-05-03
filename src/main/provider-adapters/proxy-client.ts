/**
 * proxy-client — shared SSE consumer for POST /api/llm/proxy.
 *
 * Every simple-shape provider adapter (ClaudeMsgAdapter, OpenAIAdapter,
 * GeminiAdapter, XAIAdapter, PerplexityAdapter) wraps this. The adapter's
 * job is just to set the `provider` field and shape the messages array
 * the way the proxy expects.
 *
 * Streaming wire format (matches the SSE frames yo-server's llm-routes
 * sends): `event: text` (delta text), `event: usage` (token + yos info),
 * `event: error` (provider/configuration error), `event: done` (graceful
 * close), `event: settlement_error` (post-stream kitty/wallet failure).
 */

import { net } from "electron";
import { AUTH_SERVER, getAuthToken } from "../auth";
import {
  ProviderNotConfiguredError,
  type LLMProvider, type AdapterMessage, type AdapterTurnRequest, type AdapterTurnSink,
} from "./agent-adapter";

interface ProxyBody {
  provider: LLMProvider;
  model: string;
  messages: AdapterMessage[];
  max_tokens?: number;
  cypher_id?: string;
  jam_id?: string;
  by_agent_id?: string;
}

interface ParsedFrame {
  event: string;
  data: string;
}

function parseFrame(frame: string): ParsedFrame {
  const out: ParsedFrame = { event: "message", data: "" };
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") out.event = value;
    else if (field === "data") out.data = out.data ? out.data + "\n" + value : value;
  }
  return out;
}

export async function runProxyStream(
  provider: LLMProvider,
  req: AdapterTurnRequest,
  sink: AdapterTurnSink,
  signal?: AbortSignal,
): Promise<string> {
  const token = getAuthToken();
  if (!token) throw new Error("Not authenticated");

  const body: ProxyBody = {
    provider,
    model: req.model,
    messages: req.messages,
  };
  if (req.maxTokens != null) body.max_tokens = req.maxTokens;
  if (req.cypherId) body.cypher_id = req.cypherId;
  if (req.jamId) body.jam_id = req.jamId;
  if (req.byAgentId) body.by_agent_id = req.byAgentId;

  return new Promise<string>((resolve, reject) => {
    const url = `${AUTH_SERVER}/api/llm/proxy`;
    const request = net.request({ url, method: "POST" });
    request.setHeader("Content-Type", "application/json");
    request.setHeader("Authorization", `Bearer ${token}`);
    request.setHeader("Accept", "text/event-stream");

    let fullText = "";
    let buffer = "";
    let settled = false;

    const finish = (resolveValue: string | null, rejectErr: Error | null): void => {
      if (settled) return;
      settled = true;
      if (rejectErr) reject(rejectErr);
      else resolve(resolveValue ?? "");
    };

    const onAbort = (): void => {
      try { request.abort(); } catch { /* ignore */ }
      finish(null, new Error("aborted"));
    };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    request.on("response", (response) => {
      const status = response.statusCode ?? 500;
      if (status === 503) {
        finish(null, new ProviderNotConfiguredError(provider));
        return;
      }
      if (status < 200 || status >= 300) {
        let errBody = "";
        response.on("data", (c) => { errBody += c.toString("utf8"); });
        response.on("end", () => finish(null, new Error(`proxy ${status}: ${errBody.slice(0, 300)}`)));
        return;
      }

      response.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let split: number;
        while ((split = buffer.indexOf("\n\n")) !== -1) {
          const frameText = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          if (!frameText.trim()) continue;
          const frame = parseFrame(frameText);
          try {
            const data = frame.data ? JSON.parse(frame.data) : {};
            switch (frame.event) {
              case "text":
                if (typeof data.text === "string") {
                  fullText += data.text;
                  sink.onText?.(data.text);
                }
                break;
              case "usage":
                sink.onUsage?.(data);
                break;
              case "error":
                sink.onError?.(data.message ?? "stream error", data.code);
                if (data.code === "provider_not_configured") {
                  finish(null, new ProviderNotConfiguredError(provider));
                } else {
                  finish(null, new Error(data.message ?? "stream error"));
                }
                break;
              case "settlement_error":
                sink.onError?.(data.message ?? "settlement failed", "settlement_error");
                break;
              case "done":
                finish(fullText, null);
                break;
            }
          } catch { /* ignore malformed frame */ }
        }
      });

      response.on("end", () => finish(fullText, null));
      response.on("error", (err: Error) => finish(null, err));
    });

    request.on("error", (err: Error) => finish(null, err));
    request.write(JSON.stringify(body));
    request.end();
  });
}
