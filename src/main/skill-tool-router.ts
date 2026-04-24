/**
 * SkillToolRouter — resolves `allowed-tools` entries to actual tool specs.
 *
 * Namespace:
 *   yo.<tool>            → agent tools from yo-agent TOOLS registry
 *   <app-id>.<tool>      → app-scoped via MCP server "pipedream-connect-<app-id>"
 *
 * Returns a filtered tool list suitable for handing to the LLM.
 */

import { McpManager } from "./mcp-manager";
import { AppNotConnectedError } from "./skill-types";

export interface ResolvedTool {
  // What the LLM sees
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  // What the runner needs to invoke it
  kind: "yo" | "mcp";
  mcpQualifiedName?: string;  // for MCP tools: mcp__<serverId>__<toolName>
}

export class SkillToolRouter {
  private yoToolsRegistry: Array<{ name: string; description: string; input_schema: Record<string, unknown> }> = [];
  private mcpManager: McpManager | null = null;

  setYoTools(tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>): void {
    this.yoToolsRegistry = tools;
  }

  setMcpManager(mgr: McpManager): void {
    this.mcpManager = mgr;
  }

  /**
   * Resolve the allowlist entries to actual tool specs.
   * Throws AppNotConnectedError if an entry references an unconnected app.
   */
  resolve(allowedTools: string[]): ResolvedTool[] {
    const resolved: ResolvedTool[] = [];
    const missingApps = new Set<string>();

    for (const entry of allowedTools) {
      const dotIdx = entry.indexOf(".");
      if (dotIdx < 0) continue; // malformed — skip
      const ns = entry.slice(0, dotIdx);
      const toolName = entry.slice(dotIdx + 1);

      if (ns === "yo") {
        const tool = this.yoToolsRegistry.find((t) => t.name === toolName);
        if (!tool) continue; // unknown tool — skip (could log)
        resolved.push({
          name: tool.name,
          description: tool.description,
          input_schema: tool.input_schema,
          kind: "yo",
        });
      } else {
        // App-scoped: <app-id>.<tool-name>
        if (!this.mcpManager) {
          missingApps.add(ns);
          continue;
        }
        const serverId = `pipedream-connect-${ns}`;
        const allTools = this.mcpManager.getAllTools();
        const match = allTools.find((t) => t.serverId === serverId && t.name === toolName);
        if (!match) {
          // Check if the server exists at all
          const serverState = this.mcpManager.getServerState(serverId);
          if (!serverState || serverState.status !== "connected") {
            missingApps.add(ns);
          }
          continue;
        }
        resolved.push({
          name: match.qualifiedName,  // LLM sees the qualified name
          description: match.description,
          input_schema: match.inputSchema,
          kind: "mcp",
          mcpQualifiedName: match.qualifiedName,
        });
      }
    }

    if (missingApps.size > 0) {
      throw new AppNotConnectedError([...missingApps].join(", "));
    }
    return resolved;
  }

  /** Check if a tool name (as the LLM would call it) is in the allowed set. */
  isAllowed(toolName: string, allowedTools: string[]): boolean {
    if (!allowedTools.length) return false;
    for (const entry of allowedTools) {
      const dotIdx = entry.indexOf(".");
      if (dotIdx < 0) continue;
      const ns = entry.slice(0, dotIdx);
      const tool = entry.slice(dotIdx + 1);
      if (ns === "yo" && toolName === tool) return true;
      if (ns !== "yo" && toolName === `mcp__pipedream-connect-${ns}__${tool}`) return true;
    }
    return false;
  }
}
