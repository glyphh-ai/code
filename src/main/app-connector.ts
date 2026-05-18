/**
 * AppConnector — manages app configs with command-to-DOM mappings.
 *
 * Each app is a panel with a connector: mapped commands that know
 * how to grab content against the app's live DOM.
 *
 * Stored as JSON in ~/yo/apps/{id}.json
 */

import fs from "fs";
import path from "path";
import os from "os";
// ── Types ───────────────────────────────────────────────

/** Execution intelligence attached to a command — makes the agent reliable. */
export interface CommandGuide {
  /** What must be true before running, e.g. "compose window must be open" */
  pre?: string;
  /** What to expect after success, e.g. "email is sent, compose window closes" */
  post?: string;
  /** CSS selector to check after execution — confirms success */
  verify?: string;
  /** What to try if the command fails, e.g. "try the icon button instead" */
  recover?: string;
  /** Milliseconds to wait after executing before checking verify */
  delay?: number;
}

export interface CommandMapping {
  selector: string;
  action: "extractText" | "extractHTML" | "setValue" | "click" | "custom";
  description: string;
  text?: string; // element text for fallback matching when selector fails
  script?: string; // custom JS for action === "custom"
  waitFor?: string; // selector to wait for before executing
  /** Mini-skill: execution intelligence for reliable automation */
  guide?: CommandGuide;
}

export type CapturePolicyType = "append" | "versioned" | "deduplicate" | "incremental" | "sliding-window" | "manual";

export interface CapturePolicy {
  type: CapturePolicyType;
  maxVersions?: number;    // versioned: keep last N ingestions (default 3)
  windowHours?: number;    // sliding-window: prune entries older than N hours (default 24)
  minDeltaChars?: number;  // incremental: minimum new chars to store (default 50)
}

// ── Panel tab: UI-driven interaction via DOM ──
export interface PanelConfig {
  commands: Record<string, CommandMapping>;
}

// ── Connection tab: API-driven via Pipedream OAuth ──
export interface ConnectionConfig {
  pipedreamSlug: string;
  accountId?: string;
  healthy?: boolean;
}

// ── MCP tab: external tool server ──
export interface McpConfig {
  transport: "stdio" | "sse" | "streamable-http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
}

export interface AppConfig {
  id: string;
  name: string;

  // ── Dashboard ──
  url?: string;
  forceWeb?: boolean;
  doNotRecord?: boolean;
  capturePolicy?: CapturePolicy;
  meta?: {
    description: string;
    category?: string;
    capabilities: string[];
  };

  // ── Panel (UI-driven) ──
  connected: boolean;
  commands: Record<string, CommandMapping>;
  panel?: PanelConfig;

  // ── Connection (Pipedream API) ──
  connection?: ConnectionConfig;

  // ── MCP (external tool server) ──
  mcp?: McpConfig;
}

/** Commands every app should map */
export const STANDARD_COMMANDS = [
  { key: "grab", description: "Extract main content/conversation from the page" },
  { key: "input", description: "Focus the primary text input (chat box, compose field, search bar)" },
  { key: "submit", description: "Click the primary submit/send button" },
  { key: "new", description: "Start a new item (new chat, compose email, new document)" },
  { key: "search", description: "Focus or open the search interface" },
] as const;

/** Category-specific commands the connector agent should discover */
export const CATEGORY_COMMANDS: Record<string, Array<{ key: string; description: string }>> = {
  chat: [
    { key: "read-latest", description: "Extract the most recent response/message" },
    { key: "list-threads", description: "List conversation threads in sidebar" },
    { key: "new-chat", description: "Start a new conversation" },
    { key: "stop", description: "Stop/cancel an in-progress generation" },
    { key: "copy-last", description: "Copy the last assistant response" },
  ],
  email: [
    { key: "compose", description: "Open compose/new email window" },
    { key: "reply", description: "Reply to the current email" },
    { key: "inbox", description: "Navigate to inbox" },
    { key: "read-email", description: "Extract the currently open email content" },
    { key: "to-field", description: "Focus the To recipient field" },
    { key: "subject-field", description: "Focus the Subject field" },
    { key: "body-field", description: "Focus the email body field" },
    { key: "send", description: "Click the send button" },
  ],
  project: [
    { key: "create-item", description: "Create a new issue/task/ticket" },
    { key: "list-items", description: "List visible issues/tasks" },
    { key: "comment", description: "Add a comment to the current item" },
    { key: "assign", description: "Open the assignee picker" },
    { key: "status", description: "Open the status/state picker" },
  ],
  docs: [
    { key: "new-doc", description: "Create a new document" },
    { key: "title-field", description: "Focus the document title" },
    { key: "body-field", description: "Focus the document body editor" },
    { key: "share", description: "Open the share dialog" },
  ],
  social: [
    { key: "post", description: "Open new post/tweet composer" },
    { key: "feed", description: "Extract visible feed content" },
    { key: "notifications", description: "Navigate to notifications" },
    { key: "like", description: "Like/heart the focused item" },
  ],
  code: [
    { key: "file-tree", description: "Extract the visible file tree" },
    { key: "open-file", description: "Open the file finder/picker" },
    { key: "terminal", description: "Focus or open the terminal" },
    { key: "run", description: "Run/execute the current file or test" },
  ],
  search: [
    { key: "read-result", description: "Click/open the first search result" },
    { key: "images", description: "Switch to image search results" },
    { key: "news", description: "Switch to news search results" },
  ],
};

