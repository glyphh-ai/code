/**
 * Capability collector — reads what this machine can offer to the .yo network.
 *
 * Reports three layers:
 *   1. host       — CPU/RAM/GPU/disk read from the kernel (Node `os` + Electron).
 *   2. llm        — providers detected from env + local Ollama probe.
 *      We never emit API keys; only presence + the model strings the user
 *      has configured in llm-config.
 *   3. runtime    — yo-client version, Agent SDK version, registered MCP servers.
 *
 * The server normalizes and bands these into a tier — clients cannot promote
 * themselves by lying, but the offer's `available` flag is user intent.
 */

import os from "os";
import fs from "fs";
import path from "path";
import { app, net } from "electron";
import { randomUUID } from "crypto";
import { getPreference, setPreference } from "./preferences";

// ── Types ───────────────────────────────────────────────────

export interface CapabilityReport {
  capabilities_schema: "1";
  client_id: string;
  collected_at: string;

  host: {
    platform: NodeJS.Platform;
    arch: string;
    cpu: { model: string; cores: number; threads: number };
    ram_gb: number;
    gpu: Array<{ model: string; vram_gb?: number; unified?: boolean }>;
    disk_free_gb: number | null;
  };

  llm: {
    providers: Array<{
      id: string;
      detected_via: "env" | "config" | "ollama" | "claude-cli";
      models_known?: string[];
      models_local?: string[];
    }>;
  };

  runtime: {
    yo_client_version: string;
    electron_version: string;
    node_version: string;
    agent_sdk_version: string | null;
    mcp_servers: string[];
    skills: string[];
  };

  offer: {
    available: boolean;
    terms: "free" | "rate" | "private";
    payment_timing: "pre" | "post";
  };
}

// ── Stable client_id per install ────────────────────────────

const CLIENT_ID_PREF_KEY = "capabilities.clientId";

export function getOrCreateClientId(): string {
  const existing = getPreference<string>(CLIENT_ID_PREF_KEY, "");
  if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
  const id = randomUUID();
  setPreference(CLIENT_ID_PREF_KEY, id);
  return id;
}

// ── Hardware ────────────────────────────────────────────────

function bytesToGb(b: number): number {
  return Math.round((b / 1024 / 1024 / 1024) * 10) / 10;
}

function readCpu(): CapabilityReport["host"]["cpu"] {
  const cpus = os.cpus() || [];
  const model = cpus[0]?.model?.trim() || "unknown";
  const cores = cpus.length;
  return { model, cores, threads: cores };
}

function readRamGb(): number {
  return bytesToGb(os.totalmem());
}

/**
 * GPU detection — best-effort. Apple Silicon reports a unified GPU sized to
 * total system RAM; on other platforms we leave it empty until we add a
 * proper probe. Never blocks; never spawns tools.
 */
function readGpu(): CapabilityReport["host"]["gpu"] {
  if (process.platform === "darwin" && process.arch === "arm64") {
    const cpuModel = (os.cpus()[0]?.model || "").trim();
    return [
      {
        model: cpuModel ? `${cpuModel} (integrated)` : "Apple Silicon (integrated)",
        vram_gb: readRamGb(),
        unified: true,
      },
    ];
  }
  return [];
}

function readDiskFreeGb(): number | null {
  try {
    const stat = (fs as unknown as { statfsSync?: (p: string) => { bavail: bigint; bsize: bigint } })
      .statfsSync;
    if (!stat) return null;
    const s = stat(os.homedir());
    return bytesToGb(Number(s.bavail) * Number(s.bsize));
  } catch {
    return null;
  }
}

// ── LLM provider detection ──────────────────────────────────

const ENV_PROVIDER_KEYS: Array<{ id: string; envKeys: string[] }> = [
  { id: "anthropic", envKeys: ["ANTHROPIC_API_KEY"] },
  { id: "openai", envKeys: ["OPENAI_API_KEY"] },
  { id: "google", envKeys: ["GOOGLE_API_KEY", "GEMINI_API_KEY"] },
  { id: "groq", envKeys: ["GROQ_API_KEY"] },
];

