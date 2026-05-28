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

/** Visibility tier. `user` apps show in the Apps registry + Layouts builder.
 *  `system` apps only appear in the `+` picker and via `.dip` — they're the
 *  former left-rail surfaces wrapped as panels. */
export type AppKind = "user" | "system";

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

  /** Where this app shows up. Defaults to "user" (registry + layouts + `+`). */
  kind?: AppKind;
  /** True if the app ships with .Yo (everything in INTERNAL_APPS). Internal
   *  apps are NEVER captured (isDoNotRecord returns true), are HIDDEN from
   *  the Apps registry (no CRUD — can't edit, rename, delete, or change
   *  URL), and stay visible in the `+` picker, `.dip`, and Layouts. The
   *  `kind: "system"` flag separately controls Layouts visibility. */
  internal?: boolean;
  /** True if the app needs a working folder. Folder-bound apps own a picker
   *  in their header (unless mounted inside a folder-bound layout, which
   *  hoists the picker to the layout). */
  requiresFolder?: boolean;

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

// Internal apps — these use yo:// protocol.
// `kind: "system"` apps are hidden from the Apps registry + Layouts builder.
const NO_CAPTURE: CapturePolicy = { type: "manual" };
// Every entry here gets `internal: true` applied below — they all ship
// with .Yo and must never be CRUD-able in the Apps registry, never
// captured, etc. `kind: "system"` is a separate axis controlling whether
// the app appears in Layouts (rail surfaces don't; user-mountable
// internal apps like Agent/Vibe/Spec do).
const INTERNAL_APPS: Array<{ id: string; name: string; url: string; capturePolicy?: CapturePolicy; kind?: AppKind; requiresFolder?: boolean }> = [
  // Boot-time fallback shown when there's no panel state to restore.
  { id: "welcome", name: "Welcome", url: "yo://welcome", capturePolicy: NO_CAPTURE, kind: "system" },
  // Settings — opened from the header gear; no longer in the left rail.
  { id: "home", name: "Settings", url: "yo://home", capturePolicy: NO_CAPTURE, kind: "system" },
  { id: "council", name: "Council", url: "yo://council", capturePolicy: NO_CAPTURE },
  { id: "agent", name: "Agent", url: "yo://agent", capturePolicy: NO_CAPTURE, requiresFolder: true },
  { id: "vibe", name: "Vibe", url: "yo://vibe", capturePolicy: NO_CAPTURE, requiresFolder: true },
  { id: "spec", name: "Spec", url: "yo://spec", capturePolicy: NO_CAPTURE, requiresFolder: true },
  { id: "workbench", name: "Workbench", url: "yo://workbench", capturePolicy: NO_CAPTURE, requiresFolder: true },
  { id: "term", name: "Terminal", url: "yo://terminal", requiresFolder: true },
  { id: "browser", name: "Browser", url: "yo://browser" },

  // Left-rail surfaces — every section becomes its own mountable system app.
  // Slug = panel id, so `.dip apps` and the panel id "apps" match naturally.
  // Reuses home.html scoped to a single section via ?section=<slug>.
  // Hidden from the Apps registry + Layouts builder; visible in `+` and `.dip`.
  { id: "dashboard",  name: "Dashboard",  url: "yo://dashboard",  capturePolicy: NO_CAPTURE, kind: "system" },
  { id: "apps",       name: "Apps",       url: "yo://apps",       capturePolicy: NO_CAPTURE, kind: "system" },
  { id: "agents",     name: "Agents",     url: "yo://agents",     capturePolicy: NO_CAPTURE, kind: "system" },
  { id: "vibes",      name: "Vibes",      url: "yo://vibes",      capturePolicy: NO_CAPTURE, kind: "system" },
  { id: "councils",   name: "Councils",   url: "yo://councils",   capturePolicy: NO_CAPTURE, kind: "system" },
  { id: "schedules",  name: "Schedules",  url: "yo://schedules",  capturePolicy: NO_CAPTURE, kind: "system" },
  { id: "layouts",    name: "Layouts",    url: "yo://layouts",    capturePolicy: NO_CAPTURE, kind: "system" },
  { id: "skills",     name: "Skills",     url: "yo://skills",     capturePolicy: NO_CAPTURE, kind: "system" },
  { id: "drips",      name: "Drips",      url: "yo://drips",      capturePolicy: NO_CAPTURE, kind: "system" },
  { id: "settings",   name: "Settings",   url: "yo://settings",   capturePolicy: NO_CAPTURE, kind: "system" },
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
    // Purge stale internal entries persisted to ~/yo/apps/<id>.json on a
    // prior launch. Dropping them from INTERNAL_APPS alone leaves them in
    // the app list, so we explicitly delete the entry + the file.
    //   - drop, files, vscode, monaco, code, yo-editor  → removed builds
    //   - context                                       → removed feature
    //   - *-app suffixed ids                            → left over from
    //     a Phase 0a rename where each left-rail section briefly used a
    //     "<slug>-app" id alongside the cleaner "<slug>" id, leaving two
    //     of every system app in the + picker on already-installed clients.
    const STALE_IDS = [
      "drop", "files", "vscode", "monaco", "code", "yo-editor",
      "context",
      "agents-app", "apps-app", "councils-app", "drips-app",
      "layouts-app", "schedules-app", "settings-app", "skills-app",
      "vibes-app", "dashboard-app",
    ];
    for (const staleId of STALE_IDS) {
      const stale = this.apps.get(staleId);
      if (stale && stale.url?.startsWith("yo://")) {
        this.apps.delete(staleId);
        try { fs.unlinkSync(path.join(this.appsDir, `${staleId}.json`)); } catch { /* ignore */ }
        console.log(`[app-connector] purged removed internal app: ${staleId}`);
      }
    }

    for (const def of INTERNAL_APPS) {
      if (!this.apps.has(def.id)) {
        const app = this.add(def.id, def.name, def.url);
        app.internal = true;
        let dirty = true; // we just set internal
        if (def.capturePolicy) { app.capturePolicy = def.capturePolicy; dirty = true; }
        if (def.kind) { app.kind = def.kind; dirty = true; }
        if (def.requiresFolder) { app.requiresFolder = def.requiresFolder; dirty = true; }
        if (dirty) this.save(app);
      } else {
        const app = this.apps.get(def.id)!;
        let dirty = false;
        if (app.url !== def.url) { app.url = def.url; dirty = true; }
        if (!app.internal) { app.internal = true; dirty = true; }
        if (def.capturePolicy && app.capturePolicy?.type !== def.capturePolicy.type) { app.capturePolicy = def.capturePolicy; dirty = true; }
        if (def.kind && app.kind !== def.kind) { app.kind = def.kind; dirty = true; }
        if (def.requiresFolder && app.requiresFolder !== def.requiresFolder) { app.requiresFolder = def.requiresFolder; dirty = true; }
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
    // Resolve "<id>-2" / "<id>-3" instance suffixes back to the base app id
    // so e.g. a second Browser panel still respects the base app's policy.
    const baseId = panelId.replace(/-\d+$/, "");
    const app = this.apps.get(panelId) || this.apps.get(baseId);
    // Internal apps (everything in INTERNAL_APPS) are never captured.
    if (app?.internal) return true;
    if (app?.doNotRecord) return true;
    // Domain blocklist against panel URL.
    if (app?.url) return DO_NOT_RECORD_DOMAINS.some((d) => app.url!.includes(d));
    return false;
  }

  /** True when the app ships with .Yo (INTERNAL_APPS). Hides it from the
   *  Apps registry (no CRUD), suppresses capture, but it still mounts. */
  isInternal(id: string): boolean {
    const baseId = id.replace(/-\d+$/, "");
    const app = this.apps.get(id) || this.apps.get(baseId);
    return !!app?.internal;
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
