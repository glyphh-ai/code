/**
 * NavigatorAgent — panel interaction specialist.
 *
 * Handles: list_panels, grab_panel, click_element, navigate_panel, type_text.
 * Knows how to chain navigations to find content in live app panels.
 */

import { BaseSubAgent } from "./base-agent";
import type { ToolDef } from "./types";

export class NavigatorAgent extends BaseSubAgent {
  protected agentName = "navigator";
  private panelGrabber: ((panelId: string) => Promise<string | null>) | null = null;
  private panelClicker: ((panelId: string, text?: string, selector?: string) => Promise<string>) | null = null;
  private panelNavigator: ((panelId: string, url: string) => Promise<string>) | null = null;
  private panelTyper: ((panelId: string, text: string, opts: { label?: string; placeholder?: string; selector?: string; clear?: boolean; submit?: boolean }) => Promise<string>) | null = null;
  private panelLister: (() => string) | null = null;
  private panelScanner: ((panelId: string) => Promise<string | null>) | null = null;
  private panelOpener: ((url: string, panelId?: string) => Promise<string>) | null = null;
  private backgroundOpener: ((url: string, panelId?: string) => Promise<string>) | null = null;
  private commandRunner: ((panelId: string, command: string, value?: string) => Promise<string>) | null = null;
  private panelScreenshotter: ((panelId: string) => Promise<string | null>) | null = null;
  private panelRefresher: ((panelId?: string) => Promise<string>) | null = null;
  private tabManager: {
    list: () => Array<{ id: string; title: string; url?: string }>;
    switch: (id: string) => void;
    close: (id: string) => void;
    create: () => string;
  } | null = null;

  setPanelGrabber(fn: typeof this.panelGrabber): void { this.panelGrabber = fn; }
  setPanelClicker(fn: typeof this.panelClicker): void { this.panelClicker = fn; }
  setPanelNavigator(fn: typeof this.panelNavigator): void { this.panelNavigator = fn; }
  setPanelTyper(fn: typeof this.panelTyper): void { this.panelTyper = fn; }
  setPanelLister(fn: typeof this.panelLister): void { this.panelLister = fn; }
  setPanelScanner(fn: typeof this.panelScanner): void { this.panelScanner = fn; }
  setPanelOpener(fn: typeof this.panelOpener): void { this.panelOpener = fn; }
  setBackgroundOpener(fn: typeof this.backgroundOpener): void { this.backgroundOpener = fn; }
  setCommandRunner(fn: typeof this.commandRunner): void { this.commandRunner = fn; }
  setPanelScreenshotter(fn: typeof this.panelScreenshotter): void { this.panelScreenshotter = fn; }
  setPanelRefresher(fn: typeof this.panelRefresher): void { this.panelRefresher = fn; }
  setTabManager(tm: typeof this.tabManager): void { this.tabManager = tm; }

  get systemPrompt(): string {
    return `You are a navigation specialist. You interact with workspace panels (browser tabs showing apps like Gmail, Claude, GPT, etc).

WORKFLOW:
1. Start with list_panels to see what's available
2. If the panel you need isn't listed, use open_panel to open it (e.g. open_panel with url "https://mail.google.com" for Gmail)
3. Use open_background to load a page in the background without showing it — useful for fetching data without disrupting the user's view
4. Use scan_panel FIRST to get a structured map of inputs, buttons, content areas, and nav items — this is instant and gives you exact selectors
5. Use the scan results to make surgical tool calls: click_element with exact selectors, type_text with exact selectors
6. Use grab_panel only when you need full text content (not for discovering what to click)
7. Chain click → scan cycles to navigate deep into apps (max 4 cycles)

SCAN-FIRST PRINCIPLE:
- ALWAYS scan_panel before clicking or typing — it gives you exact selectors, no guessing
- The scan returns: INPUTS (with type, placeholder, selector), BUTTONS (with text, selector), CONTENT areas, NAV items
- Use the selector from scan results directly in click_element or type_text
- Only fall back to grab_panel if scan_panel returns nothing useful (rare)

MAPPED COMMANDS:
- Some apps include a MAPPED COMMANDS section in the scan result — these are pre-mapped actions with verified selectors and names
- When a mapped command matches what you need to do, use run_command to execute it directly — this is the fastest path
- run_command handles click, setValue, extractText, extractHTML, and custom scripts automatically
- For setValue commands, pass the value parameter (e.g. run_command with command "search" and value "my query")
- ALWAYS prefer run_command over manual click_element/type_text when a mapped command exists — it's faster and more reliable
- Only fall back to scan_panel + manual tools when no mapped command covers what you need

TYPING & SUBMITTING:
- When you type_text into search boxes, chat inputs, or form fields, set submit=true to press Enter.
- For buttons that aren't Enter-triggered, use click_element after type_text.
- Use the selector from scan_panel results for precise targeting.

RESPONSE:
- Return the actual content you found, not a summary of actions taken.
- Truncate very long content to ~2000 chars with "[truncated]" marker.
- If you can't find what was requested after 3-4 attempts, say what you tried and what you saw.
- Plain text only, no markdown.`;
  }

