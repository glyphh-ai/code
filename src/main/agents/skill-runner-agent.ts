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

import os from "os";
import { execFile } from "child_process";
import { BaseSubAgent } from "./base-agent";
import type { ToolDef } from "./types";
import type { NoteStore } from "../note-store";
import type { AppConnector } from "../app-connector";
import {
  readFileContents,
  searchFileContents,
  listFilesAt,
  writeFileContents,
  editFileContents,
  moveFile,
  copyFile,
  deleteFile,
  createDirectory,
  resolvePath,
} from "./file-utils";

export class SkillRunnerAgent extends BaseSubAgent {
  protected agentName = "skill-runner";
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

  // New tool callbacks
  private panelScreenshotter: ((panelId: string) => Promise<string | null>) | null = null;
  private panelRefresher: ((panelId?: string) => Promise<string>) | null = null;
  private tabManager: { list: () => Array<{ id: string; title: string; url?: string }>; switch: (id: string) => void; close: (id: string) => void; create: () => string } | null = null;
  private clipboardRead: (() => string) | null = null;
  private clipboardWrite: ((text: string) => void) | null = null;
  private reminderCallback: ((message: string, delayMs: number) => void) | null = null;

  // Allow more iterations since skills can be complex workflows
  protected maxIterations = 15;

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
  setPanelScreenshotter(fn: typeof this.panelScreenshotter): void { this.panelScreenshotter = fn; }
  setPanelRefresher(fn: typeof this.panelRefresher): void { this.panelRefresher = fn; }
  setTabManager(tm: typeof this.tabManager): void { this.tabManager = tm; }
  setClipboard(read: () => string, write: (text: string) => void): void { this.clipboardRead = read; this.clipboardWrite = write; }
  setReminderCallback(fn: typeof this.reminderCallback): void { this.reminderCallback = fn; }

  // ── System prompt (dynamic from skill) ────────────────

