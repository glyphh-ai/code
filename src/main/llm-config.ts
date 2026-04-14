/**
 * LLM Config — multi-provider configuration, storage, and unified API call.
 *
 * Supports Anthropic (via SDK), OpenAI, Google AI, and custom OpenAI-compatible
 * endpoints (via net.request).
 */

import fs from "fs";
import path from "path";
import os from "os";
import { net } from "electron";

const CONFIG_DIR = path.join(os.homedir(), "yo");
const LLM_CONFIG_FILE = path.join(CONFIG_DIR, ".llm");
const LEGACY_API_KEY_FILE = path.join(CONFIG_DIR, ".apikey");

export type LLMProvider = "anthropic" | "openai" | "google" | "custom";

export interface LLMConfig {
  provider: LLMProvider;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

export const PROVIDER_PRESETS: Record<string, {
  name: string;
  models: string[];
  defaultModel: string;
  baseUrl?: string;
  keyPlaceholder: string;
}> = {
  anthropic: {
    name: "Anthropic",
    models: ["claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-haiku-4-5-20251001"],
    defaultModel: "claude-sonnet-4-20250514",
    keyPlaceholder: "sk-ant-...",
  },
  openai: {
    name: "OpenAI",
    models: ["gpt-4o", "gpt-4o-mini", "o3-mini"],
    defaultModel: "gpt-4o",
    baseUrl: "https://api.openai.com/v1",
    keyPlaceholder: "sk-...",
  },
  google: {
    name: "Google AI",
    models: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
    defaultModel: "gemini-2.5-flash",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyPlaceholder: "AIza...",
  },
  custom: {
    name: "Custom",
    models: [],
    defaultModel: "",
    keyPlaceholder: "API key",
  },
};

// ── Config storage ────────────────────────────────────────

export function loadLLMConfig(): LLMConfig {
  if (fs.existsSync(LLM_CONFIG_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(LLM_CONFIG_FILE, "utf-8"));
    } catch { /* fall through */ }
  }

  // Migrate from legacy .apikey
  if (fs.existsSync(LEGACY_API_KEY_FILE)) {
    const key = fs.readFileSync(LEGACY_API_KEY_FILE, "utf-8").trim();
    if (key) {
      const config: LLMConfig = {
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        apiKey: key,
      };
      saveLLMConfig(config);
      return config;
    }
  }

  return { provider: "anthropic", model: "claude-sonnet-4-20250514", apiKey: "" };
}

export function saveLLMConfig(config: LLMConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(LLM_CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
  // Keep legacy .apikey in sync for Anthropic
  if (config.provider === "anthropic" && config.apiKey) {
    fs.writeFileSync(LEGACY_API_KEY_FILE, config.apiKey, "utf-8");
  }
}

function getBaseUrl(config: LLMConfig): string {
  if (config.baseUrl) return config.baseUrl;
  return PROVIDER_PRESETS[config.provider]?.baseUrl || "https://api.openai.com/v1";
}

// ── Unified completion call ───────────────────────────────

export async function createCompletion(
  config: LLMConfig,
  params: {
    system: string;
    messages: any[];
    tools?: any[];
    maxTokens: number;
    model?: string;
  },
): Promise<{ content: any[]; stopReason: string }> {
  const model = params.model || config.model;
  if (config.provider === "anthropic") {
    return anthropicCompletion(config.apiKey, model, params);
  }
  return openaiCompletion(config, model, params);
}

/** Anthropic streaming (for chat). Returns the final message. */
export async function createStream(
  config: LLMConfig,
  params: {
    system: string;
    messages: any[];
    tools?: any[];
    maxTokens: number;
  },
  onText: (delta: string) => void,
): Promise<{ content: any[]; stopReason: string }> {
  if (config.provider === "anthropic") {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: config.apiKey });
    const opts: any = {
      model: config.model,
      max_tokens: params.maxTokens,
      system: params.system,
      messages: params.messages,
    };
    if (params.tools && params.tools.length > 0) opts.tools = params.tools;
    const stream = client.messages.stream(opts);
    stream.on("text", (text: string) => onText(text));
    const response = await stream.finalMessage();
    return { content: response.content as any[], stopReason: response.stop_reason as string };
  }

  // Non-streaming fallback for OpenAI-compatible providers
  const result = await openaiCompletion(config, config.model, params);
  for (const block of result.content) {
    if (block.type === "text") onText(block.text);
  }
  return result;
}

// ── Anthropic path ────────────────────────────────────────

