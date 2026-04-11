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

  /** List all context files */
  list(): string[] {
    if (!fs.existsSync(this.root)) return [];
    return fs
      .readdirSync(this.root)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""));
  }

  /** Search files by content */
  search(term: string): string[] {
    const lower = term.toLowerCase();
    return this.list().filter((name) => {
      const content = this.read(name);
      return (
        name.toLowerCase().includes(lower) ||
        (content && content.toLowerCase().includes(lower))
      );
    });
  }

  /** Resolve name → file path */
  private resolve(name: string): string {
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "-");
    return path.join(this.root, `${safeName}.md`);
  }
}
