/**
 * AgentStore — foldered storage for agent identities (the worker bees).
 *
 * Each agent lives at ~/yo/agents/<slug>/agent.json, alongside
 * CLAUDE.md (editable system prompt) and optionally avatar.png.
 *
 * Per-folder runtime (chat history) lives at <cwd>/.yo/agents/<slug>/
 * — see history* helpers below. Identity follows the user; conversations
 * stay with the folder they happened in.
 */

import fs from "fs";
import path from "path";
import os from "os";

const AGENTS_DIR = path.join(os.homedir(), "yo", "agents");

// ── Types ───────────────────────────────────────────────────

export type AgentType = "local" | "remote";

export interface Guardrails {
  max_input_tokens_per_turn?: number;
  max_output_tokens_per_turn?: number;
  max_tokens_per_session?: number;
  max_turns?: number;
  rate_limit_rpm?: number;
  auto_stop_idle_seconds?: number;
}

export interface RemoteConfig {
  /** Filter for the picker: prefer this hardware tier when reserving. */
  preferred_tier?: "premiere" | "standard" | "low" | "any";
  /** Filter for the picker: prefer providers serving these LLM ids. */
  preferred_providers?: string[];
  /** Default idle minutes to escrow when reserving from this template. */
  default_idle_minutes?: number;
  /** Currently reserved (server-side state mirrored locally). */
  active_reservation_id?: string;
  /** The provider's offer_handle (== client_capabilities.client_id). */
  active_provider_handle?: string;
}

export interface AgentConfig {
  id: string;             // slug
  name: string;
  type: AgentType;

  role?: string;
  systemPrompt?: string;

  /** Public-facing identity. Falls back to identicon when avatar_url is unset. */
  avatar_url?: string;
  /** Short tagline shown in profile/leaderboard cards. */
  bio?: string;

  /** Apps this agent has access to (for tools and context). Slugs from ~/yo/apps/. */
  apps?: string[];
  /** Per-app tool/skill selection — which panel tools and MCP tools each app exposes. */
  appConfigs?: Record<string, { allowAll?: boolean; panelTools?: string[]; mcpTools?: string[] }>;
  /** Skills this agent can run. Names from the skill registry. */
  skills?: string[];
  /** Built-in tools the agent is allowed to call (read/write/shell/git/...). */
  builtin_tools?: string[];
  /** MCP server names the agent has access to. */
  mcp_servers?: string[];

  /** Model used by this agent (provider + name). Falls back to global llmConfig if unset. */
  model_provider?: string;
  model_name?: string;

  /**
   * How this agent runs inside a swarm:
   *  - "full"     — a full agent loop (tools, files, multi-turn). Default.
   *  - "readonly" — a one-shot model turn (debate / think, no tools).
   */
  mode?: "full" | "readonly";


  /** If true, this agent is published to yo-server and discoverable for cyphers. */
  joinable?: boolean;

  remote?: RemoteConfig;
  guardrails?: Guardrails;
  tool_permissions?: {
    shell?: "full" | "read" | "disabled";
    file_system?: "full" | "read" | "disabled";
    git?: "full" | "read" | "disabled";
    browser?: "full" | "read" | "disabled";
    mcp?: "full" | "read" | "disabled";
  };

  meta?: {
    createdAt: string;
    updatedAt: string;
    description?: string;
  };
}

// ── Filesystem helpers ──────────────────────────────────────

function ensureDir(): void {
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
}

function validateId(id: string): void {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) {
    throw new Error("Invalid agent id (use letters, digits, _ or -; must start with a letter or digit)");
  }
}

/** ~/yo/agents/<slug>/ — the agent's own folder. */
function dirFor(id: string): string {
  validateId(id);
  return path.join(AGENTS_DIR, id);
}
/** ~/yo/agents/<slug>/agent.json */
function configPath(id: string): string {
  return path.join(dirFor(id), "agent.json");
}
/** ~/yo/agents/<slug>/CLAUDE.md — editable system prompt. */
export function claudeMdPath(id: string): string {
  return path.join(dirFor(id), "CLAUDE.md");
}

function safeRead(file: string): AgentConfig | null {
  try {
    const raw = fs.readFileSync(file, "utf-8");
    return JSON.parse(raw) as AgentConfig;
  } catch {
    return null;
  }
}

// ── Public API ──────────────────────────────────────────────

export function listAgents(): AgentConfig[] {
  ensureDir();
  const entries = fs.readdirSync(AGENTS_DIR, { withFileTypes: true });
  const out: AgentConfig[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const cfg = safeRead(path.join(AGENTS_DIR, ent.name, "agent.json"));
    if (cfg) out.push(cfg);
  }
  out.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  return out;
}

export function getAgent(id: string): AgentConfig | null {
  ensureDir();
  try { return safeRead(configPath(id)); } catch { return null; }
}

