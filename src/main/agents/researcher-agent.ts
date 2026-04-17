/**
 * ResearcherAgent — notes & files specialist.
 *
 * Handles: search_notes, write_note, search_files, read_file, list_files.
 * Notes are the primary knowledge base; files are a fallback.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { BaseSubAgent } from "./base-agent";
import type { ToolDef } from "./types";
import type { NoteStore } from "../note-store";

export class ResearcherAgent extends BaseSubAgent {
  private noteStore: NoteStore | null = null;

  setNoteStore(store: NoteStore): void { this.noteStore = store; }

  get systemPrompt(): string {
    return `You are a research specialist. You search notes and files to find information.

PRIORITY ORDER:
1. search_notes FIRST — notes are the primary knowledge base
2. search_files / read_file / list_files only when the user explicitly asks about files on disk

SEARCH RULES:
- Always provide a specific directory for search_files — never search all of ~
- Max 3 searches per task, then report what you found
- If nothing matches, say what you searched and suggest alternatives

NOTES RULES:
- Only write_note when explicitly asked to save/remember something
- Never auto-save your own summaries or process logs

RESPONSE:
- Return actual content, not summaries of actions taken
- Keep response under 3000 chars with source attribution
- Plain text only, no markdown.`;
  }

  get tools(): ToolDef[] {
    return [
      {
        name: "search_notes",
        description: "Search saved notes in ~/yo/notes/. Returns matching notes with title and content.",
        input_schema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Natural language search query" },
            limit: { type: "number", description: "Max results (default 10)" },
          },
          required: ["query"],
        },
      },
      {
        name: "write_note",
        description: "Save a note to ~/yo/notes/. Use when the user explicitly asks to save or remember something.",
        input_schema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short title" },
            content: { type: "string", description: "Full text content" },
          },
          required: ["title", "content"],
        },
      },
      {
        name: "search_files",
        description: "Search file contents by text/regex pattern. Returns matching file paths and line previews.",
        input_schema: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Text or regex pattern to search for" },
            directory: { type: "string", description: "Directory to search in (default: ~/). Use ~ for home." },
            file_pattern: { type: "string", description: "Glob to filter files, e.g. '*.md', '*.ts'" },
          },
          required: ["pattern"],
        },
      },
      {
        name: "read_file",
        description: "Read the contents of a specific file.",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute path or ~/relative path to the file" },
            max_lines: { type: "number", description: "Max lines to read (default: 200)" },
          },
          required: ["path"],
        },
      },
      {
        name: "list_files",
        description: "List files and directories at a path.",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Directory path (default: ~/). Use ~ for home." },
            pattern: { type: "string", description: "Filter by name pattern, e.g. '*.md'" },
            recursive: { type: "boolean", description: "Search subdirectories (default: false, max depth 3)" },
          },
          required: [],
        },
      },
    ];
  }

  async execTool(name: string, input: Record<string, unknown>): Promise<string> {
    switch (name) {
      case "search_notes": return this.toolSearchNotes(input);
      case "write_note": return this.toolWriteNote(input);
      case "search_files": return this.toolSearchFiles(input);
      case "read_file": return this.toolReadFile(input);
      case "list_files": return this.toolListFiles(input);
      default: return `Unknown tool: ${name}`;
    }
  }

  // ── Tool implementations (lifted from yo-agent.ts) ──────

  private async toolSearchNotes(input: Record<string, unknown>): Promise<string> {
    if (!this.noteStore) return "Note store not available.";
    const query = input.query as string;
    const limit = (input.limit as number) || 10;

    const hits = await this.noteStore.search(query, limit);
    if (hits.length === 0) return "No matching notes found.";

    const sections = hits.map((h) =>
      `[${h.title} | ${h.file} | ${this.formatAge(h.timestamp)}]\n${h.content}`
    );
    return sections.join("\n\n---\n\n");
  }

  private async toolWriteNote(input: Record<string, unknown>): Promise<string> {
    if (!this.noteStore) return "Note store not available.";
    const title = input.title as string;
    const content = input.content as string;
    const filepath = await this.noteStore.write(title, content, "agent");
    return `Note saved: ${filepath}`;
  }

  private toolSearchFiles(input: Record<string, unknown>): string {
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

    const textExts = new Set([
      ".txt", ".md", ".ts", ".tsx", ".js", ".jsx", ".py", ".json",
      ".yaml", ".yml", ".toml", ".cfg", ".ini", ".sh", ".zsh",
      ".html", ".css", ".scss", ".sql", ".rs", ".go", ".java",
      ".rb", ".php", ".swift", ".kt", ".c", ".cpp", ".h",
    ]);

    const search = (d: string, depth: number) => {
      if (depth > maxDepth || results.length >= maxResults || Date.now() > deadline) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }

      for (const entry of entries) {
        if (results.length >= maxResults || Date.now() > deadline) break;
        const full = path.join(d, entry.name);

        if (entry.isDirectory()) {
          if (!entry.name.startsWith(".") && !skipDirs.has(entry.name)) {
            search(full, depth + 1);
          }
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
              const preview = lines.slice(Math.max(0, i - 1), i + 3).join("\n");
              results.push(`[${full}:${i + 1}]\n${preview}`);
              if (results.length >= maxResults) break;
            }
            regex.lastIndex = 0;
          }
        } catch { /* skip unreadable */ }
      }
    };

    search(dir, 0);
    if (results.length === 0) return `No files matching "${pattern}" found in ${dir}`;
    return results.join("\n\n");
  }

  private toolReadFile(input: Record<string, unknown>): string {
    let filePath = input.path as string;
    const maxLines = (input.max_lines as number) || 200;

    filePath = filePath.replace(/^~/, os.homedir());
    if (!fs.existsSync(filePath)) return `File not found: ${filePath}`;

    try {
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) return `${filePath} is a directory, not a file. Use list_files instead.`;
      if (stat.size > 1_000_000) return `File too large (${Math.round(stat.size / 1024)}KB). Try search_files instead.`;

      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      if (lines.length > maxLines) {
        return lines.slice(0, maxLines).join("\n") + `\n\n[... truncated at ${maxLines} lines, ${lines.length} total]`;
      }
      return content;
    } catch (err) {
      return `Error reading file: ${err instanceof Error ? err.message : err}`;
    }
  }

  private toolListFiles(input: Record<string, unknown>): string {
    let dir = (input.path as string) || "~";
    const pattern = input.pattern as string;
    const recursive = input.recursive as boolean;

    dir = dir.replace(/^~/, os.homedir());
    if (!fs.existsSync(dir)) return `Directory not found: ${dir}`;

    const results: string[] = [];
    const maxResults = 50;
    const maxDepth = recursive ? 3 : 0;
    const deadline = Date.now() + 3000;
    const skipDirs = new Set(["node_modules", ".git", ".next", "dist", "build", "__pycache__", "Library", ".Trash"]);

    const list = (d: string, depth: number) => {
      if (depth > maxDepth || results.length >= maxResults || Date.now() > deadline) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }

      for (const entry of entries) {
        if (results.length >= maxResults) break;
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
    if (results.length === 0) return `No files found in ${dir}`;
    return results.join("\n");
  }

  private formatAge(timestamp: number): string {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }
}
