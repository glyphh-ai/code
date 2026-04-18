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

  // Layout (sub-agent)
  switch_panel:     "mutate",
  split_view:       "mutate",
  grid_layout:      "mutate",
  swap_cell:        "mutate",
  apply_layout:     "mutate",
  save_layout:      "mutate",
  delete_layout:    "mutate",
  list_layouts:     "observe",
  go_back:          "mutate",
  close_panel:      "mutate",
  add_app:          "mutate",
  zoom:             "observe",

  // Navigator — new tools
  wait_for_response: "observe",
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
  ask_panel:        "mutate",

  // Orchestrator delegations (gated at sub-agent level, but listed for plan mode)
  delegate_navigator:  "mutate",
  delegate_researcher: "observe",
  delegate_manager:    "mutate",
  delegate_layout:     "mutate",
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
  switch_panel:     "Switch panel",
  split_view:       "Split view",
  grid_layout:      "Grid layout",
  swap_cell:        "Swap cell",
  apply_layout:     "Apply layout",
  save_layout:      "Save layout",
  delete_layout:    "Delete layout",
  list_layouts:     "List layouts",
  go_back:          "Go back",
  close_panel:      "Close panel",
  add_app:          "Add app",
  zoom:             "Zoom",
  wait_for_response: "Wait for response",
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
  ask_panel:        "Ask panel",
  delegate_navigator:  "Delegate navigator",
  delegate_researcher: "Delegate researcher",
  delegate_manager:    "Delegate manager",
  delegate_layout:     "Delegate layout",
  delegate_skill:      "Delegate skill runner",
  delegate_coder:      "Delegate coder",
};

/** Short descriptions for the settings table. */
export const TOOL_DESCRIPTIONS: Record<string, string> = {
  list_panels:      "See which workspace panels are open",
  scan_panel:       "Scan a panel's DOM to find inputs, buttons, and content",
  grab_panel:       "Read the full text content from a panel",
  click_element:    "Click a button or link inside a panel",
  navigate_panel:   "Load a URL in a panel",
  type_text:        "Type into an input field on a panel",
  open_panel:       "Open a new visible panel with a URL",
  open_background:  "Open a hidden panel for background data fetching",
  search_notes:     "Search your local .md notes",
  write_note:       "Create or update a local .md note",
  search_files:     "Search filenames on your machine",
  read_file:        "Read the contents of a file",
  list_files:       "List files in a directory",
  manage_skill:     "Create, edit, or delete saved skills",
  manage_layout:    "Save or restore panel layout presets",
  manage_app:       "Add, edit, or remove app configs",
  switch_panel:     "Switch to a single panel fullscreen",
  split_view:       "Create a side-by-side split view",
  grid_layout:      "Create an advanced grid layout with spans",
  swap_cell:        "Replace one panel in the current layout",
  apply_layout:     "Apply a saved layout preset",
  save_layout:      "Save the current layout arrangement",
  delete_layout:    "Delete a saved layout",
  list_layouts:     "List saved layout presets",
  go_back:          "Switch back to previous panel",
  close_panel:      "Close a tab or all tabs",
  add_app:          "Register a new app by URL",
  zoom:             "Get or set workspace zoom level",
  wait_for_response: "Wait for an AI chat panel to finish generating its response",
  screenshot_panel: "Capture a panel as a PNG screenshot",
  refresh_panel:    "Reload a panel's page",
  manage_tabs:      "List, switch, close, or create workspace tabs",
  write_file:       "Write content to a file on disk",
  edit_file:        "Edit an existing file's content",
  move_file:        "Move or rename a file",
  copy_file:        "Copy a file to a new location",
  delete_file:      "Delete a file from disk",
  create_directory: "Create a new folder on disk",
  run_shell:        "Execute a shell command in the terminal",
  inject_text:      "Paste text into the active panel input",
  run_command:      "Execute a pre-mapped app command by name",
  save_memory:      "Save a note to agent long-term memory",
  web_search:       "Search the web via API",
  fetch_page:       "Fetch and extract content from a URL",
  clipboard_read:   "Read the system clipboard contents",
  clipboard_write:  "Write text to the system clipboard",
  set_reminder:     "Schedule a delayed reminder message",
  pipe:             "Pipe content between two panels",
  ask_panel:        "Send a prompt to AI chat panels and get real responses",
  delegate_navigator:  "Delegate a panel interaction task to the navigator",
  delegate_researcher: "Delegate a note/file search to the researcher",
  delegate_manager:    "Delegate a skill/layout/app task to the manager",
  delegate_layout:     "Delegate a workspace layout task to the layout agent",
  delegate_skill:      "Delegate execution to a saved skill",
  delegate_coder:      "Delegate a code editing task to the coder",
};

/** Get the tier for a tool. Hardcoded only — never remote. Defaults to "mutate" for unknown tools. */
export function getToolTier(toolName: string): ToolTier {
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