/** Script to extract all open editor content from VS Code via Monaco's AMD loader */
const VSCODE_GRAB_SCRIPT = `
  return await new Promise(function(resolve) {
    if (!window.require) { resolve('VS Code editor not ready'); return; }
    try {
      window.require(['vs/editor/editor.main'], function(monaco) {
        try {
          var models = monaco.editor.getModels();
          if (!models || models.length === 0) { resolve('No files open'); return; }
          var parts = models.map(function(m) {
            var uri = m.uri.toString();
            // Clean up URI: file:///path/to/file.ts → path/to/file.ts
            var name = uri.replace(/^file:\\/\\/\\//, '').replace(/^[^:]+:\\/\\//, '');
            var lang = m.getLanguageId() || '';
            var content = m.getValue();
            return '## ' + name + (lang ? ' (' + lang + ')' : '') + '\\n\\n' +
              '\\x60\\x60\\x60' + lang + '\\n' + content + '\\n\\x60\\x60\\x60';
          });
          resolve(parts.join('\\n\\n---\\n\\n'));
        } catch(e) { resolve('Error reading editors: ' + e.message); }
      });
    } catch(e) { resolve('Monaco not available: ' + e.message); }
    // Timeout fallback
    setTimeout(function() { resolve('Monaco require timed out'); }, 5000);
  });
`;

// Internal apps — these use yo:// protocol
// Note: yo://cypher (the legacy Meet-style panel) was retired in favor of
// The Drop's Workspace view. Source files (code-workspace.html/.ts/.preload)
// are kept on disk for now as a reference to mine richer streaming UI from.
const NO_CAPTURE: CapturePolicy = { type: "manual" };
const INTERNAL_APPS: Array<{ id: string; name: string; url: string; capturePolicy?: CapturePolicy }> = [
  { id: "home", name: "Settings", url: "yo://home", capturePolicy: NO_CAPTURE },
  { id: "council", name: "Council", url: "yo://council", capturePolicy: NO_CAPTURE },
  { id: "vscode", name: "VS Code", url: "yo://vscode" },
  { id: "monaco", name: "Monaco", url: "yo://monaco" },
  { id: "files", name: ".Yo Editor", url: "yo://files", capturePolicy: NO_CAPTURE },
  { id: "term", name: "Terminal", url: "yo://terminal" },
  { id: "browser", name: "Browser", url: "yo://browser" },
  { id: "context", name: "Context", url: "yo://context", capturePolicy: NO_CAPTURE },
];

// Default panel apps — seeded on first launch so the workspace isn't empty
const DEFAULT_APPS: Array<{ id: string; name: string; url: string; forceWeb?: boolean; pipedreamSlug?: string }> = [
  // LLMs (no Pipedream — UI-only)
  { id: "chatgpt", name: "ChatGPT", url: "https://chatgpt.com" },
  { id: "claude", name: "Claude", url: "https://claude.ai" },
  { id: "gemini", name: "Gemini", url: "https://gemini.google.com" },
  { id: "grok", name: "Grok", url: "https://grok.com" },
  { id: "perplexity", name: "Perplexity", url: "https://perplexity.ai" },
  // Productivity (panel + Pipedream API available)
  { id: "gmail", name: "Gmail", url: "https://mail.google.com", pipedreamSlug: "gmail" },
  { id: "calendar", name: "Google Calendar", url: "https://calendar.google.com", pipedreamSlug: "google_calendar" },
  { id: "github", name: "GitHub", url: "https://github.com", pipedreamSlug: "github" },
  { id: "slack", name: "Slack", url: "https://app.slack.com", forceWeb: true, pipedreamSlug: "slack" },
  { id: "notion", name: "Notion", url: "https://notion.so", forceWeb: true, pipedreamSlug: "notion" },
];

