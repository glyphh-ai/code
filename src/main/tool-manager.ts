/**
 * ToolManager — manages AI automation tools (wassup recipes).
 *
 * Each tool is a named prompt the LLM executes using cross-app
 * capabilities (grab, push, submit, dip, library I/O).
 *
 * Stored as JSON in ~/yo/tools/{id}.json
 */

import fs from "fs";
import path from "path";
import os from "os";

// ── Types ───────────────────────────────────────────────

export interface ToolConfig {
  id: string;
  name: string;
  description: string;
  prompt: string;
}

// ── ToolManager ─────────────────────────────────────────

export class ToolManager {
  private tools: Map<string, ToolConfig> = new Map();
  private toolsDir: string;

  constructor() {
    this.toolsDir = path.join(os.homedir(), "yo", "tools");
    fs.mkdirSync(this.toolsDir, { recursive: true });
    this.loadAll();
  }

  /** Add a new tool */
  add(id: string, name: string, description: string, prompt: string): ToolConfig {
    const tool: ToolConfig = { id, name, description, prompt };
    this.tools.set(id, tool);
    this.save(tool);
    return tool;
  }

  /** Get a tool by ID */
  get(id: string): ToolConfig | null {
    return this.tools.get(id) ?? null;
  }

  /** List all tools */
  list(): ToolConfig[] {
    return Array.from(this.tools.values());
  }

  /** Update a tool's fields */
  update(id: string, fields: Partial<Omit<ToolConfig, "id">>): boolean {
    const tool = this.tools.get(id);
    if (!tool) return false;
    if (fields.name !== undefined) tool.name = fields.name;
    if (fields.description !== undefined) tool.description = fields.description;
    if (fields.prompt !== undefined) tool.prompt = fields.prompt;
    this.save(tool);
    return true;
  }

  /** Delete a tool */
  remove(id: string): boolean {
    if (!this.tools.has(id)) return false;
    this.tools.delete(id);
    const filePath = path.join(this.toolsDir, `${id}.json`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return true;
  }

  /** Fuzzy search: exact id → name startsWith → name includes */
  search(query: string): ToolConfig | null {
    const q = query.toLowerCase();
    // Exact ID match
    const exact = this.tools.get(q);
    if (exact) return exact;
    // Case-insensitive name startsWith
    for (const tool of this.tools.values()) {
      if (tool.name.toLowerCase().startsWith(q)) return tool;
    }
    // Case-insensitive name includes
    for (const tool of this.tools.values()) {
      if (tool.name.toLowerCase().includes(q)) return tool;
    }
    return null;
  }

  // ── Persistence ─────────────────────────────────────

  private save(tool: ToolConfig): void {
    fs.writeFileSync(
      path.join(this.toolsDir, `${tool.id}.json`),
      JSON.stringify(tool, null, 2),
      "utf-8",
    );
  }

  private loadAll(): void {
    if (!fs.existsSync(this.toolsDir)) return;
    for (const file of fs.readdirSync(this.toolsDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = fs.readFileSync(path.join(this.toolsDir, file), "utf-8");
        const tool: ToolConfig = JSON.parse(raw);
        this.tools.set(tool.id, tool);
      } catch {
        // skip corrupt files
      }
    }
  }
}