const DEFAULT_GUARDRAILS: Guardrails = {
  max_input_tokens_per_turn: 50000,
  max_output_tokens_per_turn: 16000,
  max_tokens_per_session: 500000,
  max_turns: 100,
  rate_limit_rpm: 30,
  auto_stop_idle_seconds: 300,
};

export function saveAgent(cfg: AgentConfig): AgentConfig {
  ensureDir();
  const now = new Date().toISOString();
  fs.mkdirSync(dirFor(cfg.id), { recursive: true });
  const existing = safeRead(configPath(cfg.id));
  const merged: AgentConfig = {
    ...cfg,
    guardrails: cfg.guardrails ?? existing?.guardrails ?? DEFAULT_GUARDRAILS,
    meta: {
      createdAt: existing?.meta?.createdAt || now,
      updatedAt: now,
      description: cfg.meta?.description,
    },
  };
  fs.writeFileSync(configPath(cfg.id), JSON.stringify(merged, null, 2), { mode: 0o600 });
  // Seed an editable CLAUDE.md alongside the config if one isn't there yet
  // and the agent has a systemPrompt. Users edit this file directly.
  const claudePath = claudeMdPath(cfg.id);
  if (!fs.existsSync(claudePath) && cfg.systemPrompt) {
    try { fs.writeFileSync(claudePath, cfg.systemPrompt, { mode: 0o600 }); } catch { /* ignore */ }
  }
  return merged;
}

export function removeAgent(id: string): boolean {
  ensureDir();
  try {
    fs.rmSync(dirFor(id), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_AGENT_PROMPT = `You are .Yo's default worker-bee agent.

You run in the user's current working folder with full Claude Code
tooling — Read, Edit, Bash, Grep, Glob, Write — plus any MCP tools the
user has whitelisted for this agent. Be useful, be direct, and prefer
making the change over describing what you would change.

You are NOT the right-rail .Yo wrapper agent — that's a separate agent
that spans all folders at ~/yo/. You are workspace-scoped: your cwd is
the only context you have to act on by default.

Edit your behavior in this file (CLAUDE.md) or update agent.json via
the Agents app.`;

/** Ensure a "default" agent exists. Creates one with the full Claude Code
 *  preamble system prompt on first call. Used by yo://agent when no slug
 *  is specified. */
export function ensureDefaultAgent(): AgentConfig {
  const existing = getAgent("default");
  if (existing) return existing;
  return saveAgent({
    id: "default",
    name: "Agent",
    type: "local",
    systemPrompt: DEFAULT_AGENT_PROMPT,
    mode: "full",
  });
}

/** Returns true if the slug is available (no folder for it yet). */
export function idAvailable(id: string): boolean {
  ensureDir();
  try {
    return !fs.existsSync(dirFor(id));
  } catch {
    return false;
  }
}

// ── Per-folder runtime: chat history at <cwd>/.yo/agents/<slug>/ ──

function runtimeDir(cwd: string, agentId: string): string {
  validateId(agentId);
  return path.join(cwd, ".yo", "agents", agentId);
}

function historyDir(cwd: string, agentId: string): string {
  return path.join(runtimeDir(cwd, agentId), "history");
}

export function listChatHistory(cwd: string, agentId: string): Array<{ id: string; createdAt: string; title?: string }> {
  try {
    const dir = historyDir(cwd, agentId);
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    return files.map((f) => {
      const id = f.replace(/\.jsonl$/, "");
      const stat = fs.statSync(path.join(dir, f));
      return { id, createdAt: stat.mtime.toISOString() };
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

export function readChat(cwd: string, agentId: string, chatId: string): Array<Record<string, unknown>> {
  try {
    const file = path.join(historyDir(cwd, agentId), `${chatId}.jsonl`);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((x): x is Record<string, unknown> => !!x);
  } catch {
    return [];
  }
}

export function appendChatEntry(cwd: string, agentId: string, chatId: string, entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(historyDir(cwd, agentId), { recursive: true });
    const file = path.join(historyDir(cwd, agentId), `${chatId}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
  } catch { /* ignore */ }
}

export function deleteChat(cwd: string, agentId: string, chatId: string): boolean {
  try {
    fs.unlinkSync(path.join(historyDir(cwd, agentId), `${chatId}.jsonl`));
    return true;
  } catch {
    return false;
  }
}

interface AgentRuntimeState {
  lastChatId?: string;
}

export function readRuntimeState(cwd: string, agentId: string): AgentRuntimeState {
  try {
    const f = path.join(runtimeDir(cwd, agentId), "state.json");
    if (!fs.existsSync(f)) return {};
    return JSON.parse(fs.readFileSync(f, "utf-8")) as AgentRuntimeState;
  } catch {
    return {};
  }
}

export function writeRuntimeState(cwd: string, agentId: string, state: AgentRuntimeState): void {
  try {
    fs.mkdirSync(runtimeDir(cwd, agentId), { recursive: true });
    fs.writeFileSync(path.join(runtimeDir(cwd, agentId), "state.json"), JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch { /* ignore */ }
}
