/**
 * Shared types for the sub-agent architecture.
 */

export type { AgentMode, ToolTier, ToolOverride, GateDecision } from "../action-gate";

export interface SubAgentResult {
  summary: string;        // Concise text for orchestrator context
  success: boolean;
  toolsUsed: string[];
}

export interface SubAgentContext {
  conversationSummary?: string;  // Last few exchanges from orchestrator history
  userMessage: string;           // Original user message
  availableMcpTools?: string;    // MCP tools from connected apps (for builder)
}

/** Anthropic-style tool definition. */
export interface ToolDef {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** Anthropic-style content block. */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };
