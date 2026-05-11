/**
 * AgentStore — file-based CRUD for the user's Agents registry.
 *
 * Each agent is a definition (local or remote) saved as JSON at
 * ~/yo/agents/{id}.json. A "remote" agent additionally tracks an active
 * reservation handle on the server (created via /api/marketplace/reservations)
 * and applies guardrails to bound spend.
 *
 * Mirrors the shape of AppConnector storage so the UI in help.ts can lift
 * the Apps patterns wholesale.
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

function pathFor(id: string): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) {
    throw new Error("Invalid agent id (use letters, digits, _ or -; must start with a letter or digit)");
  }
  return path.join(AGENTS_DIR, `${id}.json`);
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
  const files = fs
    .readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith(".json"));
  const out: AgentConfig[] = [];
  for (const f of files) {
    const cfg = safeRead(path.join(AGENTS_DIR, f));
    if (cfg) out.push(cfg);
  }
  out.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  return out;
}

export function getAgent(id: string): AgentConfig | null {
  ensureDir();
  return safeRead(pathFor(id));
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
  const existing = safeRead(pathFor(cfg.id));
  const merged: AgentConfig = {
    ...cfg,
    guardrails: cfg.guardrails ?? existing?.guardrails ?? DEFAULT_GUARDRAILS,
    meta: {
      createdAt: existing?.meta?.createdAt || now,
      updatedAt: now,
      description: cfg.meta?.description,
    },
  };
  fs.writeFileSync(pathFor(cfg.id), JSON.stringify(merged, null, 2), { mode: 0o600 });
  return merged;
}

export function removeAgent(id: string): boolean {
  ensureDir();
  try {
    fs.unlinkSync(pathFor(id));
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns true if the slug is available. Used by the UI to validate before
 * the user commits a "rename" action.
 */
export function idAvailable(id: string): boolean {
  ensureDir();
  try {
    return !fs.existsSync(pathFor(id));
  } catch {
    return false;
  }
}
