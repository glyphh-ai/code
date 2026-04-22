/**
 * MCP Manager — manages configured MCP servers, connections, and tool discovery.
 *
 * Stores server configs in preferences. Aggregates tools from all connected
 * servers into a unified registry that rips can consume.
 */

import { McpClient, McpTool, McpToolResult } from "./mcp-client";
import { getPreference, setPreference } from "./preferences";
import { EventEmitter } from "events";

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

export class McpManager extends EventEmitter {
  private servers = new Map<string, { client: McpClient; state: McpServerState }>();

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
    this.servers.set(config.id, {
      client: new McpClient({ transport: config.transport }),
      state: { config, status: "disconnected", tools: [] },
    });
    this.emit("changed");
  }

  removeServer(id: string): void {
    const entry = this.servers.get(id);
    if (entry?.client.isConnected()) {
      entry.client.disconnect().catch(() => {});
    }
    this.servers.delete(id);

    const configs = this.getConfigs().filter((c) => c.id !== id);
    this.saveConfigs(configs);

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

    const entry = this.servers.get(id);
    if (entry) {
      entry.state.config = configs[idx];
    }

    this.emit("changed");
  }

  async connectServer(config: McpServerConfig): Promise<void> {
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

  getServerStates(): McpServerState[] {
    return Array.from(this.servers.values()).map((e) => e.state);
  }

  getServerState(id: string): McpServerState | null {
    return this.servers.get(id)?.state ?? null;
  }

  getAllTools(): Array<{
    serverId: string;
    serverName: string;
    name: string;
    qualifiedName: string;
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

  async callTool(qualifiedName: string, args: Record<string, unknown> = {}): Promise<string> {
    const match = qualifiedName.match(/^mcp__(.+?)__(.+)$/);
    if (!match) return `Invalid MCP tool name: ${qualifiedName}`;

    const [, serverId, toolName] = match;
    const entry = this.servers.get(serverId);
    if (!entry) return `MCP server "${serverId}" not found.`;
    if (entry.state.status !== "connected") return `MCP server "${serverId}" is not connected.`;

    try {
      const result = await entry.client.callTool(toolName, args);
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

  /** Call a tool by server ID and tool name directly (for rip steps). */
  async callToolDirect(serverId: string, toolName: string, args: Record<string, unknown> = {}): Promise<string> {
    return this.callTool(`mcp__${serverId}__${toolName}`, args);
  }

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

  async disconnectAll(): Promise<void> {
    for (const entry of this.servers.values()) {
      if (entry.client.isConnected()) {
        await entry.client.disconnect().catch(() => {});
      }
    }
    this.servers.clear();
  }
}
