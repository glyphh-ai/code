import fs from "fs";
import path from "path";
import os from "os";

const LOG_FILE = path.join(os.homedir(), "yo", ".prompt-log");
const MAX_ENTRIES = 500;

export interface PromptLogEntry {
  id: string;
  startTs: number;
  endTs: number;
  prompt: string;
  response: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
  provider: string;
  mode: string;
  toolsUsed: string[];
}

class PromptLog {
  private entries: PromptLogEntry[] = [];
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() { this.load(); }

  record(entry: PromptLogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(-MAX_ENTRIES);
    }
    this.scheduleSave();
  }

  list(offset = 0, limit = 50): PromptLogEntry[] {
    const reversed = [...this.entries].reverse();
    return reversed.slice(offset, offset + limit);
  }

  search(query: string, limit = 50): PromptLogEntry[] {
    const q = query.toLowerCase();
    const results: PromptLogEntry[] = [];
    for (let i = this.entries.length - 1; i >= 0 && results.length < limit; i--) {
      const e = this.entries[i];
      if (e.prompt.toLowerCase().includes(q) || e.response.toLowerCase().includes(q)) {
        results.push(e);
      }
    }
    return results;
  }

  get(id: string): PromptLogEntry | null {
    return this.entries.find(e => e.id === id) || null;
  }

  get count(): number { return this.entries.length; }

  flush(): void {
    if (!this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
      fs.writeFileSync(LOG_FILE, JSON.stringify(this.entries), "utf-8");
      this.dirty = false;
    } catch { /* best-effort */ }
  }

  private load(): void {
    try {
      if (fs.existsSync(LOG_FILE)) {
        this.entries = JSON.parse(fs.readFileSync(LOG_FILE, "utf-8"));
      }
    } catch { this.entries = []; }
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 3000);
  }
}

export const promptLog = new PromptLog();
