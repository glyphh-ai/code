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
  protected maxIterations = 6;
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

  /** Expose panel list for orchestrator to inject into instructions. */
  listPanels(): string | null { return this.panelLister ? this.panelLister() : null; }

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
    return `You are a navigation specialist for workspace panels (Gmail, Claude, GPT, Gemini, Slack, etc).

You handle VISUAL interaction — clicking, typing, navigating UI. Data retrieval (emails, events, messages) should use MCP tools at the orchestrator level, not panel grabbing.

RULES:
- scan_panel FIRST for element discovery (~5ms, zero cost). Use click_element/type_text with those selectors.
- grab_panel is EXPENSIVE (~10K tokens per call). ONLY use when explicitly asked for page text or when no other tool can get the information.
- After clicking, use scan_panel to verify the result — NOT grab_panel.
- Prefer run_command when scan shows MAPPED COMMANDS (grab, input, submit, new, search, read-latest, etc).
- Use panel IDs directly. NEVER open_panel for apps already in available panels.
- type_text with submit=true for Enter. Use wait_for_response after submitting to AI chat panels.
- Max 4 click→scan cycles. Return actual content found, not action summaries. Plain text, truncate at ~2000 chars.`;
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
        description: "EXPENSIVE — Grab full visible text content from a panel (~10KB sent to context). Only use when you specifically need text content that scan_panel doesn't provide. Prefer MCP tools for structured data access (emails, events, messages).",
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
        description: "Click an element on a panel by visible text or CSS selector. After clicking, use scan_panel to verify the result.",
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
        description: "Navigate an existing panel to a specific URL within that app. Only use this for navigating to a subpage — NOT for basic app interaction. For reading content, use grab_panel. For clicking, use click_element.",
        input_schema: {
          type: "object",
          properties: {
            panel_id: { type: "string", description: "Panel ID to navigate" },
            url: { type: "string", description: "URL to navigate to (a subpage within the app)" },
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
        description: "Open a NEW app panel that doesn't exist yet. ONLY use this if the app is NOT already in the available panels list. Pass an app name (e.g. 'gemini', 'gmail') — do NOT pass a URL unless the app is truly not registered.",
        input_schema: {
          type: "object",
          properties: {
            url: { type: "string", description: "App name (e.g. 'gemini', 'gmail', 'slack') or full URL (e.g. https://mail.google.com)" },
            panel_id: { type: "string", description: "Optional panel ID. If omitted, one is generated automatically." },
          },
          required: ["url"],
        },
      },
      {
        name: "open_background",
        description: "Open an app in a hidden background panel. ONLY use if the app is NOT already in available panels. The page loads and is interactable but not shown to the user.",
        input_schema: {
          type: "object",
          properties: {
            url: { type: "string", description: "App name (e.g. 'gemini', 'gmail') or full URL" },
            panel_id: { type: "string", description: "Optional panel ID. If omitted, one is generated automatically." },
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
        name: "wait_for_response",
        description: "Wait for an AI chat panel to finish generating a response. Polls the panel content until it stops changing. Use after type_text with submit=true on chat panels (Claude, GPT, Gemini, etc). Returns the final page content once stable.",
        input_schema: {
          type: "object",
          properties: {
            panel_id: { type: "string", description: "Panel ID to watch for response completion" },
            timeout_seconds: { type: "number", description: "Max seconds to wait (default: 45, max: 120)" },
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
        if (!scan) return `Could not scan panel: ${panelId}`;
        return scan.length > 4000 ? scan.slice(0, 4000) + "\n[scan truncated]" : scan;
      }

      case "grab_panel": {
        const panelId = input.panel_id as string;
        if (!this.panelGrabber) return "Panel grabbing not available.";
        const content = await this.panelGrabber(panelId);
        if (!content) return `Could not grab content from panel: ${panelId}`;
        return content.length > 4000 ? content.slice(0, 4000) + "\n[content truncated]" : content;
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
        if (!dataUrl) return `Could not screenshot panel: ${panelId}`;
        // Screenshots are base64 images — too large for text context.
        // Return a short confirmation; the orchestrator handles visual analysis.
        return `Screenshot captured for panel: ${panelId} (${Math.round(dataUrl.length / 1024)}KB image). Use grab_panel or scan_panel to read the content as text.`;
      }

      case "wait_for_response": {
        const panelId = input.panel_id as string;
        const timeoutSec = Math.min(Math.max((input.timeout_seconds as number) || 45, 5), 120);
        if (!this.panelGrabber) return "Panel grabbing not available.";
        const startTime = Date.now();
        const deadline = startTime + timeoutSec * 1000;
        let prevContent = "";
        let stableCount = 0;
        const POLL_MS = 2500;
        const STABLE_THRESHOLD = 2; // content must be unchanged for 2 consecutive polls (~5s)

        while (Date.now() < deadline) {
          if (this.isAborted) return "Aborted while waiting for response.";
          await new Promise((r) => setTimeout(r, POLL_MS));
          const content = await this.panelGrabber(panelId);
          if (!content) { stableCount = 0; prevContent = ""; continue; }
          if (content === prevContent) {
            stableCount++;
            if (stableCount >= STABLE_THRESHOLD) {
              const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
              // Truncate for context efficiency
              const trimmed = content.length > 3000 ? content.slice(-3000) + "\n[earlier content truncated]" : content;
              return `Response complete (${elapsed}s):\n${trimmed}`;
            }
          } else {
            stableCount = 0;
            prevContent = content;
          }
        }
        // Timed out — return whatever we have
        const finalContent = await this.panelGrabber(panelId);
        return finalContent
          ? `Response may still be generating (timed out after ${timeoutSec}s):\n${finalContent.length > 3000 ? finalContent.slice(-3000) : finalContent}`
          : `Timed out after ${timeoutSec}s — could not grab content from ${panelId}.`;
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
