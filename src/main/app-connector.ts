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

export interface CommandMapping {
  selector: string;
  action: "extractText" | "extractHTML" | "setValue" | "click" | "custom";
  description: string;
  script?: string; // custom JS for action === "custom"
  waitFor?: string; // selector to wait for before executing
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
    capabilities: string[];
  };
}

/** Commands every app should map */
export const STANDARD_COMMANDS = [
  { key: "grab", description: "Extract main content/conversation from the page" },
] as const;

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
    const remote = ConfigSync.load<{ apps: Array<{ id: string; name: string; url: string; forceWeb?: boolean; commands?: Record<string, CommandMapping>; meta?: AppConfig["meta"] }> }>("apps");
    if (!remote?.apps) return;
    for (const def of remote.apps) {
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
        // Merge new commands from remote (don't overwrite user-customized ones)
        if (def.commands) {
          for (const [key, cmd] of Object.entries(def.commands)) {
            if (!app.commands[key]) {
              app.commands[key] = cmd;
              changed = true;
            }
          }
          if (changed) {
            app.connected = Object.keys(app.commands).length > 0;
            if (def.meta && !app.meta) app.meta = def.meta;
          }
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
