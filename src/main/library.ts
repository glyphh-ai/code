/**
 * Library — read/write to ~/yo/library/ (.md files).
 *
 * Dead simple. A folder of markdown files the user names and
 * organizes however they want. No database, no vector DB.
 */

import fs from "fs";
import path from "path";
import os from "os";

export class Library {
  private root: string;

  constructor(root?: string) {
    this.root = root || path.join(os.homedir(), "yo", "library");
    fs.mkdirSync(this.root, { recursive: true });
  }

  /** Write a context file */
  write(name: string, content: string): string {
    const filePath = this.resolve(name);
    fs.writeFileSync(filePath, content, "utf-8");
    return filePath;
  }

  /** Read a context file */
  read(name: string): string | null {
    const filePath = this.resolve(name);
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, "utf-8");
  }

  /** Remove a context file */
  remove(name: string): boolean {
    const filePath = this.resolve(name);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
  }

  /** List all context files (names only, sorted newest first) */
  list(): string[] {
    return this.listWithMeta().map((f) => f.name);
  }

  /** List all context files with modification timestamps and size, sorted newest first. */
  listWithMeta(): Array<{ name: string; modified: number; size: number }> {
    if (!fs.existsSync(this.root)) return [];
    return fs
      .readdirSync(this.root)
      .filter((f) => f.endsWith(".md"))
      .map((f) => {
        const stat = fs.statSync(path.join(this.root, f));
        return { name: f.replace(/\.md$/, ""), modified: stat.mtimeMs, size: stat.size };
      })
      .sort((a, b) => b.modified - a.modified);
  }

  /** Search files by name/content. Splits query into words, ranks by match count. */
  search(term: string): string[] {
    const words = term.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
    if (words.length === 0) return [];

    const scored = this.list()
      .map((name) => {
        const nameLower = name.toLowerCase();
        const content = (this.read(name) || "").toLowerCase();
        let score = 0;
        for (const w of words) {
          if (nameLower.includes(w)) score += 2; // name match weighted higher
          if (content.includes(w)) score += 1;
        }
        return { name, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);

    return scored.map((r) => r.name);
  }

  /** Resolve name → file path */
  private resolve(name: string): string {
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "-");
    return path.join(this.root, `${safeName}.md`);
  }
}
