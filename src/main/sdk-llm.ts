/**
 * SDK LLM — all LLM calls funneled through the Claude Agent SDK.
 *
 * Provides sdkComplete() for one-shot completions (no tools, no streaming).
 * All callers use this instead of direct Anthropic API or proxy calls.
 */

import { getShellPath } from "./shell-path";

const dynamicImport = new Function("specifier", "return import(specifier)") as
  (specifier: string) => Promise<any>;

let _sdk: any = null;

async function ensureSDK(): Promise<any> {
  if (!_sdk) {
    _sdk = await dynamicImport("@anthropic-ai/claude-agent-sdk");
  }
  return _sdk;
}

export { ensureSDK };

export interface CompletionResult {
  text: string;
  usage?: { input_tokens: number; output_tokens: number };
}

/**
 * One-shot completion via the Agent SDK. No tools, no streaming.
 */
export async function sdkComplete(opts: {
  system: string;
  prompt: string;
  model?: string;
}): Promise<CompletionResult> {
  const sdk = await ensureSDK();
  const shellPath = getShellPath();

  const gen = sdk.query({
    prompt: opts.prompt,
    options: {
      model: opts.model || "claude-sonnet-4-6",
      maxTurns: 1,
      systemPrompt: opts.system,
      tools: [],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      env: {
        ...process.env,
        PATH: shellPath,
        CLAUDE_AGENT_SDK_CLIENT_APP: "yosup/3.0.0",
      },
    },
  });

  let text = "";
  let usage: { input_tokens: number; output_tokens: number } | undefined;

  for await (const msg of gen) {
    switch (msg.type) {
      case "stream_event": {
        const event = msg.event;
        if (event?.type === "content_block_delta") {
          const delta = (event as any).delta;
          if (delta?.type === "text_delta" && delta.text) {
            text += delta.text;
          }
        }
        break;
      }
      case "result": {
        if (msg.usage) {
          usage = {
            input_tokens: msg.usage.input_tokens || 0,
            output_tokens: msg.usage.output_tokens || 0,
          };
        }
        break;
      }
    }
  }

  return { text, usage };
}