// Domains that default to doNotRecord — banking, health, finance, passwords
const DO_NOT_RECORD_DOMAINS = [
  // Banking
  "chase.com", "bankofamerica.com", "wellsfargo.com", "citi.com", "citibank.com",
  "usbank.com", "capitalone.com", "ally.com", "discover.com", "tdbank.com",
  "pnc.com", "schwab.com", "fidelity.com", "vanguard.com", "etrade.com",
  "merilledge.com", "ameriprise.com", "regions.com", "suntrust.com", "truist.com",
  "marcus.com", "sofi.com", "chime.com",
  // Payments / Fintech
  "paypal.com", "venmo.com", "zelle.com", "stripe.com/dashboard", "square.com",
  "robinhood.com", "coinbase.com", "binance.com", "kraken.com",
  // Health / Insurance
  "myuhc.com", "anthem.com", "cigna.com", "aetna.com", "humana.com",
  "bcbs.com", "medicare.gov", "mychart.com", "epic.com",
  // Password managers
  "vault.bitwarden.com", "my.1password.com", "lastpass.com", "dashlane.com",
  // Tax / Government
  "irs.gov", "turbotax.intuit.com", "hrblock.com", "ssa.gov",
];

// Conversational apps — multiple grabs of the same window should diff, not duplicate
const CONVERSATIONAL_DOMAINS = [
  "chatgpt.com", "claude.ai", "gemini.google.com", "grok.com", "perplexity.ai",
  "app.slack.com", "discord.com", "teams.microsoft.com", "messages.google.com",
  "web.whatsapp.com", "messenger.com",
];

// Feed/dashboard apps — content is ephemeral, keep a sliding window
const EPHEMERAL_DOMAINS = [
  "youtube.com", "twitter.com", "x.com", "reddit.com", "news.ycombinator.com",
  "linkedin.com/feed",
];

// Document apps — static content, deduplicate
const DOCUMENT_DOMAINS = [
  "docs.google.com", "sheets.google.com", "slides.google.com",
  "notion.so", "notebooklm.google.com", "figma.com",
  "mail.google.com", "outlook.live.com", "calendar.google.com",
];

function inferCapturePolicy(source: string, url?: string): CapturePolicy {
  const domain = url || source;

  // Code file sources from the sup hook (e.g. "help.ts", "main.ts")
  if (/\.\w{1,5}$/.test(source) && !source.includes("/")) {
    return { type: "versioned", maxVersions: 3 };
  }

  if (CONVERSATIONAL_DOMAINS.some((d) => domain.includes(d))) {
    return { type: "deduplicate" };
  }

  if (EPHEMERAL_DOMAINS.some((d) => domain.includes(d))) {
    return { type: "sliding-window", windowHours: 48 };
  }

  if (DOCUMENT_DOMAINS.some((d) => domain.includes(d))) {
    return { type: "deduplicate" };
  }

  // MCP / external pushes
  if (source === "cloud-sync") return { type: "append" };

  // Default: deduplicate is safe for unknown sources
  return { type: "deduplicate" };
}

// ── AppConnector ───────────────────────────────────────

export class AppConnector {
  private apps: Map<string, AppConfig> = new Map();
  private appsDir: string;

  constructor() {
    this.appsDir = path.join(os.homedir(), "yo", "apps");
    fs.mkdirSync(this.appsDir, { recursive: true });
    this.loadAll();
    this.ensureDefaults();
  }

  /** Seed internal + default apps on first launch */
  private ensureDefaults(): void {
    for (const def of INTERNAL_APPS) {
      if (!this.apps.has(def.id)) {
        const app = this.add(def.id, def.name, def.url);
        if (def.capturePolicy) { app.capturePolicy = def.capturePolicy; this.save(app); }
      } else {
        const app = this.apps.get(def.id)!;
        let dirty = false;
        if (app.url !== def.url) { app.url = def.url; dirty = true; }
        if (def.capturePolicy && app.capturePolicy?.type !== def.capturePolicy.type) { app.capturePolicy = def.capturePolicy; dirty = true; }
        if (dirty) this.save(app);
      }
    }

    // Seed default panel apps only if none exist yet (fresh install)
    const hasUserApps = [...this.apps.values()].some((a) => a.url && !a.url.startsWith("yo://"));
    if (!hasUserApps) {
      for (const def of DEFAULT_APPS) {
        if (!this.apps.has(def.id)) {
          this.add(def.id, def.name, def.url, def.forceWeb);
        }
      }
    }

    // Ensure known Pipedream slugs are set on default apps
    for (const def of DEFAULT_APPS) {
      if (!def.pipedreamSlug) continue;
      const app = this.apps.get(def.id);
      if (app && !app.connection) {
        app.connection = { pipedreamSlug: def.pipedreamSlug };
        this.save(app);
      }
    }


    // Ensure VS Code has a grab command that uses Monaco API
    const vscode = this.apps.get("vscode");
    if (vscode && !vscode.commands.grab) {
      vscode.commands.grab = {
        selector: "",
        action: "custom",
        description: "Extract all open editor content via Monaco API",
        script: VSCODE_GRAB_SCRIPT,
      };
      this.save(vscode);
    }
  }

