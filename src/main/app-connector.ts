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
import { ConfigSync } from "./config-sync";

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
  script?: string; // custom JS for action === "custom"
  waitFor?: string; // selector to wait for before executing
  /** Mini-skill: execution intelligence for reliable automation */
  guide?: CommandGuide;
}

export interface AppConfig {
  id: string;
  name: string;
  url: string;
  connected: boolean;
  commands: Record<string, CommandMapping>;
  /** When true, suppress "open in desktop app" banners and protocol redirects */
  forceWeb?: boolean;
  meta?: {
    description: string;
    category?: string;
    capabilities: string[];
  };
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

// Internal apps — these use yo:// protocol and can't come from the server
const INTERNAL_APPS: Array<{ id: string; name: string; url: string }> = [
  { id: "vscode", name: "VS Code", url: "yo://vscode" },
  { id: "monaco", name: "Monaco", url: "yo://monaco" },
  { id: "term", name: "Terminal", url: "yo://terminal" },
  { id: "dashboard", name: "Dashboard", url: "yo://dashboard" },
  { id: "browser", name: "Browser", url: "yo://browser" },
];

// ── AppConnector ─────────────────────────────────────��──

export class AppConnector {
  private apps: Map<string, AppConfig> = new Map();
  private appsDir: string;

  constructor() {
    this.appsDir = path.join(os.homedir(), "yo", "apps");
    fs.mkdirSync(this.appsDir, { recursive: true });
    this.loadAll();
    this.ensureDefaults();
  }

  /** Seed internal yo:// apps that can't come from the server */
  private ensureDefaults(): void {
    for (const def of INTERNAL_APPS) {
      if (!this.apps.has(def.id)) {
        this.add(def.id, def.name, def.url);
      } else {
        const app = this.apps.get(def.id)!;
        // Ensure yo:// URL stays current
        if (app.url !== def.url) {
          app.url = def.url;
          this.save(app);
        }
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

  /** Merge remote app catalog — adds new apps, updates forceWeb/protocol URLs/commands for existing. */
  mergeRemoteApps(): void {
    const raw = ConfigSync.load<
      | Array<{ app_id?: string; id?: string; name: string; url: string; force_web?: boolean; forceWeb?: boolean; commands?: Record<string, CommandMapping>; meta?: AppConfig["meta"] }>
      | { apps: Array<{ id: string; name: string; url: string; forceWeb?: boolean; commands?: Record<string, CommandMapping>; meta?: AppConfig["meta"] }> }
    >("apps");
    if (!raw) return;
    // Normalize: server returns flat array with app_id/force_web; old format was { apps: [...] } with id/forceWeb
    const list = Array.isArray(raw) ? raw : (raw as { apps: unknown[] }).apps;
    if (!list) return;
    const apps = list.map((a: unknown) => {
      const r = a as Record<string, unknown>;
      return {
        id: (r.app_id || r.id) as string,
        name: r.name as string,
        url: r.url as string,
        forceWeb: (r.force_web ?? r.forceWeb) as boolean | undefined,
        commands: r.commands as Record<string, CommandMapping> | undefined,
        meta: r.meta as AppConfig["meta"] | undefined,
      };
    });
    for (const def of apps) {
      if (!this.apps.has(def.id)) {
        const app = this.add(def.id, def.name, def.url, def.forceWeb);
        // Merge commands from remote catalog
        if (def.commands && Object.keys(def.commands).length > 0) {
          app.commands = { ...def.commands };
          app.connected = true;
          if (def.meta) app.meta = def.meta;
          this.save(app);
        }
      } else {
        const app = this.apps.get(def.id)!;
        let changed = false;
        if (def.forceWeb !== undefined && app.forceWeb !== def.forceWeb) {
          app.forceWeb = def.forceWeb;
          changed = true;
        }
        if (def.url.startsWith("yo://") && app.url !== def.url) {
          app.url = def.url;
          changed = true;
        }
        // Overwrite commands from server catalog (server is source of truth)
        if (def.commands && Object.keys(def.commands).length > 0) {
          app.commands = { ...def.commands };
          app.connected = true;
          if (def.meta) app.meta = def.meta;
          changed = true;
        }
        if (changed) this.save(app);
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
      ...(config.meta ? { meta: config.meta } : {}),
    };
    this.apps.set(app.id, app);
    this.save(app);
    return app;
  }

  /** Add a new app (unconnected) */
  add(id: string, name: string, url: string, forceWeb?: boolean): AppConfig {
    const app: AppConfig = {
      id,
      name,
      url,
      connected: false,
      commands: {},
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

  /** Update an app's ID (renames file and map entry) */
  updateId(oldId: string, newId: string): boolean {
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

  /** Get an app config */
  get(id: string): AppConfig | null {
    return this.apps.get(id) ?? null;
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
