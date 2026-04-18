/**
 * ResearcherAgent — notes & files specialist.
 *
 * Handles: search_notes, write_note, search_files, read_file, list_files.
 * Notes are the primary knowledge base; files are a fallback.
 */

import { BaseSubAgent } from "./base-agent";
import type { ToolDef } from "./types";
import type { NoteStore } from "../note-store";
import { readFileContents, searchFileContents, listFilesAt } from "./file-utils";

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
        description: "Read the contents of a specific file. Supports pagination with offset.",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute path or ~/relative path to the file" },
            max_lines: { type: "number", description: "Max lines to read (default: 500)" },
            offset: { type: "number", description: "Line offset to start reading from (default: 0)" },
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
            recursive: { type: "boolean", description: "Search subdirectories (default: false, max depth 5)" },
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
    return searchFileContents(input.pattern as string, {
      directory: input.directory as string,
      filePattern: input.file_pattern as string,
    });
  }

  private toolReadFile(input: Record<string, unknown>): string {
    return readFileContents(input.path as string, {
      maxLines: input.max_lines as number,
      offset: input.offset as number,
    });
  }

  private toolListFiles(input: Record<string, unknown>): string {
    return listFilesAt(input.path as string || "~", {
      pattern: input.pattern as string,
      recursive: input.recursive as boolean,
    });
  }

  private formatAge(timestamp: number): string {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }
}
