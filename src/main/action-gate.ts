/**
 * Action Gate — tool tier registry and permission gating.
 *
 * Each tool is classified as "observe" (read-only, safe) or "mutate" (side effects).
 * The gate checks the current mode + per-tool overrides to decide whether a tool
 * call should execute, wait for user approval, or be skipped.
 */

import { getPreference } from "./preferences";

export type AgentMode = "plan" | "ask" | "auto";
export type ToolTier = "observe" | "mutate";
export type ToolOverride = "default" | "auto" | "ask";

export type GateDecision = "execute" | "needs_approval" | "skip";

const TOOL_TIERS: Record<string, ToolTier> = {
  search_captures:   "observe",
  get_context:       "observe",
  format:            "observe",
  save_memory:       "observe",
  search_notes:      "observe",
  read_file:         "observe",
  list_files:        "observe",
  run_command:       "observe",
  start_council:     "mutate",
  delegate_navigate: "mutate",
  delegate_layout:   "mutate",
};

export const TOOL_LABELS: Record<string, string> = {
  search_captures:   "Search captures",
  get_context:       "Get session context",
  format:            "Format with skill",
  save_memory:       "Save memory",
  search_notes:      "Search notes",
  read_file:         "Read file",
  list_files:        "List files",
  run_command:       "Run command",
  start_council:     "Start council",
  delegate_navigate: "Navigate panels",
  delegate_layout:   "Arrange layout",
};

export const TOOL_DESCRIPTIONS: Record<string, string> = {
  search_captures:   "Vector search across all captured content",
  get_context:       "Read current session context (in-memory captures)",
  format:            "Apply a skill to format content",
  save_memory:       "Save a preference or pattern to agent memory",
  search_notes:      "Keyword search across saved notes in ~/yo/notes/",
  read_file:         "Read a file from the local filesystem",
  list_files:        "List files in a directory",
  run_command:       "Run a read-only shell command (git log, ls, etc.)",
  start_council:     "Convene a multi-model council debate across AI panels",
  delegate_navigate: "Sub-agent: scan, click, type, navigate app panels",
  delegate_layout:   "Sub-agent: split views, grids, tabs, workspace layout",
};

export function getToolTier(toolName: string): ToolTier {
  return TOOL_TIERS[toolName] || "mutate";
}

export function getToolOverrides(): Record<string, ToolOverride> {
  return getPreference<Record<string, ToolOverride>>("toolOverrides", {});
}

function getEffectiveOverride(toolName: string): ToolOverride {
  const overrides = getToolOverrides();
  return overrides[toolName] || "default";
}

export function getAgentMode(): AgentMode {
  return getPreference<AgentMode>("agentMode", "ask");
}

export function gate(toolName: string, mode: AgentMode): GateDecision {
  if (mode === "plan") return "skip";

  const override = getEffectiveOverride(toolName);
  if (override === "auto") return "execute";
  if (override === "ask") return "needs_approval";

  if (mode === "auto") {
    const tier = getToolTier(toolName);
    if (tier === "observe") return "execute";
    return "needs_approval";
  }

  // ask mode: all tools need approval
  return "needs_approval";
}

export function getToolRegistry(): Array<{ name: string; label: string; description: string; tier: ToolTier; override: ToolOverride }> {
  const overrides = getToolOverrides();
  return Object.entries(TOOL_LABELS).map(([name, label]) => ({
    name,
    label,
    description: TOOL_DESCRIPTIONS[name] || "",
    tier: getToolTier(name),
    override: (overrides[name] || "default") as ToolOverride,
  }));
}
