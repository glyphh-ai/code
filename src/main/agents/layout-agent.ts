/**
 * LayoutAgent — workspace layout and navigation specialist.
 *
 * Owns everything about panel arrangement: split views, grids, saved layouts,
 * tab management, zoom, swapping cells. Translates high-level layout requests
 * into dip commands via the command runner.
 *
 * Tools compose dip/waz commands internally — the agent never needs to
 * construct raw command strings.
 */

import { BaseSubAgent } from "./base-agent";
import type { ToolDef } from "./types";

export class LayoutAgent extends BaseSubAgent {
  protected agentName = "layout";
  protected maxIterations = 6;

  private commandRunner: ((cmd: string) => Promise<string>) | null = null;
  private panelLister: (() => string) | null = null;
  private layoutCallbacks: {
    list: () => Array<{ name: string; cols: number; rows: number; cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }> }>;
    save: (name: string, panels: string) => boolean;
    delete: (name: string) => boolean;
  } | null = null;
  private tabManager: {
    list: () => Array<{ id: string; title: string; url?: string }>;
    switch: (id: string) => void;
    close: (id: string) => void;
    create: () => string;
  } | null = null;

  setCommandRunner(fn: typeof this.commandRunner): void { this.commandRunner = fn; }
  setPanelLister(fn: typeof this.panelLister): void { this.panelLister = fn; }
  setLayoutCallbacks(cbs: typeof this.layoutCallbacks): void { this.layoutCallbacks = cbs; }
  setTabManager(tm: typeof this.tabManager): void { this.tabManager = tm; }

  get systemPrompt(): string {
    return `You are a workspace layout specialist. You arrange panels in the user's workspace — splits, grids, tabs, saved layouts.

TOOLS:
- list_panels: see available apps/panels
- switch_panel: show a single panel fullscreen
- split_view: side-by-side panels (2-4 panels, optional multi-row with /)
- grid_layout: advanced grid with spans and custom widths/heights
- swap_cell: replace one panel in the current layout with another
- apply_layout: apply a saved layout by name
- save_layout: save the current arrangement
- delete_layout: remove a saved layout
- list_layouts: see saved layouts
- go_back: return to previous panel
- close_panel: close a tab (or all tabs)
- add_app: register a new app by URL
- zoom: get or set zoom level
- manage_tabs: list, switch, close, or create tabs

LAYOUT PATTERNS:
- "side by side" / "split" / "compare" / "debate" → split_view with 2 panels
- "2x2" / "quad" → grid_layout with 4 panels in 2 rows
- "3 columns" → split_view with 3 panels
- "big left, small right" → grid_layout with custom widths [2,1]
- "email + chat" → split_view with gmail and the chat app
- "research mode" → grid_layout with multiple AI panels

GRID FEATURES:
- Column spans: a panel can span multiple columns (e.g. panel:2 spans 2 cols)
- Row spans: a panel can span multiple rows (e.g. panel:1|2 spans 2 rows)
- Custom column widths: proportional values [2,1] = 66%/33%
- Custom row heights: proportional values [3,1] = 75%/25%
- Row separators: / divides rows (e.g. "claude gemini / gpt grok" = 2x2)

RESPONSE:
- Confirm what you set up: "Split: claude | gemini" or "Grid: 2x2 with claude, gemini, gpt, grok"
- Plain text only, no markdown
- Be concise — one line is ideal`;
  }

  get tools(): ToolDef[] {
    return [
      {
        name: "list_panels",
        description: "List all available workspace panels/apps with their IDs and URLs.",
        input_schema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "switch_panel",
        description: "Switch to a single panel fullscreen, clearing any split/grid.",
        input_schema: {
          type: "object",
          properties: {
            panel_id: { type: "string", description: "Panel ID to switch to (e.g. 'claude', 'gmail', 'gpt')" },
          },
          required: ["panel_id"],
        },
      },
      {
        name: "split_view",
        description: "Create a split view with 2+ panels side by side. Use / to create multiple rows. Examples: 'claude gemini' (2 cols), 'claude gemini gpt' (3 cols), 'claude gemini / gpt grok' (2x2 grid).",
        input_schema: {
          type: "object",
          properties: {
            panels: { type: "string", description: "Space-separated panel IDs. Use / between rows. E.g. 'claude gemini', 'gmail slack linear', 'claude gemini / gpt grok'" },
          },
          required: ["panels"],
        },
      },
      {
        name: "grid_layout",
        description: "Create an advanced grid layout with optional column spans, row spans, and custom sizes. Panels can span multiple columns (panel:2) or rows (panel:1|2). Custom widths/heights are proportional values.",
        input_schema: {
          type: "object",
          properties: {
            panels: { type: "string", description: "Panel cells with optional spans. Use / between rows. E.g. 'claude:2 gemini / gpt grok deepseek' (claude spans 2 cols)" },
            col_widths: { type: "string", description: "Optional comma-separated column width proportions. E.g. '2,1' for 66%/33%, '1,2,1' for 25%/50%/25%" },
            row_heights: { type: "string", description: "Optional comma-separated row height proportions. E.g. '3,1' for 75%/25%" },
          },
          required: ["panels"],
        },
      },
      {
        name: "swap_cell",
        description: "Replace a panel in the current grid/split layout with a different panel. Only the specified cell changes — the rest of the layout stays intact.",
        input_schema: {
          type: "object",
          properties: {
            target_panel: { type: "string", description: "Panel ID to swap IN (the new panel)" },
            source_panel: { type: "string", description: "Panel ID to swap OUT (optional — swaps the active cell if omitted)" },
          },
          required: ["target_panel"],
        },
      },
      {
        name: "apply_layout",
        description: "Apply a previously saved layout by name.",
        input_schema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Name of the saved layout to apply" },
          },
          required: ["name"],
        },
      },
      {
        name: "save_layout",
        description: "Save the current panel arrangement as a named layout for reuse.",
        input_schema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Name for this layout (e.g. 'research', 'email-chat', 'debate')" },
          },
          required: ["name"],
        },
      },
      {
        name: "delete_layout",
        description: "Delete a saved layout by name.",
        input_schema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Name of the layout to delete" },
          },
          required: ["name"],
        },
      },
      {
        name: "list_layouts",
        description: "List all saved layouts with their panel configurations.",
        input_schema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "go_back",
        description: "Switch back to the previous panel.",
        input_schema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "close_panel",
        description: "Close a specific tab, or close all tabs.",
        input_schema: {
          type: "object",
          properties: {
            panel_id: { type: "string", description: "Panel ID to close. Use 'all' to close all tabs. Omit to close the active tab." },
          },
        },
      },
      {
        name: "add_app",
        description: "Register a new app by URL and open it as a panel.",
        input_schema: {
          type: "object",
          properties: {
            url: { type: "string", description: "URL of the app to add (e.g. 'https://figma.com')" },
          },
          required: ["url"],
        },
      },
      {
        name: "zoom",
        description: "Get or set the workspace zoom level.",
        input_schema: {
          type: "object",
          properties: {
            level: { type: "string", description: "Zoom level (0.5-2.0) or 'reset'. Omit to get current zoom." },
          },
        },
      },
      {
        name: "manage_tabs",
        description: "Manage workspace tabs: list all tabs, switch to a tab, close a tab, or create a new empty tab.",
        input_schema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["list", "switch", "close", "new"], description: "Action to perform" },
            tab_id: { type: "string", description: "Tab ID (required for switch/close)" },
          },
          required: ["action"],
        },
      },
    ];
  }

  async execTool(name: string, input: Record<string, unknown>): Promise<string> {
    switch (name) {
      case "list_panels":
        return this.panelLister ? this.panelLister() : "Panel listing not available.";

      case "switch_panel": {
        const panelId = input.panel_id as string;
        if (!panelId) return "Panel ID required.";
        return this.runDip(`dip ${panelId}`);
      }

      case "split_view": {
        const panels = input.panels as string;
        if (!panels) return "Panel IDs required.";
        return this.runDip(`dip split ${panels}`);
      }

      case "grid_layout": {
        const panels = input.panels as string;
        if (!panels) return "Panel cells required.";
        const colWidths = input.col_widths as string | undefined;
        const rowHeights = input.row_heights as string | undefined;
        let cmd = "dip grid";
        if (colWidths) cmd += ` [${colWidths}]`;
        if (rowHeights) cmd += ` [${rowHeights}]`;
        cmd += ` ${panels}`;
        return this.runDip(cmd);
      }

      case "swap_cell": {
        const target = input.target_panel as string;
        if (!target) return "Target panel ID required.";
        // dip . <target> — swaps the active cell (or source_panel cell)
        // The command parser handles source panel via sourcePanelId
        return this.runDip(`dip . ${target}`);
      }

      case "apply_layout": {
        const layoutName = input.name as string;
        if (!layoutName) return "Layout name required.";
        return this.runDip(`dip ${layoutName}`);
      }

      case "save_layout": {
        const layoutName = input.name as string;
        if (!layoutName) return "Layout name required.";
        return this.runDip(`waz layout ${layoutName}`);
      }

      case "delete_layout": {
        const layoutName = input.name as string;
        if (!layoutName) return "Layout name required.";
        if (!this.layoutCallbacks) return "Layout manager not available.";
        return this.layoutCallbacks.delete(layoutName)
          ? `Layout "${layoutName}" deleted.`
          : `Layout "${layoutName}" not found.`;
      }

      case "list_layouts": {
        if (!this.layoutCallbacks) return "Layout manager not available.";
        const layouts = this.layoutCallbacks.list();
        if (!layouts.length) return "No saved layouts.";
        return layouts.map((l) => {
          const panels = l.cells.map((c) => c.panelId).join(", ");
          return `${l.name} (${l.cols}x${l.rows}: ${panels})`;
        }).join("\n");
      }

      case "go_back":
        return this.runDip("dip back");

      case "close_panel": {
        const panelId = input.panel_id as string | undefined;
        return this.runDip(panelId ? `dip close ${panelId}` : "dip close");
      }

      case "add_app": {
        const url = input.url as string;
        if (!url) return "URL required.";
        return this.runDip(`dip add ${url}`);
      }

      case "zoom": {
        const level = input.level as string | undefined;
        return this.runDip(level ? `dip zoom ${level}` : "dip zoom");
      }

      case "manage_tabs": {
        if (!this.tabManager) return "Tab management not available.";
        const action = input.action as string;
        switch (action) {
          case "list": {
            const tabs = this.tabManager.list();
            if (tabs.length === 0) return "No tabs open.";
            return tabs.map((t) => `${t.id} — ${t.title}${t.url ? ` (${t.url})` : ""}`).join("\n");
          }
          case "switch": {
            const id = input.tab_id as string;
            if (!id) return "Provide tab_id to switch to.";
            this.tabManager.switch(id);
            return `Switched to tab: ${id}`;
          }
          case "close": {
            const id = input.tab_id as string;
            if (!id) return "Provide tab_id to close.";
            this.tabManager.close(id);
            return `Closed tab: ${id}`;
          }
          case "new": {
            const id = this.tabManager.create();
            return `Created new tab: ${id}`;
          }
          default: return `Unknown tab action: ${action}`;
        }
      }

      default:
        return `Unknown tool: ${name}`;
    }
  }

  /** Run a dip/waz command via the command runner. */
  private async runDip(cmd: string): Promise<string> {
    if (!this.commandRunner) return "Command runner not available.";
    try {
      return await this.commandRunner(cmd);
    } catch (err) {
      return `Command failed: ${err instanceof Error ? err.message : err}`;
    }
  }
}
