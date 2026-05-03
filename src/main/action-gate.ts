/**
 * Action Gate — tool tier registry and permission gating.
 *
 * Each tool is classified as "observe" (read-only, safe) or "mutate" (side effects).
 * The gate checks the current mode + per-tool overrides to decide whether a tool
 * call should execute, wait for user approval, or be skipped.
 *
 * Mode names match the Claude Agent SDK's `permissionMode` values 1:1 so the
 * mode can be passed straight through to `sdk.query({ options: { permissionMode } })`.
 */

import { getPreference } from "./preferences";
import { isDestructiveTool } from "./substrate/tools";

export type AgentMode = "plan" | "default" | "acceptEdits" | "bypassPermissions";
export type ToolTier = "observe" | "mutate";
export type ToolOverride = "default" | "auto" | "ask" | "off";

export type GateDecision = "execute" | "needs_approval" | "skip";

const TOOL_TIERS: Record<string, ToolTier> = {
  // Orchestrator tools
  search_captures:   "observe",
  get_context:       "observe",
  format:            "observe",
  save_memory:       "observe",
  search_notes:      "observe",
  read_file:         "observe",
  list_files:        "observe",
  run_command:       "observe",
  delegate_navigate: "observe",
  delegate_layout:   "observe",
  // Navigator sub-agent tools
  list_panels:       "observe",
  scan_panel:        "observe",
  grab_panel:        "observe",
  click_element:     "mutate",
  navigate_panel:    "mutate",
  type_text:         "mutate",
  open_panel:        "mutate",
  open_background:   "mutate",
  screenshot_panel:  "observe",
  wait_for_response: "observe",
  refresh_panel:     "mutate",
  // Layout sub-agent tools
  switch_panel:      "mutate",
  split_view:        "mutate",
  grid_layout:       "mutate",
  swap_cell:         "mutate",
  apply_layout:      "mutate",
  save_layout:       "mutate",
  delete_layout:     "mutate",
  list_layouts:      "observe",
  go_back:           "mutate",
  close_panel:       "mutate",
  add_app:           "mutate",
  zoom:              "observe",
  manage_tabs:       "mutate",
};

export const TOOL_LABELS: Record<string, string> = {
  // Orchestrator tools
  search_captures:   "Search captures",
  get_context:       "Get session context",
  format:            "Format with skill",
  save_memory:       "Save memory",
  search_notes:      "Search notes",
  read_file:         "Read file",
  list_files:        "List files",
  run_command:       "Run command",
  delegate_navigate: "Navigate panels",
  delegate_layout:   "Arrange layout",
  // Navigator sub-agent tools
  list_panels:       "List panels",
  scan_panel:        "Scan panel",
  grab_panel:        "Grab panel content",
  click_element:     "Click element",
  navigate_panel:    "Navigate panel",
  type_text:         "Type text",
  open_panel:        "Open panel",
  open_background:   "Open in background",
  screenshot_panel:  "Screenshot panel",
  wait_for_response: "Wait for response",
  refresh_panel:     "Refresh panel",
  // Layout sub-agent tools
  switch_panel:      "Switch panel",
  split_view:        "Split view",
  grid_layout:       "Grid layout",
  swap_cell:         "Swap cell",
  apply_layout:      "Apply layout",
  save_layout:       "Save layout",
  delete_layout:     "Delete layout",
  list_layouts:      "List layouts",
  go_back:           "Go back",
  close_panel:       "Close panel",
  add_app:           "Add app",
  zoom:              "Zoom",
  manage_tabs:       "Manage tabs",
};

export const TOOL_DESCRIPTIONS: Record<string, string> = {
  // Orchestrator tools
  search_captures:   "Vector search across all captured content",
  get_context:       "Read current session context (in-memory captures)",
  format:            "Apply a skill to format content",
  save_memory:       "Save a preference or pattern to agent memory",
  search_notes:      "Keyword search across saved notes in ~/yo/notes/",
  read_file:         "Read a file from the local filesystem",
  list_files:        "List files in a directory",
  run_command:       "Run a read-only shell command (git log, ls, etc.)",
  delegate_navigate: "Sub-agent: scan, click, type, navigate app panels",
  delegate_layout:   "Sub-agent: split views, grids, tabs, workspace layout",
  // Navigator sub-agent tools
  list_panels:       "List all open panel IDs",
  scan_panel:        "Read visible DOM content from a panel",
  grab_panel:        "Extract full page content from a panel",
  click_element:     "Click a button, link, or interactive element",
  navigate_panel:    "Navigate a panel to a URL",
  type_text:         "Type text into a focused input field",
  open_panel:        "Open a new panel with an app or URL",
  open_background:   "Open a hidden panel for background loading",
  screenshot_panel:  "Capture a screenshot of a panel",
  wait_for_response: "Wait for a panel to finish loading",
  refresh_panel:     "Reload a panel",
  // Layout sub-agent tools
  switch_panel:      "Switch the active/focused panel",
  split_view:        "Split the view into multiple panels",
  grid_layout:       "Arrange panels in a grid",
  swap_cell:         "Swap two panel positions in the grid",
  apply_layout:      "Apply a saved layout by name",
  save_layout:       "Save the current layout with a name",
  delete_layout:     "Delete a saved layout",
  list_layouts:      "List all saved layouts",
  go_back:           "Navigate the active panel back",
  close_panel:       "Close a panel",
  add_app:           "Add an app to the workspace",
  zoom:              "Zoom in or out on a panel",
  manage_tabs:       "Open, close, or switch browser tabs",
};

export function getToolTier(toolName: string): ToolTier {
  if (TOOL_TIERS[toolName]) return TOOL_TIERS[toolName];
  // Unknown tool (MCP, user skill, etc.) → ask substrate.
  // Substrate flags destructive ops via explicit `destructive: true` plus
  // a name-keyword fallback (send|delete|remove|publish|push|deploy|destroy).
  return isDestructiveTool(toolName) ? "mutate" : "observe";
}

export function getToolOverrides(): Record<string, ToolOverride> {
  return getPreference<Record<string, ToolOverride>>("toolOverrides", {});
}

function getEffectiveOverride(toolName: string): ToolOverride {
  const overrides = getToolOverrides();
  return overrides[toolName] || "default";
}

export function getAgentMode(): AgentMode {
  const raw = getPreference<string>("agentMode", "default");
  if (raw === "bypass") return "bypassPermissions";
  return raw as AgentMode;
}

export function gate(toolName: string, mode: AgentMode): GateDecision {
  if (mode === "plan") return "skip";

  // bypassPermissions: the user explicitly opted into "run everything, no
  // questions". Per-tool overrides are deliberately ignored.
  if (mode === "bypassPermissions") return "execute";

  const override = getEffectiveOverride(toolName);
  if (override === "off") return "skip";
  if (override === "auto") return "execute";
  if (override === "ask") return "needs_approval";

  if (mode === "acceptEdits") {
    const tier = getToolTier(toolName);
    if (tier === "observe") return "execute";
    return "needs_approval";
  }

  // default mode: all tools need approval
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
