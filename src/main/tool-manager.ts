/**
 * ToolManager — CRUD for AI automation tools (named prompts).
 *
 * Storage: ~/yo/tools/{id}.json
 * Each tool is a recipe the LLM follows when invoked via "wassup".
 */

import fs from "fs";
import path from "path";
import os from "os";

export interface ToolConfig {
  id: string;           // kebab-case
  name: string;         // display name
  description: string;  // short description
  prompt: string;       // AI instruction (the recipe)
}

const TOOLS_DIR = path.join(os.homedir(), "yo", "tools");

export class ToolManager {
  private tools = new Map<string, ToolConfig>();

  constructor() {
    this.loadAll();
  }

  /** Add a new tool. */
  add(id: string, name: string, description: string, prompt: string): ToolConfig {
    const tool: ToolConfig = { id, name, description, prompt };
    this.tools.set(id, tool);
    this.save(tool);
    return tool;
  }

  /** Get a tool by ID. */
  get(id: string): ToolConfig | undefined {
    return this.tools.get(id);
  }

  /** List all tools. */
  list(): ToolConfig[] {
    return Array.from(this.tools.values());
  }

  /** Update an existing tool. */
  update(id: string, fields: Partial<Omit<ToolConfig, "id">>): boolean {
    const tool = this.tools.get(id);
    if (!tool) return false;
    if (fields.name !== undefined) tool.name = fields.name;
    if (fields.description !== undefined) tool.description = fields.description;
    if (fields.prompt !== undefined) tool.prompt = fields.prompt;
    this.save(tool);
    return true;
  }

  /** Remove a tool by ID. */
  remove(id: string): boolean {
    if (!this.tools.has(id)) return false;
    this.tools.delete(id);
    try {
      fs.unlinkSync(path.join(TOOLS_DIR, `${id}.json`));
    } catch { /* already gone */ }
    return true;
  }

  /** Search tools: exact id → name startsWith → name/description includes. */
  search(query: string): ToolConfig | undefined {
    const q = query.toLowerCase();
    // Exact ID match
    const exact = this.tools.get(q);
    if (exact) return exact;
    // Name starts with
    for (const tool of this.tools.values()) {
      if (tool.name.toLowerCase().startsWith(q)) return tool;
    }
    // Name or description includes
    for (const tool of this.tools.values()) {
      if (tool.name.toLowerCase().includes(q) || tool.description.toLowerCase().includes(q)) {
        return tool;
      }
    }
    return undefined;
  }

  // ── Persistence ─────────────────────────────────────────

  private save(tool: ToolConfig): void {
    if (!fs.existsSync(TOOLS_DIR)) {
      fs.mkdirSync(TOOLS_DIR, { recursive: true });
    }
    fs.writeFileSync(
      path.join(TOOLS_DIR, `${tool.id}.json`),
      JSON.stringify(tool, null, 2),
    );
  }

  private loadAll(): void {
    if (!fs.existsSync(TOOLS_DIR)) return;
    for (const file of fs.readdirSync(TOOLS_DIR)) {
      if (!file.endsWith(".json")) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(TOOLS_DIR, file), "utf-8"));
        if (data.id && data.name && data.prompt !== undefined) {
          this.tools.set(data.id, {
            id: data.id,
            name: data.name,
            description: data.description || "",
            prompt: data.prompt,
          });
        }
      } catch { /* skip corrupt files */ }
    }
  }
}
