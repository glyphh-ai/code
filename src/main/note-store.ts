/**
 * NoteStore — flat .md files in ~/yo/notes/.
 *
 * Notes are written as markdown files. Search is keyword-based.
 */

import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";

const NOTES_DIR = path.join(os.homedir(), "yo", "notes");

export interface NoteResult {
  file: string;
  title: string;
  content: string;
  timestamp: number;
  rank: number;
}

export class NoteStore {
  constructor() {
    fs.mkdirSync(NOTES_DIR, { recursive: true });
  }

  get notesDir(): string { return NOTES_DIR; }

  /**
   * Write a note to disk and embed it.
   * Returns the file path of the written note.
   */
  async write(title: string, content: string, source?: string): Promise<string> {
    const slug = this.slugify(title);
    const ts = Date.now();
    const filename = `${slug}-${ts}.md`;
    const filepath = path.join(NOTES_DIR, filename);

    // Build frontmatter
    const lines = [
      "---",
      `title: ${title}`,
      `source: ${source || "agent"}`,
      `created: ${new Date(ts).toISOString()}`,
      "---",
      "",
      content,
    ];

    fs.writeFileSync(filepath, lines.join("\n"), "utf-8");
    return filepath;
  }

  async search(query: string, limit = 10): Promise<NoteResult[]> {
    const files = this.listNoteFiles();
    return this.keywordSearch(files, query, limit);
  }

  private keywordSearch(files: string[], query: string, limit: number): NoteResult[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const scored: NoteResult[] = [];

    for (const file of files) {
      try {
        const content = fs.readFileSync(file, "utf-8");
        const lower = content.toLowerCase();
        let hits = 0;
        for (const t of terms) {
          if (lower.includes(t)) hits++;
        }
        if (hits === 0) continue;

        const { title, body, timestamp } = this.parseNote(content, file);
        scored.push({
          file: path.basename(file),
          title,
          content: body,
          timestamp,
          rank: hits / terms.length,
        });
      } catch {
        continue;
      }
    }

    scored.sort((a, b) => b.rank - a.rank);
    return scored.slice(0, limit);
  }

  private parseNote(raw: string, filepath: string): { title: string; body: string; timestamp: number } {
    let title = path.basename(filepath, ".md");
    let body = raw;
    let timestamp = 0;

    // Extract frontmatter
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (fmMatch) {
      const fm = fmMatch[1];
      body = fmMatch[2].trim();
      const titleMatch = fm.match(/^title:\s*(.+)$/m);
      if (titleMatch) title = titleMatch[1].trim();
      const dateMatch = fm.match(/^created:\s*(.+)$/m);
      if (dateMatch) {
        const d = new Date(dateMatch[1].trim());
        if (!isNaN(d.getTime())) timestamp = d.getTime();
      }
    }

    if (!timestamp) {
      try { timestamp = fs.statSync(filepath).mtimeMs; } catch { timestamp = Date.now(); }
    }

    return { title, body, timestamp };
  }

  private listNoteFiles(): string[] {
    try {
      return fs.readdirSync(NOTES_DIR)
        .filter((f) => f.endsWith(".md"))
        .map((f) => path.join(NOTES_DIR, f));
    } catch {
      return [];
    }
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "note";
  }
}