  get tools(): ToolDef[] {
    return [
      {
        name: "list_panels",
        description: "List all available workspace panels with their IDs and URLs.",
        input_schema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "scan_panel",
        description: "Fast zero-LLM scan of a panel's DOM. Returns a structured map of actionable elements: inputs (with type and selector), buttons (with text and selector), content areas, and navigation items. Use this BEFORE clicking or typing to get exact selectors. ~5ms, no LLM cost.",
        input_schema: {
          type: "object",
          properties: {
            panel_id: { type: "string", description: "Panel ID to scan" },
          },
          required: ["panel_id"],
        },
      },
      {
        name: "grab_panel",
        description: "Grab the full visible text content from a workspace panel. Use scan_panel first for element discovery — use this only when you need the actual text content.",
        input_schema: {
          type: "object",
          properties: {
            panel_id: { type: "string", description: "Panel ID to grab content from" },
          },
          required: ["panel_id"],
        },
      },
      {
        name: "click_element",
        description: "Click an element on a panel by visible text or CSS selector. After clicking, use grab_panel to see the result.",
        input_schema: {
          type: "object",
          properties: {
            panel_id: { type: "string", description: "Panel ID to click within" },
            text: { type: "string", description: "Visible text of the element to click" },
            selector: { type: "string", description: "CSS selector to click (fallback if text not provided)" },
          },
          required: ["panel_id"],
        },
      },
      {
        name: "navigate_panel",
        description: "Navigate a panel to a specific URL.",
        input_schema: {
          type: "object",
          properties: {
            panel_id: { type: "string", description: "Panel ID to navigate" },
            url: { type: "string", description: "URL to navigate to" },
          },
          required: ["panel_id", "url"],
        },
      },
      {
        name: "type_text",
        description: "Type text into an input field on a panel. Use submit=true to press Enter after typing.",
        input_schema: {
          type: "object",
          properties: {
            panel_id: { type: "string", description: "Panel ID to type in" },
            text: { type: "string", description: "Text to type" },
            label: { type: "string", description: "Label text near the input" },
            placeholder: { type: "string", description: "Placeholder text of the input" },
            selector: { type: "string", description: "CSS selector for the input" },
            clear: { type: "boolean", description: "Clear existing content first (default: true)" },
            submit: { type: "boolean", description: "Press Enter after typing (default: false)" },
          },
          required: ["panel_id", "text"],
        },
      },
      {
        name: "open_panel",
        description: "Open a URL in a visible workspace panel. Use when the panel you need isn't in list_panels. Returns the panel ID you can use with other tools.",
        input_schema: {
          type: "object",
          properties: {
            url: { type: "string", description: "URL to open (e.g. https://mail.google.com)" },
            panel_id: { type: "string", description: "Optional panel ID. If omitted, one is generated from the URL domain." },
          },
          required: ["url"],
        },
      },
      {
        name: "open_background",
        description: "Open a URL in a hidden background panel. The page loads and is fully interactable (scan, grab, click, type) but is NOT shown to the user. Use for fetching data without disrupting the user's current view.",
        input_schema: {
          type: "object",
          properties: {
            url: { type: "string", description: "URL to open in the background" },
            panel_id: { type: "string", description: "Optional panel ID. If omitted, one is generated from the URL domain." },
          },
          required: ["url"],
        },
      },
      {
        name: "run_command",
        description: "Execute a pre-mapped app command by name. These are verified selectors and actions configured for specific apps. Check the MAPPED COMMANDS section of scan_panel results to see available commands. Much faster and more reliable than manual click/type — always prefer this when a matching command exists.",
        input_schema: {
          type: "object",
          properties: {
            panel_id: { type: "string", description: "Panel ID to run the command on" },
            command: { type: "string", description: "Command name from MAPPED COMMANDS (e.g. 'new', 'search', 'reply', 'grab')" },
            value: { type: "string", description: "Value to pass for setValue commands (e.g. search query, message text)" },
          },
          required: ["panel_id", "command"],
        },
      },
      {
        name: "screenshot_panel",
        description: "Capture a panel as a base64 PNG image for visual analysis. Returns a data URL string. Use when you need to see the visual layout, charts, images, or verify rendering.",
        input_schema: {
          type: "object",
          properties: {
            panel_id: { type: "string", description: "Panel ID to screenshot" },
          },
          required: ["panel_id"],
        },
      },
      {
        name: "refresh_panel",
        description: "Reload a panel's page. Use after editing a local HTML file to see changes.",
        input_schema: {
          type: "object",
          properties: {
            panel_id: { type: "string", description: "Panel ID to refresh. If omitted, refreshes the active panel." },
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

      case "scan_panel": {
        const panelId = input.panel_id as string;
        if (!this.panelScanner) return "Panel scanning not available.";
        const scan = await this.panelScanner(panelId);
        return scan || `Could not scan panel: ${panelId}`;
      }

      case "grab_panel": {
        const panelId = input.panel_id as string;
        if (!this.panelGrabber) return "Panel grabbing not available.";
        const content = await this.panelGrabber(panelId);
        return content || `Could not grab content from panel: ${panelId}`;
      }

      case "click_element": {
        const panelId = input.panel_id as string;
        const text = input.text as string | undefined;
        const selector = input.selector as string | undefined;
        if (!this.panelClicker) return "Click not available.";
        if (!text && !selector) return "Provide either text or selector to click.";
        return this.panelClicker(panelId, text, selector);
      }

      case "navigate_panel": {
        const panelId = input.panel_id as string;
        const url = input.url as string;
        if (!this.panelNavigator) return "Navigation not available.";
        return this.panelNavigator(panelId, url);
      }

      case "type_text": {
        const panelId = input.panel_id as string;
        const text = input.text as string;
        if (!this.panelTyper) return "Typing not available.";
        return this.panelTyper(panelId, text, {
          label: input.label as string | undefined,
          placeholder: input.placeholder as string | undefined,
          selector: input.selector as string | undefined,
          clear: input.clear as boolean | undefined,
          submit: input.submit as boolean | undefined,
        });
      }

      case "open_panel": {
        const url = input.url as string;
        const panelId = input.panel_id as string | undefined;
        if (!this.panelOpener) return "Panel opening not available.";
        return this.panelOpener(url, panelId);
      }

      case "open_background": {
        const url = input.url as string;
        const panelId = input.panel_id as string | undefined;
        if (!this.backgroundOpener) return "Background panel opening not available.";
        return this.backgroundOpener(url, panelId);
      }

      case "run_command": {
        const panelId = input.panel_id as string;
        const command = input.command as string;
        const value = input.value as string | undefined;
        if (!this.commandRunner) return "Command execution not available.";
        return this.commandRunner(panelId, command, value);
      }

      case "screenshot_panel": {
        const panelId = input.panel_id as string;
        if (!this.panelScreenshotter) return "Screenshot not available.";
        const dataUrl = await this.panelScreenshotter(panelId);
        return dataUrl || `Could not screenshot panel: ${panelId}`;
      }

      case "refresh_panel": {
        if (!this.panelRefresher) return "Refresh not available.";
        return this.panelRefresher(input.panel_id as string | undefined);
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
}