  get systemPrompt(): string {
    // Sanitize skill prompt — strip any content that looks like injection
    let safeSkillPrompt = this.skillPrompt || "No skill prompt provided — act as a general assistant.";
    try {
      const { scanForInjection } = require("../firewall");
      const scan = scanForInjection(safeSkillPrompt);
      if (scan.blocked) {
        safeSkillPrompt = `[skill prompt blocked by firewall: ${scan.reason}] — act as a general assistant.`;
      }
    } catch { /* firewall not available — use raw prompt */ }

    return `You are a skill executor with full access to the workspace. Execute the skill described below.

SKILL INSTRUCTIONS:
${safeSkillPrompt}

AVAILABLE CAPABILITIES:
- Navigate apps: list_panels, scan_panel, grab_panel, click_element, navigate_panel, type_text, open_panel, open_background, screenshot_panel, refresh_panel, manage_tabs
- Search/save: search_notes, write_note, search_files, read_file, list_files
- File ops: write_file, edit_file, move_file, copy_file, delete_file, create_directory
- Shell: run_shell (sandboxed, with timeout)
- Manage: manage_skill, manage_layout, manage_app
- Clipboard: clipboard_read, clipboard_write
- Output: inject_text (paste into user's input field), run_command (dip/drip), set_reminder

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
      // New navigation tools
      { name: "screenshot_panel", description: "Capture a panel as a base64 PNG for visual analysis.", input_schema: { type: "object", properties: { panel_id: { type: "string" } }, required: ["panel_id"] } },
      { name: "refresh_panel", description: "Reload a panel's page.", input_schema: { type: "object", properties: { panel_id: { type: "string" } } } },
      { name: "manage_tabs", description: "Manage workspace tabs: list, switch, close, new.", input_schema: { type: "object", properties: { action: { type: "string", enum: ["list", "switch", "close", "new"] }, tab_id: { type: "string" } }, required: ["action"] } },
      // File write tools
      { name: "write_file", description: "Create or overwrite a file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
      { name: "edit_file", description: "Find and replace text in a file.", input_schema: { type: "object", properties: { path: { type: "string" }, search: { type: "string" }, replace: { type: "string" }, all: { type: "boolean" } }, required: ["path", "search", "replace"] } },
      { name: "move_file", description: "Move or rename a file.", input_schema: { type: "object", properties: { source: { type: "string" }, destination: { type: "string" } }, required: ["source", "destination"] } },
      { name: "copy_file", description: "Copy a file.", input_schema: { type: "object", properties: { source: { type: "string" }, destination: { type: "string" } }, required: ["source", "destination"] } },
      { name: "delete_file", description: "Delete a file or empty directory.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      { name: "create_directory", description: "Create a directory.", input_schema: { type: "object", properties: { path: { type: "string" }, recursive: { type: "boolean" } }, required: ["path"] } },
      // Shell
      { name: "run_shell", description: "Execute a shell command.", input_schema: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" }, timeout: { type: "number" } }, required: ["command"] } },
      // Clipboard
      { name: "clipboard_read", description: "Read text from the system clipboard.", input_schema: { type: "object", properties: {} } },
      { name: "clipboard_write", description: "Write text to the system clipboard.", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
      // Output
      { name: "inject_text", description: "Paste text into the user's input field.", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
      { name: "run_command", description: "Run a .dip or .drip command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
      { name: "set_reminder", description: "Set a timed reminder.", input_schema: { type: "object", properties: { message: { type: "string" }, delay_seconds: { type: "number" } }, required: ["message", "delay_seconds"] } },
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
        case "search_files": return searchFileContents(input.pattern as string, { directory: input.directory as string, filePattern: input.file_pattern as string });
        case "read_file": return readFileContents(input.path as string, { maxLines: input.max_lines as number, offset: input.offset as number });
        case "list_files": return listFilesAt(input.path as string || "~", { pattern: input.pattern as string, recursive: input.recursive as boolean });

        // New navigation tools
        case "screenshot_panel": return this.panelScreenshotter ? (await this.panelScreenshotter(input.panel_id as string) || "No screenshot.") : "Not available.";
        case "refresh_panel": return this.panelRefresher ? this.panelRefresher(input.panel_id as string | undefined) : "Not available.";
        case "manage_tabs": return this.execManageTabs(input);

        // File write tools
        case "write_file": return writeFileContents(input.path as string, input.content as string);
        case "edit_file": return editFileContents(input.path as string, input.search as string, input.replace as string, input.all as boolean);
        case "move_file": return moveFile(input.source as string, input.destination as string);
        case "copy_file": return copyFile(input.source as string, input.destination as string);
        case "delete_file": return deleteFile(input.path as string);
        case "create_directory": return createDirectory(input.path as string, input.recursive as boolean ?? true);

        // Shell
        case "run_shell": return this.execRunShell(input);

        // Clipboard
        case "clipboard_read": return this.clipboardRead ? (this.clipboardRead() || "(clipboard is empty)") : "Not available.";
        case "clipboard_write": {
          if (!this.clipboardWrite) return "Not available.";
          this.clipboardWrite(input.text as string);
          return "Text copied to clipboard.";
        }

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
        case "set_reminder": {
          const msg = input.message as string;
          const sec = input.delay_seconds as number;
          if (!msg || !sec || sec < 1 || sec > 86400) return "Invalid reminder params.";
          if (!this.reminderCallback) return "Not available.";
          this.reminderCallback(msg, sec * 1000);
          return `Reminder set: "${msg}" in ${sec}s.`;
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

  // ── New tool implementations ─────────────────────────

  private execManageTabs(input: Record<string, unknown>): string {
    if (!this.tabManager) return "Tab management not available.";
    const action = input.action as string;
    switch (action) {
      case "list": {
        const tabs = this.tabManager.list();
        return tabs.length ? tabs.map((t) => `${t.id} — ${t.title}${t.url ? ` (${t.url})` : ""}`).join("\n") : "No tabs open.";
      }
      case "switch": { this.tabManager.switch(input.tab_id as string); return `Switched to tab: ${input.tab_id}`; }
      case "close": { this.tabManager.close(input.tab_id as string); return `Closed tab: ${input.tab_id}`; }
      case "new": { const id = this.tabManager.create(); return `Created new tab: ${id}`; }
      default: return `Unknown tab action: ${action}`;
    }
  }

  private async execRunShell(input: Record<string, unknown>): Promise<string> {
    const command = (input.command as string || "").trim();
    if (!command) return "No command provided.";
    const cwd = resolvePath(input.cwd as string || "~");
    const timeout = Math.min((input.timeout as number) || 30, 120) * 1000;
    const blocked = [/\brm\s+-rf\s+\/\b/, /\bsudo\b/, /\bmkfs\b/, /\bdd\s+if=/, /\bshutdown\b/, /\breboot\b/];
    for (const p of blocked) { if (p.test(command)) return `Command blocked: ${command}`; }
    const interactive = new Set(["vim", "vi", "nano", "less", "more", "top", "htop", "ssh", "python", "node"]);
    const prog = command.split(/\s+/)[0].replace(/^.*\//, "");
    if (interactive.has(prog)) return `Interactive command not supported: ${prog}`;

    // Parse command into program + args (no shell — prevents injection)
    const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    if (parts.length === 0) return "No command provided.";
    const program = parts[0]!;
    const args = parts.slice(1).map((a) => a.replace(/^["']|["']$/g, ""));

    return new Promise((resolve) => {
      execFile(program, args, { cwd, timeout, maxBuffer: 1024 * 1024, env: { ...process.env, HOME: os.homedir() } }, (err: Error | null, stdout: string, stderr: string) => {
        let result = "";
        if (stdout) result += stdout.slice(0, 10000);
        if (stderr) result += (result ? "\n\n[stderr]\n" : "") + stderr.slice(0, 5000);
        if (err && !stdout && !stderr) result = `Error: ${err.message}`;
        resolve(result || "(no output)");
      });
    });
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