  /** Import a full app config (from exported JSON). Overwrites if same id exists. */
  importApp(config: AppConfig): AppConfig {
    const app: AppConfig = {
      id: config.id,
      name: config.name,
      url: config.url,
      connected: Object.keys(config.commands || {}).length > 0,
      commands: config.commands || {},
      ...(config.forceWeb ? { forceWeb: config.forceWeb } : {}),
      ...(config.doNotRecord ? { doNotRecord: config.doNotRecord } : {}),
      ...(config.meta ? { meta: config.meta } : {}),
    };
    this.apps.set(app.id, app);
    this.save(app);
    return app;
  }

  /** Add a new app */
  add(id: string, name: string, url?: string, forceWeb?: boolean): AppConfig {
    const app: AppConfig = {
      id,
      name,
      connected: false,
      commands: {},
      ...(url ? { url } : {}),
      ...(forceWeb ? { forceWeb } : {}),
    };
    this.apps.set(id, app);
    this.save(app);
    return app;
  }

  /** Update an app's name */
  updateName(id: string, name: string): boolean {
    const app = this.apps.get(id);
    if (!app) return false;
    app.name = name;
    this.save(app);
    return true;
  }

  updateUrl(id: string, url: string): boolean {
    const app = this.apps.get(id);
    if (!app) return false;
    app.url = url;
    this.save(app);
    return true;
  }

  updateForceWeb(id: string, forceWeb: boolean): boolean {
    const app = this.apps.get(id);
    if (!app) return false;
    if (forceWeb) {
      app.forceWeb = true;
    } else {
      delete app.forceWeb;
    }
    this.save(app);
    return true;
  }

  updateDoNotRecord(id: string, doNotRecord: boolean): boolean {
    const app = this.apps.get(id);
    if (!app) return false;
    if (doNotRecord) {
      app.doNotRecord = true;
    } else {
      delete app.doNotRecord;
    }
    this.save(app);
    return true;
  }

  /** Check if a panel/URL should be excluded from recording. */
  isDoNotRecord(panelId: string): boolean {
    // Direct app match
    const app = this.apps.get(panelId);
    if (app?.doNotRecord) return true;
    // Check domain blocklist against panel URL
    if (app?.url) return DO_NOT_RECORD_DOMAINS.some((d) => app.url!.includes(d));
    return false;
  }

  /** Check if a panel is a conversational app (chat, messaging). */
  isConversational(panelId: string): boolean {
    const app = this.apps.get(panelId);
    const domain = app?.url || panelId;
    return CONVERSATIONAL_DOMAINS.some((d) => domain.includes(d));
  }

  /** Get the capture policy for a source. Falls back to smart defaults. */
  getCapturePolicy(source: string): CapturePolicy {
    const app = this.apps.get(source);
    if (app?.capturePolicy) return app.capturePolicy;
    if (app?.doNotRecord) return { type: "manual" };
    return inferCapturePolicy(source, app?.url);
  }

  /** Update an app's capture policy */
  updateCapturePolicy(id: string, policy: CapturePolicy): boolean {
    const app = this.apps.get(id);
    if (!app) return false;
    app.capturePolicy = policy;
    this.save(app);
    return true;
  }

  /** Update an app's ID (renames file and map entry) */
  updateId(oldId: string, newId: string): boolean {
    newId = newId.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    if (!newId || oldId === newId) return false;
    const app = this.apps.get(oldId);
    if (!app || this.apps.has(newId)) return false;
    // Remove old file
    const oldPath = path.join(this.appsDir, `${oldId}.json`);
    try { fs.unlinkSync(oldPath); } catch { /* ok */ }
    // Update map
    this.apps.delete(oldId);
    app.id = newId;
    this.apps.set(newId, app);
    this.save(app);
    return true;
  }

