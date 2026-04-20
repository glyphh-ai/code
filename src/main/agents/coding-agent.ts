/**
 * CodingAgent — file operations + shell execution specialist.
 *
 * Handles: read, write, edit, move, copy, delete files, create directories,
 * run shell commands, and interact with panels (for live app building).
 *
 * This agent can build simple HTML/JS apps on the fly and open them
 * in workspace panels for the user to see immediately.
 */

import os from "os";
import { execFile } from "child_process";
import { BaseSubAgent } from "./base-agent";
import type { ToolDef } from "./types";
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

// Dangerous commands that should never run
const BLOCKED_COMMANDS = [
  /\brm\s+-rf\s+\/\b/,       // rm -rf /
  /\bsudo\b/,                 // sudo anything
  /\bmkfs\b/,                 // format disk
  /\bdd\s+if=/,               // raw disk write
  /\bchmod\s+777\s+\//,       // world-writable root
  /\b>\s*\/etc\//,            // redirect to /etc
  /\b>\s*\/usr\//,            // redirect to /usr
  /\bkillall\b/,              // kill processes
  /\bshutdown\b/,             // shutdown system
  /\breboot\b/,               // reboot system
];

// Interactive commands that need a TTY
const INTERACTIVE = new Set([
  "vim", "vi", "nano", "emacs", "less", "more", "top", "htop",
  "man", "ssh", "ftp", "telnet", "python", "node", "irb",
]);

export class CodingAgent extends BaseSubAgent {
  protected agentName = "coder";
  // Panel interaction callbacks (for opening built apps)
  private panelOpener: ((url: string, panelId?: string) => Promise<string>) | null = null;
  private panelRefresher: ((panelId?: string) => Promise<string>) | null = null;
  private panelGrabber: ((panelId: string) => Promise<string | null>) | null = null;
  private panelScanner: ((panelId: string) => Promise<string | null>) | null = null;

  protected maxIterations = 15;

  // ── Setters ───────────────────────────────────────────

  setPanelOpener(fn: typeof this.panelOpener): void { this.panelOpener = fn; }
  setPanelRefresher(fn: typeof this.panelRefresher): void { this.panelRefresher = fn; }
  setPanelGrabber(fn: typeof this.panelGrabber): void { this.panelGrabber = fn; }
  setPanelScanner(fn: typeof this.panelScanner): void { this.panelScanner = fn; }

  // ── System prompt ─────────────────────────────────────

  get systemPrompt(): string {
    const appsDir = resolvePath("~/yo/apps");
    return `You are a coding specialist. You read, write, and edit files, run shell commands, and build tools for the user.

CAPABILITIES:
- File operations: read_file, write_file, edit_file, move_file, copy_file, delete_file, create_directory
- Search: search_files, list_files
- Shell: run_shell (sandboxed, with timeout)
- Panel interaction: open_panel (show files in workspace), refresh_panel, grab_panel, scan_panel

BUILDING APPS:
- ALWAYS use write_file to create the file — never say you created it without actually calling write_file
- Save apps to ${appsDir}/<name>/index.html
- ALWAYS open_panel with file://${appsDir}/<name>/index.html after writing — the user must see the result
- After editing, use refresh_panel to reload — the user sees changes instantly
- Keep apps self-contained: inline CSS and JS, no build step, no dependencies
- Use modern HTML5, CSS3, ES2022+ features — the runtime is Chromium

WORKFLOW:
1. Understand the project — list_files and read_file to explore before editing
2. Make targeted edits — use edit_file for surgical changes, write_file for new files
3. Verify — run tests or inspect output after changes
4. For multi-file projects, work file by file, verifying after each change

SHELL RULES:
- Commands run with a 30s timeout (max 120s)
- No interactive commands (vim, ssh, python REPL, etc.)
- Prefer short, specific commands over long pipelines
- Use run_shell for: git, npm/yarn, tests, builds, curl, standard CLI tools

RESPONSE:
- Return actual content or results, not summaries of what you did
- When building an app, describe what you built in 1-2 sentences
- Plain text only, no markdown.`;
  }

  // ── Tools ─────────────────────────────────────────────