async function anthropicCompletion(
  apiKey: string,
  model: string,
  params: { system: string; messages: any[]; tools?: any[]; maxTokens: number },
): Promise<{ content: any[]; stopReason: string }> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });
  const opts: any = {
    model,
    max_tokens: params.maxTokens,
    system: params.system,
    messages: params.messages,
  };
  if (params.tools && params.tools.length > 0) opts.tools = params.tools;
  const response = await client.messages.create(opts);
  return { content: response.content as any[], stopReason: response.stop_reason as string };
}

// ── OpenAI-compatible path ────────────────────────────────

function toOpenAITools(tools: any[]): any[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

function toOpenAIMessages(system: string, messages: any[]): any[] {
  const result: any[] = [{ role: "system", content: system }];
  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        result.push({ role: "user", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const toolResults = msg.content.filter((b: any) => b.type === "tool_result");
        const textBlocks = msg.content.filter((b: any) => b.type === "text");
        for (const tr of toolResults) {
          result.push({ role: "tool", tool_call_id: tr.tool_use_id, content: tr.content || "" });
        }
        if (textBlocks.length > 0) {
          result.push({ role: "user", content: textBlocks.map((b: any) => b.text).join("") });
        }
      }
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        result.push({ role: "assistant", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        let text = "";
        const toolCalls: any[] = [];
        for (const block of msg.content) {
          if (block.type === "text") text += block.text;
          else if (block.type === "tool_use") {
            toolCalls.push({
              id: block.id,
              type: "function",
              function: { name: block.name, arguments: JSON.stringify(block.input) },
            });
          }
        }
        const oaiMsg: any = { role: "assistant", content: text || null };
        if (toolCalls.length > 0) oaiMsg.tool_calls = toolCalls;
        result.push(oaiMsg);
      }
    }
  }
  return result;
}

function fromOpenAIResponse(choice: any): { content: any[]; stopReason: string } {
  const content: any[] = [];
  if (choice.message.content) {
    content.push({ type: "text", text: choice.message.content });
  }
  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments),
      });
    }
  }
  const stopReason = choice.finish_reason === "tool_calls" ? "tool_use" : "end_turn";
  return { content, stopReason };
}

function openaiRequest<T>(url: string, apiKey: string, body: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, method: "POST" });
    request.setHeader("Content-Type", "application/json");
    request.setHeader("Authorization", `Bearer ${apiKey}`);
    let responseBody = "";
    request.on("response", (response) => {
      response.on("data", (chunk: Buffer) => { responseBody += chunk.toString(); });
      response.on("end", () => {
        try {
          const parsed = JSON.parse(responseBody);
          if (response.statusCode && response.statusCode >= 400) {
            reject(new Error(parsed.error?.message || `API error ${response.statusCode}`));
          } else {
            resolve(parsed as T);
          }
        } catch {
          reject(new Error(`Invalid API response (${response.statusCode})`));
        }
      });
    });
    request.on("error", reject);
    request.write(JSON.stringify(body));
    request.end();
  });
}

async function openaiCompletion(
  config: LLMConfig,
  model: string,
  params: { system: string; messages: any[]; tools?: any[]; maxTokens: number },
): Promise<{ content: any[]; stopReason: string }> {
  const baseUrl = getBaseUrl(config);
  const body: any = {
    model,
    messages: toOpenAIMessages(params.system, params.messages),
    max_tokens: params.maxTokens,
  };
  if (params.tools && params.tools.length > 0) {
    body.tools = toOpenAITools(params.tools);
  }
  const data = await openaiRequest<any>(`${baseUrl}/chat/completions`, config.apiKey, body);
  return fromOpenAIResponse(data.choices[0]);
}

// ── Validation ────────────────────────────────────────────

export async function validateLLMConfig(config: LLMConfig): Promise<{ valid: boolean; error?: string }> {
  if (!config.apiKey) return { valid: false, error: "API key is required" };
  try {
    if (config.provider === "anthropic") {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey: config.apiKey });
      await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 16,
        messages: [{ role: "user", content: "Say ok" }],
      });
      return { valid: true };
    }
    // OpenAI-compatible validation
    const baseUrl = getBaseUrl(config);
    const testModel = config.provider === "google" ? "gemini-2.0-flash" : (config.model || "gpt-4o-mini");
    await openaiRequest<any>(`${baseUrl}/chat/completions`, config.apiKey, {
      model: testModel,
      messages: [{ role: "user", content: "Say ok" }],
      max_tokens: 16,
    });
    return { valid: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    if (msg.includes("401") || msg.includes("authentication") || msg.includes("invalid")) {
      return { valid: false, error: "Invalid API key" };
    }
    return { valid: false, error: msg };
  }
}
