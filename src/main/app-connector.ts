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

// Default apps — seeded on first launch
const DEFAULT_APPS: Array<{ id: string; name: string; url: string; forceWeb?: boolean }> = [
  // ── AI Chat ─────────────────────
  { id: "claude", name: "Claude", url: "https://claude.ai" },
  { id: "gpt", name: "ChatGPT", url: "https://chatgpt.com" },
  { id: "gemini", name: "Gemini", url: "https://gemini.google.com" },
  { id: "copilot", name: "Copilot", url: "https://copilot.microsoft.com" },
  { id: "perplexity", name: "Perplexity", url: "https://perplexity.ai" },
  { id: "grok", name: "Grok", url: "https://grok.com" },
  { id: "mistral", name: "Mistral", url: "https://chat.mistral.ai" },
  { id: "deepseek", name: "DeepSeek", url: "https://chat.deepseek.com" },
  { id: "poe", name: "Poe", url: "https://poe.com" },
  { id: "pi", name: "Pi", url: "https://pi.ai" },
  { id: "you", name: "You", url: "https://you.com" },
  { id: "phind", name: "Phind", url: "https://phind.com" },
  { id: "cohere", name: "Cohere", url: "https://coral.cohere.com" },
  { id: "huggingface", name: "HuggingFace", url: "https://huggingface.co/chat" },
  { id: "meta", name: "Meta AI", url: "https://meta.ai" },

  // ── AI Creative ─────────────────
  { id: "midjourney", name: "Midjourney", url: "https://midjourney.com" },
  { id: "runway", name: "Runway", url: "https://app.runwayml.com" },
  { id: "suno", name: "Suno", url: "https://suno.com" },
  { id: "udio", name: "Udio", url: "https://udio.com" },
  { id: "ideogram", name: "Ideogram", url: "https://ideogram.ai" },
  { id: "leonardo", name: "Leonardo", url: "https://app.leonardo.ai" },

  // ── AI Dev ──────────────────────
  { id: "replit", name: "Replit", url: "https://replit.com" },
  { id: "v0", name: "v0", url: "https://v0.dev" },
  { id: "bolt", name: "Bolt", url: "https://bolt.new" },
  { id: "stackblitz", name: "StackBlitz", url: "https://stackblitz.com" },
  { id: "codepen", name: "CodePen", url: "https://codepen.io" },
  { id: "codesandbox", name: "CodeSandbox", url: "https://codesandbox.io" },
  { id: "vscode", name: "VS Code", url: "yo://vscode" },
  { id: "github-dev", name: "GitHub.dev", url: "https://github.dev" },
  { id: "monaco", name: "Monaco", url: "yo://monaco" },

  // ── Dev Platforms ───────────────
  { id: "github", name: "GitHub", url: "https://github.com" },
  { id: "gitlab", name: "GitLab", url: "https://gitlab.com" },
  { id: "bitbucket", name: "Bitbucket", url: "https://bitbucket.org" },
  { id: "stackoverflow", name: "StackOverflow", url: "https://stackoverflow.com" },
  { id: "npm", name: "npm", url: "https://npmjs.com" },
  { id: "docker", name: "Docker", url: "https://hub.docker.com" },
  { id: "pypi", name: "PyPI", url: "https://pypi.org" },

  // ── Cloud / Deploy ──────────────
  { id: "vercel", name: "Vercel", url: "https://vercel.com" },
  { id: "netlify", name: "Netlify", url: "https://app.netlify.com" },
  { id: "railway", name: "Railway", url: "https://railway.app" },
  { id: "supabase", name: "Supabase", url: "https://supabase.com/dashboard" },
  { id: "firebase", name: "Firebase", url: "https://console.firebase.google.com" },
  { id: "aws", name: "AWS", url: "https://console.aws.amazon.com" },
  { id: "render", name: "Render", url: "https://dashboard.render.com" },
  { id: "fly", name: "Fly", url: "https://fly.io" },
  { id: "cloudflare", name: "Cloudflare", url: "https://dash.cloudflare.com" },
  { id: "digitalocean", name: "DigitalOcean", url: "https://cloud.digitalocean.com" },

  // ── Productivity ────────────────
  { id: "notion", name: "Notion", url: "https://notion.so", forceWeb: true },
  { id: "linear", name: "Linear", url: "https://linear.app" },
  { id: "asana", name: "Asana", url: "https://app.asana.com" },
  { id: "trello", name: "Trello", url: "https://trello.com" },
  { id: "monday", name: "Monday", url: "https://monday.com" },
  { id: "clickup", name: "ClickUp", url: "https://app.clickup.com" },
  { id: "airtable", name: "Airtable", url: "https://airtable.com" },
  { id: "coda", name: "Coda", url: "https://coda.io" },
  { id: "todoist", name: "Todoist", url: "https://todoist.com" },
  { id: "jira", name: "Jira", url: "https://jira.atlassian.com" },

  // ── Communication ───────────────
  { id: "slack", name: "Slack", url: "https://app.slack.com", forceWeb: true },
  { id: "discord", name: "Discord", url: "https://discord.com/app", forceWeb: true },
  { id: "teams", name: "Teams", url: "https://teams.microsoft.com", forceWeb: true },
  { id: "zoom", name: "Zoom", url: "https://app.zoom.us", forceWeb: true },
  { id: "telegram", name: "Telegram", url: "https://web.telegram.org" },
  { id: "whatsapp", name: "WhatsApp", url: "https://web.whatsapp.com" },
  { id: "messenger", name: "Messenger", url: "https://messenger.com" },

  // ── Email ───────────────────────
  { id: "gmail", name: "Gmail", url: "https://mail.google.com" },
  { id: "outlook", name: "Outlook", url: "https://outlook.live.com" },
  { id: "proton", name: "Proton", url: "https://mail.proton.me" },
  { id: "superhuman", name: "Superhuman", url: "https://mail.superhuman.com" },
  { id: "fastmail", name: "Fastmail", url: "https://app.fastmail.com" },

  // ── Design ──────────────────────
  { id: "figma", name: "Figma", url: "https://figma.com" },
  { id: "canva", name: "Canva", url: "https://canva.com" },
  { id: "miro", name: "Miro", url: "https://miro.com" },
  { id: "excalidraw", name: "Excalidraw", url: "https://excalidraw.com" },
  { id: "framer", name: "Framer", url: "https://framer.com" },

  // ── Docs / Writing ──────────────
  { id: "docs", name: "Google Docs", url: "https://docs.google.com" },
  { id: "sheets", name: "Google Sheets", url: "https://docs.google.com/spreadsheets" },
  { id: "slides", name: "Google Slides", url: "https://docs.google.com/presentation" },
  { id: "overleaf", name: "Overleaf", url: "https://overleaf.com" },
  { id: "dropbox", name: "Dropbox", url: "https://dropbox.com" },
  { id: "drive", name: "Google Drive", url: "https://drive.google.com" },

  // ── Search ──────────────────────
  { id: "google", name: "Google", url: "https://google.com" },
  { id: "duckduckgo", name: "DuckDuckGo", url: "https://duckduckgo.com" },
  { id: "brave", name: "Brave Search", url: "https://search.brave.com" },

  // ── Social / Content ────────────
  { id: "twitter", name: "Twitter", url: "https://x.com" },
  { id: "reddit", name: "Reddit", url: "https://reddit.com" },
  { id: "youtube", name: "YouTube", url: "https://youtube.com" },
  { id: "linkedin", name: "LinkedIn", url: "https://linkedin.com" },
  { id: "hackernews", name: "Hacker News", url: "https://news.ycombinator.com" },
  { id: "producthunt", name: "Product Hunt", url: "https://producthunt.com" },
  { id: "medium", name: "Medium", url: "https://medium.com" },
  { id: "substack", name: "Substack", url: "https://substack.com" },

  // ── Finance ─────────────────────
  { id: "stripe", name: "Stripe", url: "https://dashboard.stripe.com" },
  { id: "mercury", name: "Mercury", url: "https://mercury.com" },
  { id: "wise", name: "Wise", url: "https://wise.com" },

  // ── Analytics / Monitoring ──────
  { id: "posthog", name: "PostHog", url: "https://app.posthog.com" },
  { id: "amplitude", name: "Amplitude", url: "https://app.amplitude.com" },
  { id: "mixpanel", name: "Mixpanel", url: "https://mixpanel.com" },
  { id: "datadog", name: "Datadog", url: "https://app.datadoghq.com" },
  { id: "sentry", name: "Sentry", url: "https://sentry.io" },

  // ── Knowledge ───────────────────
  { id: "wikipedia", name: "Wikipedia", url: "https://wikipedia.org" },
  { id: "wolfram", name: "Wolfram", url: "https://wolframalpha.com" },
  { id: "arxiv", name: "arXiv", url: "https://arxiv.org" },

  // ── Utilities ───────────────────
  { id: "calendar", name: "Calendar", url: "https://calendar.google.com" },
  { id: "maps", name: "Maps", url: "https://maps.google.com" },
  { id: "translate", name: "Translate", url: "https://translate.google.com" },
  { id: "spotify", name: "Spotify", url: "https://open.spotify.com" },

  // ── Terminal ────────────────────
  { id: "term", name: "Terminal", url: "yo://terminal" },

  // ── Browser ────────────────────
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

  /** Seed default apps if they don't already exist, and sync forceWeb/url from defaults */
  private ensureDefaults(): void {
    for (const def of DEFAULT_APPS) {
      if (!this.apps.has(def.id)) {
        this.add(def.id, def.name, def.url, def.forceWeb);
      } else {
        const app = this.apps.get(def.id)!;
        let changed = false;
        // Upgrade existing configs with forceWeb when defaults specify it
        if (def.forceWeb !== undefined && app.forceWeb !== def.forceWeb) {
          app.forceWeb = def.forceWeb;
          changed = true;
        }
        // Upgrade VS Code URL from vscode.dev to yo://vscode
        if (def.url.startsWith("yo://") && app.url !== def.url) {
          app.url = def.url;
          changed = true;
        }
        if (changed) this.save(app);
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
