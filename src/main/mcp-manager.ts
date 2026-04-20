/**
 * MCP Manager — manages configured MCP servers, connections, and tool discovery.
 *
 * Stores server configs in preferences. Aggregates tools from all connected
 * servers into a unified registry the yo agent can consume.
 */

import { McpClient, McpTool, McpToolResult } from "./mcp-client";
import { getPreference, setPreference } from "./preferences";
import { EventEmitter } from "events";

// ── Types ──────────────────────────────────────────────────

export interface McpServerConfig {
  id: string;
  name: string;
  transport: "stdio" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled: boolean;
}

export interface McpServerState {
  config: McpServerConfig;
  status: "disconnected" | "connecting" | "connected" | "error";
  error?: string;
  tools: McpTool[];
}

export type McpToolOverride = "default" | "auto" | "ask";

/** Branded preset servers that users can add with one click. */
export const MCP_PRESETS: Array<{ id: string; name: string; description: string; transport: "stdio" | "sse"; command: string; args: string[]; configHint?: string }> = [
  {
    id: "filesystem",
    name: "Filesystem",
    description: "Read, write, and search files on your machine",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "~/"],
    configHint: "Add allowed directories as extra args",
  },
  {
    id: "brave-search",
    name: "Brave Search",
    description: "Web search via Brave Search API",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-brave-search"],
    configHint: "Set BRAVE_API_KEY in env",
  },
  {
    id: "github",
    name: "GitHub",
    description: "GitHub repos, issues, PRs, and more",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    configHint: "Set GITHUB_PERSONAL_ACCESS_TOKEN in env",
  },
  {
    id: "postgres",
    name: "PostgreSQL",
    description: "Query PostgreSQL databases",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres"],
    configHint: "Set DATABASE_URL in env",
  },
  {
    id: "slack",
    name: "Slack",
    description: "Read and send Slack messages",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-slack"],
    configHint: "Set SLACK_BOT_TOKEN and SLACK_TEAM_ID in env",
  },
  {
    id: "memory",
    name: "Memory",
    description: "Persistent knowledge graph memory",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
  },
  {
    id: "puppeteer",
    name: "Puppeteer",
    description: "Browser automation and web scraping",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-puppeteer"],
  },
  {
    id: "fetch",
    name: "Fetch",
    description: "Fetch and extract web page content",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-fetch"],
  },
];

// ── Manager ────────────────────────────────────────────────

export class McpManager extends EventEmitter {
  private servers = new Map<string, { client: McpClient; state: McpServerState }>();

  /** Load saved configs and auto-connect enabled servers. */
  async init(): Promise<void> {
    const configs = this.getConfigs();
    for (const config of configs) {
      if (config.enabled) {
        this.connectServer(config).catch(() => {});
      } else {
        this.servers.set(config.id, {
          client: new McpClient({ transport: config.transport }),
          state: { config, status: "disconnected", tools: [] },
        });
      }
    }
  }

  // ── Config persistence ─────────────────────────────────

  getConfigs(): McpServerConfig[] {
    return getPreference<McpServerConfig[]>("mcpServers", []);
  }

  private saveConfigs(configs: McpServerConfig[]): void {
    setPreference("mcpServers", configs);
  }

  addServer(config: McpServerConfig): void {
    const configs = this.getConfigs();
    const existing = configs.findIndex((c) => c.id === config.id);
    if (existing >= 0) {
      configs[existing] = config;
    } else {
      configs.push(config);
    }
    this.saveConfigs(configs);
  }

  removeServer(id: string): void {
    // Disconnect first
    const entry = this.servers.get(id);
    if (entry?.client.isConnected()) {
      entry.client.disconnect().catch(() => {});
    }
    this.servers.delete(id);

    // Remove config
    const configs = this.getConfigs().filter((c) => c.id !== id);
    this.saveConfigs(configs);

    // Remove tool overrides for this server
    const overrides = this.getToolOverrides();
    const cleaned: Record<string, McpToolOverride> = {};
    for (const [key, val] of Object.entries(overrides)) {
      if (!key.startsWith(`${id}:`)) cleaned[key] = val;
    }
    setPreference("mcpToolOverrides", cleaned);

    this.emit("changed");
  }

  updateServer(id: string, updates: Partial<McpServerConfig>): void {
    const configs = this.getConfigs();
    const idx = configs.findIndex((c) => c.id === id);
    if (idx < 0) return;
    configs[idx] = { ...configs[idx], ...updates };
    this.saveConfigs(configs);
    this.emit("changed");
  }

  // ── Connection management ──────────────────────────────

  async connectServer(config: McpServerConfig): Promise<void> {
    // Disconnect existing
    const existing = this.servers.get(config.id);
    if (existing?.client.isConnected()) {
      await existing.client.disconnect();
    }

    const state: McpServerState = { config, status: "connecting", tools: [] };
    const client = new McpClient({
      transport: config.transport,
      command: config.command,
      args: config.args,
      env: config.env,
      url: config.url,
    });

    this.servers.set(config.id, { client, state });
    this.emit("changed");

    try {
      await client.connect();
      state.status = "connected";

      // Discover tools
      const tools = await client.listTools();
      state.tools = tools;
      state.error = undefined;

      client.on("disconnected", () => {
        state.status = "disconnected";
        state.tools = [];
        this.emit("changed");
      });

      client.on("error", (err: Error) => {
        state.status = "error";
        state.error = err.message;
        this.emit("changed");
      });

      this.emit("changed");
    } catch (err) {
      state.status = "error";
      state.error = err instanceof Error ? err.message : String(err);
      this.emit("changed");
      throw err;
    }
  }