function detectEnvProviders(): CapabilityReport["llm"]["providers"] {
  const out: CapabilityReport["llm"]["providers"] = [];
  for (const { id, envKeys } of ENV_PROVIDER_KEYS) {
    if (envKeys.some((k) => (process.env[k] || "").length > 0)) {
      out.push({ id, detected_via: "env" });
    }
  }
  return out;
}

function detectConfiguredProvider(): CapabilityReport["llm"]["providers"][number] | null {
  // llm-config stores the user-selected provider/model (no key) in preferences.
  const provider = getPreference<string>("llmProvider", "");
  const model = getPreference<string>("llmModel", "");
  if (!provider) return null;
  return {
    id: provider,
    detected_via: "config",
    models_known: model ? [model] : [],
  };
}

async function detectOllama(): Promise<CapabilityReport["llm"]["providers"][number] | null> {
  try {
    const result = await new Promise<{ ok: boolean; models: string[] }>((resolve) => {
      const req = net.request({ url: "http://127.0.0.1:11434/api/tags", method: "GET" });
      const timer = setTimeout(() => { req.abort(); resolve({ ok: false, models: [] }); }, 750);
      let body = "";
      req.on("response", (resp) => {
        resp.on("data", (c) => { body += c.toString(); });
        resp.on("end", () => {
          clearTimeout(timer);
          try {
            const parsed = JSON.parse(body) as { models?: Array<{ name?: string }> };
            const models = (parsed.models || []).map((m) => m.name || "").filter(Boolean);
            resolve({ ok: true, models });
          } catch {
            resolve({ ok: false, models: [] });
          }
        });
      });
      req.on("error", () => { clearTimeout(timer); resolve({ ok: false, models: [] }); });
      req.end();
    });
    if (!result.ok) return null;
    return { id: "ollama", detected_via: "ollama", models_local: result.models };
  } catch {
    return null;
  }
}

async function detectProviders(): Promise<CapabilityReport["llm"]["providers"]> {
  const merged = new Map<string, CapabilityReport["llm"]["providers"][number]>();
  for (const p of detectEnvProviders()) merged.set(p.id, p);
  const cfg = detectConfiguredProvider();
  if (cfg) {
    const existing = merged.get(cfg.id);
    merged.set(cfg.id, {
      ...(existing || cfg),
      detected_via: existing?.detected_via || cfg.detected_via,
      models_known: Array.from(new Set([...(existing?.models_known || []), ...(cfg.models_known || [])])),
    });
  }
  const ollama = await detectOllama();
  if (ollama) merged.set("ollama", ollama);
  return Array.from(merged.values());
}

// ── Runtime ─────────────────────────────────────────────────

function readAgentSdkVersion(): string | null {
  try {
    const root = app.getAppPath();
    const pkgPath = path.join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version || null;
  } catch {
    return null;
  }
}

function readMcpServers(): string[] {
  // Custom MCP servers are stored as a list in preferences by mcp-manager.
  const servers = getPreference<Array<{ name?: string; id?: string }>>("mcpServers", []);
  return Array.isArray(servers) ? servers.map((s) => s?.name || s?.id || "").filter(Boolean) : [];
}

function readSkills(): string[] {
  // Skills are user-installed and tracked in preferences by skill-engine.
  const skills = getPreference<Array<{ name?: string; id?: string }>>("skills.installed", []);
  return Array.isArray(skills) ? skills.map((s) => s?.name || s?.id || "").filter(Boolean) : [];
}

// ── Public collector ────────────────────────────────────────

export async function collectCapabilities(opts: { available: boolean }): Promise<CapabilityReport> {
  const providers = await detectProviders();
  return {
    capabilities_schema: "1",
    client_id: getOrCreateClientId(),
    collected_at: new Date().toISOString(),
    host: {
      platform: process.platform,
      arch: process.arch,
      cpu: readCpu(),
      ram_gb: readRamGb(),
      gpu: readGpu(),
      disk_free_gb: readDiskFreeGb(),
    },
    llm: { providers },
    runtime: {
      yo_client_version: app.getVersion(),
      electron_version: process.versions.electron || "",
      node_version: process.versions.node || "",
      agent_sdk_version: readAgentSdkVersion(),
      mcp_servers: readMcpServers(),
      skills: readSkills(),
    },
    offer: {
      available: opts.available,
      terms: "free",
      payment_timing: "post",
    },
  };
}
