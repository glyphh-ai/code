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

export type LLMProvider = "anthropic" | "openai" | "google" | "xai" | "deepseek" | "custom";

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
    models: [
      "claude-sonnet-4-20250514",
      "claude-opus-4-20250514",
      "claude-opus-4-6-20250626",
      "claude-haiku-4-5-20251001",
    ],
    defaultModel: "claude-sonnet-4-20250514",
    keyPlaceholder: "sk-ant-...",
  },
  openai: {
    name: "OpenAI",
    models: [
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-4.1-nano",
      "gpt-4o",
      "gpt-4o-mini",
      "o3",
      "o3-mini",
      "o4-mini",
      "o3-pro",
    ],
    defaultModel: "gpt-4.1",
    baseUrl: "https://api.openai.com/v1",
    keyPlaceholder: "sk-...",
  },
  google: {
    name: "Google AI",
    models: [
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.0-flash",
      "gemini-2.0-flash-lite",
    ],
    defaultModel: "gemini-2.5-flash",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyPlaceholder: "AIza...",
  },
  xai: {
    name: "xAI",
    models: [
      "grok-3",
      "grok-3-fast",
      "grok-3-mini",
      "grok-3-mini-fast",
    ],
    defaultModel: "grok-3-fast",
    baseUrl: "https://api.x.ai/v1",
    keyPlaceholder: "xai-...",
  },
  deepseek: {
    name: "DeepSeek",
    models: [
      "deepseek-chat",
      "deepseek-reasoner",
    ],
    defaultModel: "deepseek-chat",
    baseUrl: "https://api.deepseek.com/v1",
    keyPlaceholder: "sk-...",
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
  if (config.baseUrl && config.baseUrl.startsWith("http")) return config.baseUrl;
  return PROVIDER_PRESETS[config.provider]?.baseUrl || "https://api.openai.com/v1";
}

// ── Unified completion call ───────────────────────────────

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreation?: number;
  cacheRead?: number;
}

export async function createCompletion(
  config: LLMConfig,
  params: {
    system: string;
    messages: any[];
    tools?: any[];
    maxTokens: number;
    model?: string;
  },
): Promise<{ content: any[]; stopReason: string; usage?: LLMUsage }> {
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
): Promise<{ content: any[]; stopReason: string; usage?: LLMUsage }> {
  if (config.provider === "anthropic") {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: config.apiKey });
    const cached = withCacheControl(params.system, params.tools);
    const opts: any = {
      model: config.model,
      max_tokens: params.maxTokens,
      system: cached.system,
      messages: params.messages,
    };
    if (cached.tools && cached.tools.length > 0) opts.tools = cached.tools;
    const stream = client.messages.stream(opts);
    stream.on("text", (text: string) => onText(text));
    const response = await stream.finalMessage();
    const u = response.usage as any;
    const usage: LLMUsage = {
      inputTokens: u?.input_tokens || 0,
      outputTokens: u?.output_tokens || 0,
      cacheCreation: u?.cache_creation_input_tokens || 0,
      cacheRead: u?.cache_read_input_tokens || 0,
    };
    return { content: response.content as any[], stopReason: response.stop_reason as string, usage };
  }

  // Non-streaming fallback for OpenAI-compatible providers
  const result = await openaiCompletion(config, config.model, params);
  for (const block of result.content) {
    if (block.type === "text") onText(block.text);
  }
  return result;
}

// ── Anthropic path ────────────────────────────────────────

/** Wrap system prompt and tools with cache_control breakpoints for Anthropic prompt caching. */
function withCacheControl(system: string, tools?: any[]): { system: any; tools?: any[] } {
  // System prompt as a cacheable block
  const cachedSystem = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];

  // Mark the last tool definition as a cache breakpoint
  if (tools && tools.length > 0) {
    const cachedTools = tools.map((t, i) =>
      i === tools.length - 1
        ? { ...t, cache_control: { type: "ephemeral" } }
        : t
    );
    return { system: cachedSystem, tools: cachedTools };
  }

  return { system: cachedSystem };
}

async function anthropicCompletion(
  apiKey: string,
  model: string,
  params: { system: string; messages: any[]; tools?: any[]; maxTokens: number },
): Promise<{ content: any[]; stopReason: string; usage?: LLMUsage }> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });
  const cached = withCacheControl(params.system, params.tools);
  const opts: any = {
    model,
    max_tokens: params.maxTokens,
    system: cached.system,
    messages: params.messages,
  };
  if (cached.tools && cached.tools.length > 0) opts.tools = cached.tools;
  const response = await client.messages.create(opts);
  const u = response.usage as any;
  const usage: LLMUsage = {
    inputTokens: u?.input_tokens || 0,
    outputTokens: u?.output_tokens || 0,
    cacheCreation: u?.cache_creation_input_tokens || 0,
    cacheRead: u?.cache_read_input_tokens || 0,
  };
  return { content: response.content as any[], stopReason: response.stop_reason as string, usage };
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

function fromOpenAIResponse(choice: any): { content: any[]; stopReason: string; usage?: LLMUsage } {
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
    if (!url || !url.startsWith("http")) {
      reject(new Error(`Invalid API URL: "${url}". Check your provider's Base URL in Settings.`));
      return;
    }
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
): Promise<{ content: any[]; stopReason: string; usage?: LLMUsage }> {
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
  const result = fromOpenAIResponse(data.choices[0]);
  if (data.usage) {
    result.usage = { inputTokens: data.usage.prompt_tokens || 0, outputTokens: data.usage.completion_tokens || 0 };
  }
  return result;
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
    const cheapTest: Record<string, string> = {
      openai: "gpt-4.1-nano",
      google: "gemini-2.0-flash-lite",
      xai: "grok-3-mini-fast",
      deepseek: "deepseek-chat",
    };
    const testModel = cheapTest[config.provider] || config.model || "gpt-4o-mini";
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
