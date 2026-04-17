/**
 * MemoryStore — persistent agent memory in ~/yo/memory/.
 *
 * Memories are things the agent learns about the user over time:
 * preferences, workflows, app patterns, facts, context.
 * Different from notes (user content) — these are agent-internal.
 *
 * Storage: JSON array in memories.json, vector sidecars for search.
 * Search: vector similarity via embedder, keyword fallback.
 */

import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import type { Embedder } from "./embedder";

const MEMORY_DIR = path.join(os.homedir(), "yo", "memory");
const MEMORY_FILE = path.join(MEMORY_DIR, "memories.json");
const VEC_DIR = path.join(MEMORY_DIR, "vecs");
const EMBED_DIM = 384;

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
  private embedder: Embedder | null = null;
  private dirty = false;

  constructor() {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    fs.mkdirSync(VEC_DIR, { recursive: true });
    this.load();
  }

  setEmbedder(embedder: Embedder): void { this.embedder = embedder; }

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
      await this.embedMemory(existing);
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
    await this.embedMemory(memory);
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
    // Remove vector sidecar
    const vecPath = path.join(VEC_DIR, `${id}.vec`);
    try { fs.unlinkSync(vecPath); } catch {}
    return true;
  }

  /** Search memories by relevance. Returns top-k matches. */
  async search(query: string, limit = 5): Promise<Memory[]> {
    if (this.memories.length === 0) return [];

    // Vector search
    if (this.embedder?.isReady) {
      try {
        const queryVec = await this.embedder.embed(query);
        const scored: Array<{ memory: Memory; score: number }> = [];

        for (const memory of this.memories) {
          const vecPath = path.join(VEC_DIR, `${memory.id}.vec`);
          if (!fs.existsSync(vecPath)) continue;
          const buf = fs.readFileSync(vecPath);
          const memVec = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
          const score = cosine(queryVec, memVec);
          scored.push({ memory, score });
        }

        scored.sort((a, b) => b.score - a.score);
        const results = scored.slice(0, limit).filter((s) => s.score > 0.3);

        // Update access stats
        for (const { memory } of results) {
          memory.lastUsed = Date.now();
          memory.useCount++;
        }
        if (results.length > 0) this.persist();

        return results.map((s) => s.memory);
      } catch {
        // Fall through to keyword
      }
    }

    // Keyword fallback
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

  private async embedMemory(memory: Memory): Promise<void> {
    if (!this.embedder?.isReady) return;
    try {
      const vec = await this.embedder.embed(memory.content);
      const vecPath = path.join(VEC_DIR, `${memory.id}.vec`);
      fs.writeFileSync(vecPath, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
    } catch {
      // Non-fatal — memory still searchable via keywords
    }
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

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}
