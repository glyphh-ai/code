/**
 * LLM Config — model selection and persistence.
 *
 * All LLM calls now go through the Claude Agent SDK (see sdk-llm.ts).
 * This file only handles config storage: which model the user selected.
 */

import fs from "fs";
import path from "path";
import os from "os";

const CONFIG_DIR = path.join(os.homedir(), "yo");
const LLM_CONFIG_FILE = path.join(CONFIG_DIR, ".llm");

export interface LLMConfig {
  provider: "anthropic";
  model: string;
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  yosConsumed: number;
  yosRemaining: number;
}

const MODEL_MIGRATIONS: Record<string, string> = {
  "claude-opus-4-7-20250715": "claude-opus-4-7",
  "claude-opus-4-6-20250626": "claude-opus-4-6",
  "claude-sonnet-4-6-20250626": "claude-sonnet-4-6",
};

export function loadLLMConfig(): LLMConfig {
  try {
    if (fs.existsSync(LLM_CONFIG_FILE)) {
      const raw = fs.readFileSync(LLM_CONFIG_FILE, "utf-8");
      const config = JSON.parse(raw) as LLMConfig & { apiKey?: string; provider?: string };
      delete config.apiKey;
      config.provider = "anthropic";
      const newModel = MODEL_MIGRATIONS[config.model];
      if (newModel) {
        config.model = newModel;
        saveLLMConfig(config);
      }
      return config;
    }
  } catch { /* fall through */ }
  return { provider: "anthropic", model: "claude-sonnet-4-6" };
}

export function saveLLMConfig(config: LLMConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(LLM_CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}