  async disconnectServer(id: string): Promise<void> {
    const entry = this.servers.get(id);
    if (!entry) return;
    await entry.client.disconnect();
    entry.state.status = "disconnected";
    entry.state.tools = [];
    this.emit("changed");
  }

  async reconnectServer(id: string): Promise<void> {
    const config = this.getConfigs().find((c) => c.id === id);
    if (!config) return;
    await this.connectServer(config);
  }

  // ── Tool registry ──────────���───────────────────────────

  /** Get all states for the UI. */
  getServerStates(): McpServerState[] {
    return Array.from(this.servers.values()).map((e) => e.state);
  }

  /** Get the state for a single server. */
  getServerState(id: string): McpServerState | null {
    return this.servers.get(id)?.state ?? null;
  }

  /** Get all tools from all connected servers, namespaced as mcp__<serverId>__<toolName>. */
  getAllTools(): Array<{
    serverId: string;
    serverName: string;
    name: string;           // original MCP tool name
    qualifiedName: string;  // mcp__<serverId>__<toolName>
    description: string;
    inputSchema: Record<string, unknown>;
  }> {
    const tools: ReturnType<McpManager["getAllTools"]> = [];
    for (const entry of this.servers.values()) {
      if (entry.state.status !== "connected") continue;
      for (const tool of entry.state.tools) {
        tools.push({
          serverId: entry.state.config.id,
          serverName: entry.state.config.name,
          name: tool.name,
          qualifiedName: `mcp__${entry.state.config.id}__${tool.name}`,
          description: tool.description || "",
          inputSchema: tool.inputSchema,
        });
      }
    }
    return tools;
  }

  /** Build tool definitions for the LLM agent (Anthropic tool format). */
  getAgentTools(): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
    return this.getAllTools().map((t) => ({
      name: t.qualifiedName,
      description: `[MCP: ${t.serverName}] ${t.description}`,
      input_schema: t.inputSchema,
    }));
  }

  // ── Tool execution ─────────────────────────────────────

  /** Execute an MCP tool by its qualified name. Returns text result. */
  async callTool(qualifiedName: string, args: Record<string, unknown> = {}): Promise<string> {
    const match = qualifiedName.match(/^mcp__(.+?)__(.+)$/);
    if (!match) return `Invalid MCP tool name: ${qualifiedName}`;

    const [, serverId, toolName] = match;
    const entry = this.servers.get(serverId);
    if (!entry) return `MCP server "${serverId}" not found.`;
    if (entry.state.status !== "connected") return `MCP server "${serverId}" is not connected.`;

    try {
      const result = await entry.client.callTool(toolName, args);
      // Flatten content blocks to text
      return result.content
        .map((block) => {
          if (block.type === "text" && block.text) return block.text;
          if (block.type === "image" && block.data) return `[image: ${block.mimeType || "image/png"}]`;
          return `[${block.type}]`;
        })
        .join("\n") || (result.isError ? "[tool returned error with no content]" : "[no output]");
    } catch (err) {
      return `MCP tool error: ${err instanceof Error ? err.message : err}`;
    }
  }

  // ── Per-server tool overrides (guardrails) ─────────────

  /** Key format: "<serverId>:<toolName>" */
  getToolOverrides(): Record<string, McpToolOverride> {
    return getPreference<Record<string, McpToolOverride>>("mcpToolOverrides", {});
  }

  getToolOverride(serverId: string, toolName: string): McpToolOverride {
    const overrides = this.getToolOverrides();
    return overrides[`${serverId}:${toolName}`] || "default";
  }

  setToolOverride(serverId: string, toolName: string, override: McpToolOverride): void {
    const overrides = this.getToolOverrides();
    const key = `${serverId}:${toolName}`;
    if (override === "default") {
      delete overrides[key];
    } else {
      overrides[key] = override;
    }
    setPreference("mcpToolOverrides", overrides);
  }

  /** Set all tools for a server to the same override at once. */
  setServerOverride(serverId: string, override: McpToolOverride): void {
    const overrides = this.getToolOverrides();
    const entry = this.servers.get(serverId);
    if (!entry) return;
    for (const tool of entry.state.tools) {
      const key = `${serverId}:${tool.name}`;
      if (override === "default") {
        delete overrides[key];
      } else {
        overrides[key] = override;
      }
    }
    setPreference("mcpToolOverrides", overrides);
  }

  // ── Cleanup ────────────────────────────────────────────

  async disconnectAll(): Promise<void> {
    for (const entry of this.servers.values()) {
      if (entry.client.isConnected()) {
        await entry.client.disconnect().catch(() => {});
      }
    }
    this.servers.clear();
  }
}
