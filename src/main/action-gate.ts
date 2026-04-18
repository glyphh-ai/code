/**
 * Action Gate — tool tier registry and permission gating.
 *
 * Each tool is classified as "observe" (read-only, safe) or "mutate" (side effects).
 * The gate checks the current mode + per-tool overrides to decide whether a tool
 * call should execute, wait for user approval, or be skipped.
 */

import { getPreference } from "./preferences";
import { ConfigSync } from "./config-sync";

export type AgentMode = "plan" | "ask" | "auto";
export type ToolTier = "observe" | "mutate";
export type ToolOverride = "default" | "auto" | "ask";

/** Gate decision for a single tool call. */
export type GateDecision = "execute" | "needs_approval" | "skip";

/** All known tools and their default tiers. */
const TOOL_TIERS: Record<string, ToolTier> = {
  // Navigator (sub-agent)
  list_panels:      "observe",
  scan_panel:       "observe",
  grab_panel:       "observe",
  click_element:    "mutate",
  navigate_panel:   "mutate",
  type_text:        "mutate",
  open_panel:       "mutate",
  open_background:  "mutate",

  // Researcher (sub-agent)
  search_notes:     "observe",
  write_note:       "mutate",
  search_files:     "observe",
  read_file:        "observe",
  list_files:       "observe",

  // Manager (sub-agent)
  manage_skill:     "mutate",
  manage_layout:    "mutate",
  manage_app:       "mutate",

  // Navigator — new tools
  screenshot_panel: "observe",
  refresh_panel:    "mutate",
  manage_tabs:      "mutate",

  // Coding agent (sub-agent)
  write_file:       "mutate",
  edit_file:        "mutate",
  move_file:        "mutate",
  copy_file:        "mutate",
  delete_file:      "mutate",
  create_directory: "mutate",
  run_shell:        "mutate",

  // Orchestrator direct tools
  inject_text:      "mutate",
  run_command:      "mutate",
  save_memory:      "observe",
  web_search:       "observe",
  fetch_page:       "observe",
  clipboard_read:   "observe",
  clipboard_write:  "mutate",
  set_reminder:     "observe",
  pipe:             "mutate",

  // Orchestrator delegations (gated at sub-agent level, but listed for plan mode)
  delegate_navigator:  "mutate",
  delegate_researcher: "observe",
  delegate_manager:    "mutate",
  delegate_skill:      "mutate",
  delegate_coder:      "mutate",
};

/** Human-readable labels for each tool (used in approval UI and settings). */
export const TOOL_LABELS: Record<string, string> = {
  list_panels:      "List panels",
  scan_panel:       "Scan panel DOM",
  grab_panel:       "Grab panel content",
  click_element:    "Click element",
  navigate_panel:   "Navigate panel",
  type_text:        "Type text",
  open_panel:       "Open panel",
  open_background:  "Open background panel",
  search_notes:     "Search notes",
  write_note:       "Write note",
  search_files:     "Search files",
  read_file:        "Read file",
  list_files:       "List files",
  manage_skill:     "Manage skills",
  manage_layout:    "Manage layouts",
  manage_app:       "Manage apps",
  screenshot_panel: "Screenshot panel",
  refresh_panel:    "Refresh panel",
  manage_tabs:      "Manage tabs",
  write_file:       "Write file",
  edit_file:        "Edit file",
  move_file:        "Move file",
  copy_file:        "Copy file",
  delete_file:      "Delete file",
  create_directory: "Create directory",
  run_shell:        "Run shell command",
  inject_text:      "Inject text",
  run_command:      "Run command",
  save_memory:      "Save memory",
  web_search:       "Web search",
  fetch_page:       "Fetch page",
  clipboard_read:   "Read clipboard",
  clipboard_write:  "Write clipboard",
  set_reminder:     "Set reminder",
  pipe:             "Pipe cross-panel",
  delegate_coder:   "Delegate coder",
};

/** Get the tier for a tool. Checks remote config first, falls back to hardcoded, defaults to "mutate". */
export function getToolTier(toolName: string): ToolTier {
  const remote = ConfigSync.load<{ toolTiers: Record<string, ToolTier> }>("guardrails");
  if (remote?.toolTiers?.[toolName]) return remote.toolTiers[toolName];
  return TOOL_TIERS[toolName] || "mutate";
}

/** Get persisted per-tool overrides. */
export function getToolOverrides(): Record<string, ToolOverride> {
  return getPreference<Record<string, ToolOverride>>("toolOverrides", {});
}

/** Get the effective override for a specific tool. */
function getEffectiveOverride(toolName: string): ToolOverride {
  const overrides = getToolOverrides();
  return overrides[toolName] || "default";
}

/** Get the persisted agent mode (default: "ask"). */
export function getAgentMode(): AgentMode {
  return getPreference<AgentMode>("agentMode", "ask");
}

/**
 * Decide whether a tool call should execute, needs approval, or be skipped.
 *
 * @param toolName - The tool being called
 * @param mode - Current agent mode (plan/ask/auto)
 * @returns GateDecision
 */
export function gate(toolName: string, mode: AgentMode): GateDecision {
  // Plan mode: nothing executes
  if (mode === "plan") return "skip";

  const override = getEffectiveOverride(toolName);

  // Per-tool override takes precedence
  if (override === "auto") return "execute";
  if (override === "ask") return "needs_approval";

  // "default" — fall through to mode logic
  if (mode === "auto") return "execute";

  // Ask mode: observe tools execute freely, mutate tools need approval
  const tier = getToolTier(toolName);
  if (tier === "observe") return "execute";
  return "needs_approval";
}

/** Return the full tool registry for the settings UI. */
export function getToolRegistry(): Array<{ name: string; label: string; tier: ToolTier; override: ToolOverride }> {
  const overrides = getToolOverrides();
  return Object.entries(TOOL_LABELS).map(([name, label]) => ({
    name,
    label,
    tier: getToolTier(name),
    override: (overrides[name] || "default") as ToolOverride,
  }));
}