  /** Check if an ID is a directly registered app (not an instance resolution) */
  hasDirect(id: string): boolean {
    return this.apps.has(id);
  }

  /** Get an app config */
  get(id: string): AppConfig | null {
    const direct = this.apps.get(id);
    if (direct) return direct;
    // Instance IDs: "gmail-2" → "gmail", "browse-3" → "browser"
    if (id.startsWith("browse-")) return this.apps.get("browser") ?? null;
    const dash = id.lastIndexOf("-");
    if (dash > 0 && /^\d+$/.test(id.slice(dash + 1))) {
      return this.apps.get(id.slice(0, dash)) ?? null;
    }
    return null;
  }

  /** List all apps */
  list(): AppConfig[] {
    return Array.from(this.apps.values());
  }

  /** Update an app's command mappings (from agent or picker) */
  updateCommands(id: string, commands: Record<string, CommandMapping>, meta?: AppConfig["meta"]): boolean {
    const app = this.apps.get(id);
    if (!app) return false;
    app.commands = { ...app.commands, ...commands };
    if (meta) app.meta = meta;
    app.connected = Object.keys(app.commands).length > 0;
    this.save(app);
    return true;
  }

  /** Update a single command mapping (from DOM picker) */
  setCommand(id: string, commandKey: string, mapping: CommandMapping): boolean {
    const app = this.apps.get(id);
    if (!app) return false;
    app.commands[commandKey] = mapping;
    app.connected = true;
    this.save(app);
    return true;
  }

  /** Remove a command mapping */
  removeCommand(id: string, commandKey: string): boolean {
    const app = this.apps.get(id);
    if (!app) return false;
    delete app.commands[commandKey];
    app.connected = Object.keys(app.commands).length > 0;
    this.save(app);
    return true;
  }

  /** Delete an app entirely */
  remove(id: string): boolean {
    if (!this.apps.has(id)) return false;
    this.apps.delete(id);
    const filePath = path.join(this.appsDir, `${id}.json`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return true;
  }

  // ── Connection (Pipedream) ─────────────────────────

  setConnection(id: string, connection: ConnectionConfig): boolean {
    const app = this.apps.get(id);
    if (!app) return false;
    app.connection = connection;
    this.save(app);
    return true;
  }

  removeConnection(id: string): boolean {
    const app = this.apps.get(id);
    if (!app || !app.connection) return false;
    delete app.connection;
    this.save(app);
    return true;
  }

  /** All apps that have a Pipedream connection configured */
  listConnected(): AppConfig[] {
    return [...this.apps.values()].filter((a) => a.connection?.accountId);
  }

  /** Find an app by its Pipedream slug */
  findByPipedreamSlug(slug: string): AppConfig | null {
    for (const app of this.apps.values()) {
      if (app.connection?.pipedreamSlug === slug) return app;
    }
    return null;
  }

  // ── MCP (external tool server) ─────────────────────

  setMcp(id: string, mcp: McpConfig): boolean {
    const app = this.apps.get(id);
    if (!app) return false;
    app.mcp = mcp;
    this.save(app);
    return true;
  }

  updateMcp(id: string, updates: Partial<McpConfig>): boolean {
    const app = this.apps.get(id);
    if (!app || !app.mcp) return false;
    app.mcp = { ...app.mcp, ...updates };
    this.save(app);
    return true;
  }

  removeMcp(id: string): boolean {
    const app = this.apps.get(id);
    if (!app || !app.mcp) return false;
    delete app.mcp;
    this.save(app);
    return true;
  }

  /** All apps that have an MCP server configured */
  listMcp(): AppConfig[] {
    return [...this.apps.values()].filter((a) => a.mcp);
  }

  /** Get MCP configs in the format McpManager expects */
  getMcpConfigs(): Array<McpConfig & { id: string; name: string }> {
    return this.listMcp().map((a) => ({
      ...a.mcp!,
      id: a.id,
      name: a.name,
    }));
  }

  // ── Persistence ─────────────────────────────────────

  private save(app: AppConfig): void {
    fs.writeFileSync(
      path.join(this.appsDir, `${app.id}.json`),
      JSON.stringify(app, null, 2),
      "utf-8",
    );
  }

  private loadAll(): void {
    if (!fs.existsSync(this.appsDir)) return;
    for (const file of fs.readdirSync(this.appsDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = fs.readFileSync(path.join(this.appsDir, file), "utf-8");
        const app: AppConfig = JSON.parse(raw);
        this.apps.set(app.id, app);
      } catch {
        // skip corrupt files
      }
    }
  }
}
