/**
 * MemoryStore — persistent agent memory in ~/yo/memory/.
 *
 * Memories are things the agent learns about the user over time:
 * preferences, workflows, app patterns, facts, context.
 * Different from notes (user content) — these are agent-internal.
 *
 * Storage: JSON array in memories.json. Search is keyword-based.
 */

import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";

const MEMORY_DIR = path.join(os.homedir(), "yo", "memory");
const MEMORY_FILE = path.join(MEMORY_DIR, "memories.json");

export interface Memory {
  id: string;
  content: string;
  category: "preference" | "fact" | "workflow" | "app_pattern" | "context";
  created: number;
  lastUsed: number;
  useCount: number;
}

export class MemoryStore {
  private memories: Memory[] = [];

  constructor() {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    this.load();
  }

  // ── CRUD ──────────────────────────────────────────────

  /** Save a new memory. Deduplicates against existing memories. */
  async save(content: string, category: Memory["category"]): Promise<string> {
    // Check for near-duplicate (simple substring check)
    const normalised = content.toLowerCase().trim();
    const existing = this.memories.find((m) =>
      m.content.toLowerCase().trim() === normalised ||
      normalised.includes(m.content.toLowerCase().trim()) ||
      m.content.toLowerCase().trim().includes(normalised)
    );
    if (existing) {
      // Update existing instead of creating duplicate
      existing.content = content;
      existing.category = category;
      existing.lastUsed = Date.now();
      this.persist();
      return existing.id;
    }

    const id = crypto.randomBytes(6).toString("hex");
    const memory: Memory = {
      id,
      content,
      category,
      created: Date.now(),
      lastUsed: Date.now(),
      useCount: 0,
    };
    this.memories.push(memory);
    this.persist();
    return id;
  }

  /** Get all memories. */
  list(): Memory[] {
    return [...this.memories];
  }

  /** Delete a memory by ID. */
  delete(id: string): boolean {
    const idx = this.memories.findIndex((m) => m.id === id);
    if (idx < 0) return false;
    this.memories.splice(idx, 1);
    this.persist();
    return true;
  }

  async search(query: string, limit = 5): Promise<Memory[]> {
    if (this.memories.length === 0) return [];
    return this.keywordSearch(query, limit);
  }

  /** Get total memory count. */
  get count(): number { return this.memories.length; }

  // ── Private ───────────────────────────────────────────

  private load(): void {
    if (fs.existsSync(MEMORY_FILE)) {
      try {
        this.memories = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf-8"));
      } catch {
        this.memories = [];
      }
    }
  }

  private persist(): void {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(this.memories, null, 2), "utf-8");
  }

  private keywordSearch(query: string, limit: number): Memory[] {
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    if (terms.length === 0) return this.memories.slice(0, limit);

    const scored = this.memories.map((memory) => {
      const text = memory.content.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (text.includes(term)) score++;
      }
      // Boost recently used memories
      const ageHours = (Date.now() - memory.lastUsed) / 3_600_000;
      const recencyBoost = Math.max(0, 1 - ageHours / 720); // decays over 30 days
      return { memory, score: score + recencyBoost * 0.5 };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.memory);
  }
}
