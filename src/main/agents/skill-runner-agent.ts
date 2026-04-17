/**
 * SkillRunnerAgent — executes skill workflows with full tool access.
 *
 * Unlike specialists (which have narrow tool sets), the SkillRunner gets
 * ALL tools: navigation, research, management, injection, commands.
 * Its system prompt is dynamically set from the skill being executed.
 *
 * This makes skills reusable agent behaviors — not just text transforms.
 * A skill can grab panels, search notes, click through apps, type into
 * inputs, run commands, and compose results.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { BaseSubAgent } from "./base-agent";
import type { ToolDef } from "./types";
import type { NoteStore } from "../note-store";
import type { AppConnector } from "../app-connector";

export class SkillRunnerAgent extends BaseSubAgent {
  // Skill prompt — set dynamically before each execute()
  private skillPrompt: string = "";

  // Navigation callbacks
  private panelGrabber: ((panelId: string) => Promise<string | null>) | null = null;
  private panelClicker: ((panelId: string, text?: string, selector?: string) => Promise<string>) | null = null;
  private panelNavigator: ((panelId: string, url: string) => Promise<string>) | null = null;
  private panelTyper: ((panelId: string, text: string, opts: { label?: string; placeholder?: string; selector?: string; clear?: boolean; submit?: boolean }) => Promise<string>) | null = null;
  private panelLister: (() => string) | null = null;
  private panelScanner: ((panelId: string) => Promise<string | null>) | null = null;
  private panelOpener: ((url: string, panelId?: string) => Promise<string>) | null = null;
  private backgroundOpener: ((url: string, panelId?: string) => Promise<string>) | null = null;

  // Research callbacks
  private noteStore: NoteStore | null = null;

  // Management callbacks
  private appConnector: AppConnector | null = null;
  private skillCallbacks: {
    list: () => string[];
    read: (name: string) => string | null;
    create: (name: string, prompt: string) => void;
    remove: (name: string) => boolean;
  } | null = null;
  private layoutCallbacks: {
    list: () => Array<{ name: string; cols: number; rows: number; cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }> }>;
    save: (name: string, panels: string) => boolean;
    delete: (name: string) => boolean;
  } | null = null;

  // Direct tool callbacks
  private injector: ((text: string) => Promise<boolean>) | null = null;
  private commandRunner: ((cmd: string) => Promise<string>) | null = null;

  // Allow more iterations since skills can be complex workflows
  protected maxIterations = 10;

  // ── Setters ───────────────────────────────────────────

  setSkillPrompt(prompt: string): void { this.skillPrompt = prompt; }
  setPanelGrabber(fn: typeof this.panelGrabber): void { this.panelGrabber = fn; }
  setPanelClicker(fn: typeof this.panelClicker): void { this.panelClicker = fn; }
  setPanelNavigator(fn: typeof this.panelNavigator): void { this.panelNavigator = fn; }
  setPanelTyper(fn: typeof this.panelTyper): void { this.panelTyper = fn; }
  setPanelLister(fn: typeof this.panelLister): void { this.panelLister = fn; }
  setPanelScanner(fn: typeof this.panelScanner): void { this.panelScanner = fn; }
  setPanelOpener(fn: typeof this.panelOpener): void { this.panelOpener = fn; }
  setBackgroundOpener(fn: typeof this.backgroundOpener): void { this.backgroundOpener = fn; }
  setNoteStore(store: NoteStore): void { this.noteStore = store; }
  setAppConnector(ac: AppConnector): void { this.appConnector = ac; }
  setSkillCallbacks(cbs: typeof this.skillCallbacks): void { this.skillCallbacks = cbs; }
  setLayoutCallbacks(cbs: typeof this.layoutCallbacks): void { this.layoutCallbacks = cbs; }
  setInjector(fn: typeof this.injector): void { this.injector = fn; }
  setCommandRunner(fn: typeof this.commandRunner): void { this.commandRunner = fn; }

  // ── System prompt (dynamic from skill) ────────────────

  get systemPrompt(): string {
    return `You are a skill executor with full access to the workspace. Execute the skill described below.

SKILL INSTRUCTIONS:
${this.skillPrompt || "No skill prompt provided — act as a general assistant."}

AVAILABLE CAPABILITIES:
- Navigate apps: list_panels, grab_panel, click_element, navigate_panel, type_text
- Search/save: search_notes, write_note, search_files, read_file, list_files
- Manage: manage_skill, manage_layout, manage_app
- Output: inject_text (paste into user's input field), run_command (dip/drip)

RULES:
- Execute the skill's instructions completely
- Chain multiple tools as needed to accomplish the goal
- When typing into apps, use submit=true to press Enter
- Return the final result to the orchestrator — actual content, not action summaries
- Plain text only unless the skill specifically asks for formatted output`;
  }

  // ── All tools combined ────────────────────────────────

  get tools(): ToolDef[] {
    return [
      // Navigation
      { name: "list_panels", description: "List all workspace panels with IDs and URLs.", input_schema: { type: "object", properties: {} } },
      { name: "scan_panel", description: "Fast DOM scan — returns structured map of inputs, buttons, content, nav with exact selectors. Use before clicking/typing.", input_schema: { type: "object", properties: { panel_id: { type: "string", description: "Panel ID" } }, required: ["panel_id"] } },
      { name: "grab_panel", description: "Grab full visible text content from a panel. Use scan_panel first for element discovery.", input_schema: { type: "object", properties: { panel_id: { type: "string", description: "Panel ID" } }, required: ["panel_id"] } },
      { name: "click_element", description: "Click an element by text or selector.", input_schema: { type: "object", properties: { panel_id: { type: "string", description: "Panel ID" }, text: { type: "string", description: "Visible text to click" }, selector: { type: "string", description: "CSS selector fallback" } }, required: ["panel_id"] } },
      { name: "navigate_panel", description: "Navigate a panel to a URL.", input_schema: { type: "object", properties: { panel_id: { type: "string", description: "Panel ID" }, url: { type: "string", description: "URL" } }, required: ["panel_id", "url"] } },
      { name: "type_text", description: "Type text into an input. Use submit=true to press Enter.", input_schema: { type: "object", properties: { panel_id: { type: "string", description: "Panel ID" }, text: { type: "string", description: "Text to type" }, label: { type: "string" }, placeholder: { type: "string" }, selector: { type: "string" }, clear: { type: "boolean" }, submit: { type: "boolean", description: "Press Enter after typing" } }, required: ["panel_id", "text"] } },
      { name: "open_panel", description: "Open a URL in a visible workspace panel.", input_schema: { type: "object", properties: { url: { type: "string", description: "URL to open" }, panel_id: { type: "string", description: "Optional panel ID" } }, required: ["url"] } },
      { name: "open_background", description: "Open a URL in a hidden background panel — interactable but not shown.", input_schema: { type: "object", properties: { url: { type: "string", description: "URL to open" }, panel_id: { type: "string", description: "Optional panel ID" } }, required: ["url"] } },
      // Research
      { name: "search_notes", description: "Search saved notes.", input_schema: { type: "object", properties: { query: { type: "string", description: "Search query" }, limit: { type: "number" } }, required: ["query"] } },
      { name: "write_note", description: "Save a note.", input_schema: { type: "object", properties: { title: { type: "string" }, content: { type: "string" } }, required: ["title", "content"] } },
      { name: "search_files", description: "Search file contents.", input_schema: { type: "object", properties: { pattern: { type: "string" }, directory: { type: "string" }, file_pattern: { type: "string" } }, required: ["pattern"] } },
      { name: "read_file", description: "Read a file.", input_schema: { type: "object", properties: { path: { type: "string" }, max_lines: { type: "number" } }, required: ["path"] } },
      { name: "list_files", description: "List files at a path.", input_schema: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" }, recursive: { type: "boolean" } } } },
      // Management
      { name: "manage_skill", description: "CRUD for skills.", input_schema: { type: "object", properties: { action: { type: "string", enum: ["create", "list", "read", "delete"] }, name: { type: "string" }, prompt: { type: "string" } }, required: ["action"] } },
      { name: "manage_layout", description: "CRUD for layouts.", input_schema: { type: "object", properties: { action: { type: "string", enum: ["save", "list", "delete"] }, name: { type: "string" }, panels: { type: "string" } }, required: ["action"] } },
      { name: "manage_app", description: "CRUD for apps.", input_schema: { type: "object", properties: { action: { type: "string", enum: ["add", "list", "remove"] }, id: { type: "string" }, name: { type: "string" }, url: { type: "string" } }, required: ["action"] } },
      // Output
      { name: "inject_text", description: "Paste text into the user's input field.", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
      { name: "run_command", description: "Run a .dip or .drip command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
    ];
  }

  // ── Tool dispatch ─────────────────────────────────────

  async execTool(name: string, input: Record<string, unknown>): Promise<string> {
    try {
      switch (name) {
        // Navigation
        case "list_panels": return this.panelLister ? this.panelLister() : "Panel listing not available.";
        case "scan_panel": return this.panelScanner ? (await this.panelScanner(input.panel_id as string) || "No scan results.") : "Not available.";
        case "grab_panel": return this.panelGrabber ? (await this.panelGrabber(input.panel_id as string) || "No content.") : "Not available.";
        case "click_element": {
          if (!this.panelClicker) return "Not available.";
          const text = input.text as string | undefined;
          const sel = input.selector as string | undefined;
          if (!text && !sel) return "Provide text or selector.";
          return this.panelClicker(input.panel_id as string, text, sel);
        }
        case "navigate_panel": return this.panelNavigator ? this.panelNavigator(input.panel_id as string, input.url as string) : "Not available.";
        case "type_text": return this.panelTyper ? this.panelTyper(input.panel_id as string, input.text as string, { label: input.label as string | undefined, placeholder: input.placeholder as string | undefined, selector: input.selector as string | undefined, clear: input.clear as boolean | undefined, submit: input.submit as boolean | undefined }) : "Not available.";
        case "open_panel": return this.panelOpener ? this.panelOpener(input.url as string, input.panel_id as string | undefined) : "Not available.";
        case "open_background": return this.backgroundOpener ? this.backgroundOpener(input.url as string, input.panel_id as string | undefined) : "Not available.";

        // Research
        case "search_notes": return this.execSearchNotes(input);
        case "write_note": return this.execWriteNote(input);
        case "search_files": return this.execSearchFiles(input);
        case "read_file": return this.execReadFile(input);
        case "list_files": return this.execListFiles(input);

        // Management
        case "manage_skill": return this.execManageSkill(input);
        case "manage_layout": return this.execManageLayout(input);
        case "manage_app": return this.execManageApp(input);

        // Output
        case "inject_text": {
          if (!this.injector) return "No source input available.";
          const ok = await this.injector(input.text as string);
          return ok ? "Text injected." : "Could not inject.";
        }
        case "run_command": {
          const cmd = (input.command as string || "").trim();
          const first = cmd.split(/\s+/)[0].toLowerCase().replace(/^\./, "");
          if (first !== "dip" && first !== "drip") return `Only dip/drip allowed. Got: ${first}`;
          return this.commandRunner ? this.commandRunner(cmd) : "Not available.";
        }

        default: return `Unknown tool: ${name}`;
      }
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  }

  // ── Research tool implementations ─────────────────────

  private async execSearchNotes(input: Record<string, unknown>): Promise<string> {
    if (!this.noteStore) return "Note store not available.";
    const hits = await this.noteStore.search(input.query as string, (input.limit as number) || 10);
    if (hits.length === 0) return "No matching notes.";
    return hits.map((h) => `[${h.title} | ${h.file}]\n${h.content}`).join("\n\n---\n\n");
  }

  private async execWriteNote(input: Record<string, unknown>): Promise<string> {
    if (!this.noteStore) return "Note store not available.";
    const fp = await this.noteStore.write(input.title as string, input.content as string, "skill");
    return `Note saved: ${fp}`;
  }

  private execSearchFiles(input: Record<string, unknown>): string {
    const pattern = input.pattern as string;
    let dir = (input.directory as string) || "~";
    const filePattern = (input.file_pattern as string) || "";
    dir = dir.replace(/^~/, os.homedir());
    if (!fs.existsSync(dir)) return `Directory not found: ${dir}`;

    const results: string[] = [];
    const maxResults = 15;
    const isHome = dir === os.homedir();
    const maxDepth = isHome ? 2 : 4;
    const deadline = Date.now() + 5000;
    const skipDirs = new Set(["node_modules", ".git", ".next", "dist", "build", "__pycache__", ".venv", "venv", "Library", ".Trash", "Pictures", "Movies", "Music"]);
    const textExts = new Set([".txt", ".md", ".ts", ".tsx", ".js", ".jsx", ".py", ".json", ".yaml", ".yml", ".toml", ".cfg", ".ini", ".sh", ".zsh", ".html", ".css", ".scss", ".sql", ".rs", ".go", ".java", ".rb", ".php", ".swift", ".kt", ".c", ".cpp", ".h"]);

    const search = (d: string, depth: number) => {
      if (depth > maxDepth || results.length >= maxResults || Date.now() > deadline) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (results.length >= maxResults || Date.now() > deadline) break;
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) {
          if (!entry.name.startsWith(".") && !skipDirs.has(entry.name)) search(full, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!textExts.has(ext)) continue;
        if (filePattern && !entry.name.match(new RegExp(filePattern.replace(/\*/g, ".*")))) continue;
        try {
          const content = fs.readFileSync(full, "utf-8").slice(0, 50000);
          const lines = content.split("\n");
          const regex = new RegExp(pattern, "gi");
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              results.push(`[${full}:${i + 1}]\n${lines.slice(Math.max(0, i - 1), i + 3).join("\n")}`);
              if (results.length >= maxResults) break;
            }
            regex.lastIndex = 0;
          }
        } catch {}
      }
    };
    search(dir, 0);
    return results.length ? results.join("\n\n") : `No files matching "${pattern}" in ${dir}`;
  }

  private execReadFile(input: Record<string, unknown>): string {
    let filePath = (input.path as string).replace(/^~/, os.homedir());
    const maxLines = (input.max_lines as number) || 200;
    if (!fs.existsSync(filePath)) return `File not found: ${filePath}`;
    try {
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) return `${filePath} is a directory.`;
      if (stat.size > 1_000_000) return `File too large (${Math.round(stat.size / 1024)}KB).`;
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      if (lines.length > maxLines) return lines.slice(0, maxLines).join("\n") + `\n[truncated at ${maxLines}/${lines.length} lines]`;
      return content;
    } catch (err) { return `Error: ${err instanceof Error ? err.message : err}`; }
  }

  private execListFiles(input: Record<string, unknown>): string {
    let dir = (input.path as string) || "~";
    const pattern = input.pattern as string;
    const recursive = input.recursive as boolean;
    dir = dir.replace(/^~/, os.homedir());
    if (!fs.existsSync(dir)) return `Directory not found: ${dir}`;

    const results: string[] = [];
    const maxDepth = recursive ? 3 : 0;
    const deadline = Date.now() + 3000;
    const skipDirs = new Set(["node_modules", ".git", ".next", "dist", "build", "__pycache__", "Library", ".Trash"]);

    const list = (d: string, depth: number) => {
      if (depth > maxDepth || results.length >= 50 || Date.now() > deadline) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (results.length >= 50) break;
        if (entry.name.startsWith(".")) continue;
        const full = path.join(d, entry.name);
        const relative = path.relative(dir, full);
        const isDir = entry.isDirectory();
        if (pattern && !entry.name.match(new RegExp(pattern.replace(/\*/g, ".*")))) {
          if (isDir && recursive && !skipDirs.has(entry.name)) list(full, depth + 1);
          continue;
        }
        results.push(`${isDir ? "[dir] " : ""}${relative}`);
        if (isDir && recursive && !skipDirs.has(entry.name)) list(full, depth + 1);
      }
    };
    list(dir, 0);
    return results.length ? results.join("\n") : `No files in ${dir}`;
  }

  // ── Management tool implementations ───────────────────

  private execManageSkill(input: Record<string, unknown>): string {
    if (!this.skillCallbacks) return "Skill engine not available.";
    const action = input.action as string;
    switch (action) {
      case "list": { const n = this.skillCallbacks.list(); return n.length ? n.join("\n") : "No skills."; }
      case "read": { const p = this.skillCallbacks.read(input.name as string); return p ?? `Skill "${input.name}" not found.`; }
      case "create": { this.skillCallbacks.create(input.name as string, input.prompt as string); return `Skill "${input.name}" created.`; }
      case "delete": { return this.skillCallbacks.remove(input.name as string) ? `Deleted.` : `Not found.`; }
      default: return `Unknown action: ${action}`;
    }
  }

  private execManageLayout(input: Record<string, unknown>): string {
    if (!this.layoutCallbacks) return "Layout manager not available.";
    const action = input.action as string;
    switch (action) {
      case "list": { const l = this.layoutCallbacks.list(); return l.length ? l.map((x) => `${x.name} (${x.cols}x${x.rows})`).join("\n") : "No layouts."; }
      case "save": { return this.layoutCallbacks.save(input.name as string, input.panels as string) ? `Saved.` : `Failed.`; }
      case "delete": { return this.layoutCallbacks.delete(input.name as string) ? `Deleted.` : `Not found.`; }
      default: return `Unknown action: ${action}`;
    }
  }

  private execManageApp(input: Record<string, unknown>): string {
    if (!this.appConnector) return "App connector not available.";
    const action = input.action as string;
    switch (action) {
      case "list": { const a = this.appConnector.list(); return a.length ? a.map((x) => `${x.id} — ${x.name} (${x.url})`).join("\n") : "No apps."; }
      case "add": { this.appConnector.add(input.id as string, (input.name as string) || (input.id as string), input.url as string); return `Added.`; }
      case "remove": { return this.appConnector.remove(input.id as string) ? `Removed.` : `Not found.`; }
      default: return `Unknown action: ${action}`;
    }
  }
}
