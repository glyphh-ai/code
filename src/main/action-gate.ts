/**
 * Action Gate — permission mode helpers and tool label registry.
 *
 * Mode names match the Claude Agent SDK's `permissionMode` values 1:1 so the
 * mode can be passed straight through to `sdk.query({ options: { permissionMode } })`.
 *
 * The SDK's native permission handling governs tool execution. This module
 * provides mode persistence, label lookups for the approval UI, and the
 * gate() function that maps mode → decision without per-tool overrides.
 */

import { getPreference } from "./preferences";
import { isDestructiveTool } from "./substrate/tools";

export type AgentMode = "plan" | "default" | "acceptEdits" | "bypassPermissions";
export type ToolTier = "observe" | "mutate";

export type GateDecision = "execute" | "needs_approval" | "skip";

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
  // Council tools
  council_create:      "Create council",
  council_broadcast:   "Run council round",
  council_interject:   "Interject in council",
  council_ask_member:  "Ask council member",
  council_stop:        "Stop council",
  council_status:      "Council status",
  council_summarize:   "Summarize council",
  council_list_models: "List council models",
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
  // Council tools
  council_create:      "Create a multi-LLM debate session",
  council_broadcast:   "Run the next round of the council",
  council_interject:   "Insert a moderator note into the council",
  council_ask_member:  "Send a targeted question to a specific council member",
  council_stop:        "Halt all in-flight council members",
  council_status:      "Read the current council state",
  council_summarize:   "Produce and save a council summary",
  council_list_models: "List available models for council members",
};

export function getToolTier(toolName: string): ToolTier {
  return isDestructiveTool(toolName) ? "mutate" : "observe";
}

export function getAgentMode(): AgentMode {
  const raw = getPreference<string>("agentMode", "default");
  if (raw === "bypass") return "bypassPermissions";
  if (raw === "council") return "default";
  return raw as AgentMode;
}

export function gate(toolName: string, mode: AgentMode): GateDecision {
  if (mode === "plan") return "skip";
  if (mode === "bypassPermissions") return "execute";
  if (mode === "acceptEdits") {
    return getToolTier(toolName) === "observe" ? "execute" : "needs_approval";
  }
  return "needs_approval";
}
