/**
 * AppConnector — manages app configs with command-to-DOM mappings.
 *
 * Each app is a panel with a connector: mapped commands that know
 * how to grab, push, submit, etc. against the app's live DOM.
 *
 * Stored as JSON in ~/yo/apps/{id}.json
 */

import fs from "fs";
import path from "path";
import os from "os";

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
  meta?: {
    description: string;
    capabilities: string[];
  };
}

/** Commands every app should map */
export const STANDARD_COMMANDS = [
  { key: "grab", description: "Extract main content/conversation from the page" },
  { key: "push", description: "Inject text into the primary input field" },
  { key: "submit", description: "Trigger send/submit action" },
  { key: "clear", description: "Clear the primary input field" },
  { key: "read", description: "Get current visible page content (lightweight)" },
] as const;

// Default apps — seeded on first launch
const DEFAULT_APPS: Array<{ id: string; name: string; url: string }> = [
  { id: "claude", name: "Claude", url: "https://claude.ai" },
  { id: "gemini", name: "Gemini", url: "https://gemini.google.com" },
  { id: "gpt", name: "ChatGPT", url: "https://chatgpt.com" },
  { id: "code", name: "Claude Code", url: "https://claude.ai/code" },
  { id: "cowork", name: "Cowork", url: "https://claude.ai/cowork" },
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

  /** Seed default apps if they don't already exist */
  private ensureDefaults(): void {
    for (const def of DEFAULT_APPS) {
      if (!this.apps.has(def.id)) {
        this.add(def.id, def.name, def.url);
      }
    }
  }

  /** Add a new app (unconnected) */
  add(id: string, name: string, url: string): AppConfig {
    const app: AppConfig = {
      id,
      name,
      url,
      connected: false,
      commands: {},
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