  get tools(): ToolDef[] {
    return [
      // File read
      { name: "read_file", description: "Read file contents. Supports pagination with offset.", input_schema: { type: "object", properties: { path: { type: "string", description: "Absolute path or ~/relative" }, max_lines: { type: "number", description: "Max lines (default: 500)" }, offset: { type: "number", description: "Line offset (default: 0)" } }, required: ["path"] } },
      { name: "search_files", description: "Search file contents by text/regex pattern.", input_schema: { type: "object", properties: { pattern: { type: "string", description: "Text or regex pattern" }, directory: { type: "string", description: "Directory to search (default: ~)" }, file_pattern: { type: "string", description: "Glob filter, e.g. '*.ts'" } }, required: ["pattern"] } },
      { name: "list_files", description: "List files and directories at a path.", input_schema: { type: "object", properties: { path: { type: "string", description: "Directory path (default: ~)" }, pattern: { type: "string", description: "Name filter, e.g. '*.md'" }, recursive: { type: "boolean", description: "Include subdirectories" } } } },

      // File write
      { name: "write_file", description: "Create or overwrite a file. Parent directories are created automatically.", input_schema: { type: "object", properties: { path: { type: "string", description: "File path" }, content: { type: "string", description: "File content" } }, required: ["path", "content"] } },
      { name: "edit_file", description: "Find and replace text in a file. Safer than full rewrites for targeted changes.", input_schema: { type: "object", properties: { path: { type: "string", description: "File path" }, search: { type: "string", description: "Exact text to find" }, replace: { type: "string", description: "Replacement text" }, all: { type: "boolean", description: "Replace all occurrences (default: first only)" } }, required: ["path", "search", "replace"] } },
      { name: "move_file", description: "Move or rename a file.", input_schema: { type: "object", properties: { source: { type: "string" }, destination: { type: "string" } }, required: ["source", "destination"] } },
      { name: "copy_file", description: "Copy a file.", input_schema: { type: "object", properties: { source: { type: "string" }, destination: { type: "string" } }, required: ["source", "destination"] } },
      { name: "delete_file", description: "Delete a file or empty directory.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      { name: "create_directory", description: "Create a directory (recursive by default).", input_schema: { type: "object", properties: { path: { type: "string" }, recursive: { type: "boolean" } }, required: ["path"] } },

      // Shell
      { name: "run_shell", description: "Execute a shell command. Sandboxed with timeout. Use for git, npm, tests, builds, CLI tools.", input_schema: { type: "object", properties: { command: { type: "string", description: "Shell command to run" }, cwd: { type: "string", description: "Working directory (default: ~)" }, timeout: { type: "number", description: "Timeout in seconds (default: 30, max: 120)" } }, required: ["command"] } },

      // Panel interaction (for live app building)
      { name: "open_panel", description: "Open a URL or file:// path in a visible workspace panel.", input_schema: { type: "object", properties: { url: { type: "string", description: "URL or file:// path" }, panel_id: { type: "string", description: "Optional panel ID" } }, required: ["url"] } },
      { name: "refresh_panel", description: "Reload a panel to show updated content.", input_schema: { type: "object", properties: { panel_id: { type: "string", description: "Panel ID to refresh" } } } },
      { name: "grab_panel", description: "Get full text content from a panel.", input_schema: { type: "object", properties: { panel_id: { type: "string" } }, required: ["panel_id"] } },
      { name: "scan_panel", description: "Fast DOM scan of a panel for element discovery.", input_schema: { type: "object", properties: { panel_id: { type: "string" } }, required: ["panel_id"] } },
    ];
  }

  // ── Tool dispatch ─────────────────────────────────────

  async execTool(name: string, input: Record<string, unknown>): Promise<string> {
    try {
      switch (name) {
        // File read
        case "read_file": return readFileContents(input.path as string, { maxLines: input.max_lines as number, offset: input.offset as number });
        case "search_files": return searchFileContents(input.pattern as string, { directory: input.directory as string, filePattern: input.file_pattern as string });
        case "list_files": return listFilesAt(input.path as string || "~", { pattern: input.pattern as string, recursive: input.recursive as boolean });

        // File write
        case "write_file": return writeFileContents(input.path as string, input.content as string);
        case "edit_file": return editFileContents(input.path as string, input.search as string, input.replace as string, input.all as boolean);
        case "move_file": return moveFile(input.source as string, input.destination as string);
        case "copy_file": return copyFile(input.source as string, input.destination as string);
        case "delete_file": return deleteFile(input.path as string);
        case "create_directory": return createDirectory(input.path as string, input.recursive as boolean ?? true);

        // Shell
        case "run_shell": return this.toolRunShell(input);

        // Panel interaction
        case "open_panel": return this.panelOpener ? this.panelOpener(input.url as string, input.panel_id as string | undefined) : "Panel opening not available.";
        case "refresh_panel": return this.panelRefresher ? this.panelRefresher(input.panel_id as string | undefined) : "Refresh not available.";
        case "grab_panel": return this.panelGrabber ? (await this.panelGrabber(input.panel_id as string) || "No content.") : "Not available.";
        case "scan_panel": return this.panelScanner ? (await this.panelScanner(input.panel_id as string) || "No scan results.") : "Not available.";

        default: return `Unknown tool: ${name}`;
      }
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  }

  // ── Shell execution ───────────────────────────────────

  private async toolRunShell(input: Record<string, unknown>): Promise<string> {
    const command = (input.command as string || "").trim();
    if (!command) return "No command provided.";

    let cwd = resolvePath(input.cwd as string || "~");
    const timeout = Math.min((input.timeout as number) || 30, 120) * 1000;

    // Block dangerous commands
    for (const pattern of BLOCKED_COMMANDS) {
      if (pattern.test(command)) {
        return `Command blocked for safety: ${command}`;
      }
    }

    // Block interactive commands
    const program = command.split(/\s+/)[0].replace(/^.*\//, "");
    if (INTERACTIVE.has(program)) {
      return `Interactive command not supported: ${program}. Use non-interactive alternatives.`;
    }

    // Parse command into program + args (no shell — prevents injection)
    const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    if (parts.length === 0) return "No command provided.";
    const program = parts[0];
    const args = parts.slice(1).map((a) => a.replace(/^["']|["']$/g, ""));

    return new Promise((resolve) => {
      execFile(program, args, {
        cwd,
        timeout,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, HOME: os.homedir() },
      }, (err, stdout, stderr) => {
        let result = "";
        if (stdout) result += stdout.slice(0, 10000);
        if (stderr) result += (result ? "\n\n[stderr]\n" : "") + stderr.slice(0, 5000);
        if (err && !stdout && !stderr) result = `Error: ${err.message}`;
        if (!result) result = "(no output)";
        resolve(result);
      });
    });
  }
}
