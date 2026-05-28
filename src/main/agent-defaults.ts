/**
 * Agent defaults — seed values for new agents created in the Agents app.
 *
 * Stored at ~/yo/.agent-defaults.json. Consumed by agent-store when
 * creating a fresh agent (e.g. createFromDefaults / ensureDefaultAgent).
 */

import fs from "fs";
import path from "path";
import os from "os";
import { ipcMain } from "electron";

export interface AgentDefaults {
  provider: string;
  model: string;
  permDefault: "default" | "plan" | "acceptEdits" | "bypassPermissions";
  systemPrompt: string;
  mcpServers: string[];
}

const FILE = path.join(os.homedir(), "yo", ".agent-defaults.json");

const DEFAULTS: AgentDefaults = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  permDefault: "default",
  systemPrompt: "",
  mcpServers: [],
};

export function readAgentDefaults(): AgentDefaults {
  try {
    if (!fs.existsSync(FILE)) return { ...DEFAULTS };
    const raw = fs.readFileSync(FILE, "utf-8");
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<AgentDefaults>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeAgentDefaults(d: Partial<AgentDefaults>): AgentDefaults {
  const merged = { ...readAgentDefaults(), ...d };
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(merged, null, 2), { mode: 0o600 });
  } catch { /* ignore */ }
  return merged;
}

export function registerAgentDefaultsIpc(): void {
  ipcMain.handle("agent-defaults:get", () => readAgentDefaults());
  ipcMain.handle("agent-defaults:set", (_e, d: Partial<AgentDefaults>) => writeAgentDefaults(d));
}
