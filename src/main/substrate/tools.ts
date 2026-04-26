/**
 * Unified tool registry — every tool the agent can invoke is a skill.
 *
 * Three kinds, one registry:
 *   - substrate tools (built-in, namespaced yo.*)   — privileged ctx
 *   - user skills    (~/yo/skills/*, namespaced skill.*)
 *   - MCP tools      (per-app, namespaced <app>.*)  — via SkillToolRouter
 *
 * Every invocation flows through the substrate breath cycle (sanitize,
 * budget, remember). The agent's tool spec is built dynamically at
 * LLM-call time so users can add tools by creating skills.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";

// Privileged accessors injected by main.ts. Substrate tools use these;
// user-skill ctx never sees them.
export interface SubstrateToolDeps {
  captureStore?: { search: (q: string, n: number) => Promise<Array<{ meta: { id: string; source: string; created: number }; content: string; score: number }>> };
  sessionCache?: { get: () => string | null };
  noteStore?: { search: (q: string, n: number) => Promise<Array<{ file: string; title: string; content: string; rank: number }>>; write: (title: string, content: string, source?: string) => Promise<string> };
  memoryStore?: { save: (content: string, category: string) => Promise<string> };
  skillEngine?: {
    runSkill: (name: string, input: unknown, opts?: { trigger?: string }) => Promise<unknown>;
    listSkillsDetailed: () => Array<{ name: string; description?: string; hasRunner: boolean; scheduled: boolean; scheduleExpr?: string }>;
    getSkill: (name: string) => { manifest: Record<string, unknown>; prompt: string; hasRunner: boolean; folderPath: string } | null;
    writeSkill: (name: string, manifest: Record<string, unknown>, prompt: string, runnerCode?: string | null) => boolean;
    deleteSkill: (name: string) => boolean;
    readSkillFile: (name: string, rel: string) => string | null;
    writeSkillFile: (name: string, rel: string, content: string) => boolean;
    listSkillFiles: (name: string) => string[];
    listVibes: () => Array<{ name: string; description?: string; folderPath: string }>;
  };
  council?: { start: (opts: { participants: string[]; prompt: string; rounds: number }, log: (msg: string) => void) => Promise<{ status: string; rounds: number; participants: string[]; totalCaptures: number; responses: Map<string, string[]> }> };
  navigatorAgent?: { execute: (instruction: string, context: any) => Promise<{ summary: string }>; listPanels: () => string; setBudget?: (budget: any) => void };
  layoutAgent?: { execute: (instruction: string, context: any) => Promise<{ summary: string }>; setBudget?: (budget: any) => void };
  mcpRouter?: { resolveAll: () => Array<{ name: string; description: string; input_schema: Record<string, unknown> }>; callMcp?: (name: string, input: Record<string, unknown>) => Promise<string>; hasTool?: (name: string) => boolean; mcpCoveredApps?: () => Map<string, string[]> };
  dripManager?: {
    listCustoms: () => Array<{ name: string; recipe: string }>;
    saveCustom: (name: string, recipe: string) => string;
    deleteCustom: (name: string) => string;
    listBuiltinEffects: () => string[];
  };
  layoutManager?: {
    listLayouts: () => Array<{ name: string; version: 2; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }> }>;
    getLayout: (name: string) => { name: string; version: 2; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }> } | undefined;
    saveLayout: (grid: { name: string; version: 2; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }> }) => void;
    deleteLayout: (name: string) => boolean;
  };
  dataStore?: {
    get: (namespace: string, key: string) => unknown | null;
    set: (namespace: string, key: string, value: unknown) => void;
    delete: (namespace: string, key: string) => boolean;
    list: (namespace: string, prefix?: string, limit?: number) => Array<{ key: string; value: unknown; updatedAt: number }>;
    query: (namespace: string, filter: Record<string, unknown>, limit?: number) => Array<{ key: string; value: unknown; updatedAt: number }>;
    keys: (namespace: string) => string[];
    count: (namespace: string) => number;
    clear: (namespace: string) => number;
    listNamespaces: () => string[];
  };
}

let deps: SubstrateToolDeps = {};
export function setSubstrateToolDeps(d: SubstrateToolDeps): void { deps = { ...deps, ...d }; }

export interface ToolDef {
  /** Bare name as the LLM sees it (e.g. "search_captures"). */
  name: string;
  /** Display namespace ("yo" | "skill" | app id). */
  namespace: "yo" | "skill" | string;
  description: string;
  input_schema: Record<string, unknown>;
  /** True if invocation is destructive (triggers act.checkpoint). */
  destructive?: boolean;
  /** Implementation. Receives input + privileged deps. */
  run: (input: Record<string, unknown>) => Promise<string>;
}

// ── Built-in substrate tools (namespace: yo) ────────────────

const BUILTIN_TOOLS: ToolDef[] = [
  {
    name: "search_captures",
    namespace: "yo",
    description: "Vector search across all captured content (.sup captures). Returns ranked results with confidence scores. Use descriptive natural language queries for best results.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Descriptive search query" },
        limit: { type: "number", description: "Max results (default 10)" },
      },
      required: ["query"],
    },
    async run(input) {
      const query = input.query as string;
      const limit = (input.limit as number) || 10;
      if (!query) return "No query provided.";
      if (!deps.captureStore) return "Capture store not available.";
      const results = await deps.captureStore.search(query, limit);
      if (results.length === 0) return "No matching captures found.";
      return results.map((r, i) => {
        const ageMs = Date.now() - r.meta.created;
        const age = ageMs < 60_000 ? "just now" :
          ageMs < 3_600_000 ? `${Math.floor(ageMs / 60_000)}m ago` :
          ageMs < 86_400_000 ? `${Math.floor(ageMs / 3_600_000)}h ago` :
          `${Math.floor(ageMs / 86_400_000)}d ago`;
        return `[${i + 1}] score: ${r.score.toFixed(2)} | source: ${r.meta.source} | ${age}\n${r.content.slice(0, 800)}`;
      }).join("\n\n---\n\n");
    },
  },
  {
    name: "get_context",
    namespace: "yo",
    description: "Read current session context — in-memory .sup captures from this session.",
    input_schema: { type: "object", properties: {} },
    async run() {
      if (!deps.sessionCache) return "Session cache not available.";
      const content = deps.sessionCache.get();
      return content || "No captures in this session yet.";
    },
  },
  {
    name: "format",
    namespace: "yo",
    description: "Apply a named skill to format content. If no skill specified, lists available skills.",
    input_schema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Content to format" },
        skill: { type: "string", description: "Skill name (omit to list)" },
      },
    },
    async run(input) {
      const content = input.content as string;
      const skill = input.skill as string;
      if (!deps.skillEngine) return "Skill engine not available.";
      if (!skill) {
        const skills = deps.skillEngine.listSkillsDetailed();
        if (skills.length === 0) return "No skills available.";
        return `Available skills:\n${skills.map((s) => `- ${s.name}${s.description ? ` — ${s.description}` : ""}`).join("\n")}\n\nCall format again with a skill name.`;
      }
      if (!content) return "No content provided.";
      try {
        const out = await deps.skillEngine.runSkill(skill, content, { trigger: "skill" });
        if (out === undefined || out === null) return "[skill produced no output]";
        return typeof out === "string" ? out : JSON.stringify(out, null, 2);
      } catch (err) {
        return `Skill error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },
  {
    name: "save_memory",
    namespace: "yo",
    description: "Save something to persistent memory. Use for preferences, facts about the user's work.",
    input_schema: {
      type: "object",
      properties: {
        content: { type: "string", description: "What to remember" },
        category: { type: "string", enum: ["preference", "fact", "workflow", "app_pattern", "context"] },
      },
      required: ["content", "category"],
    },
    async run(input) {
      const content = input.content as string;
      const category = (input.category as string) || "context";
      if (!content) return "No content provided.";
      if (!deps.memoryStore) return "Memory not available.";
      const id = await deps.memoryStore.save(content, category);
      return `Memory saved (${id}).`;
    },
  },
  {
    name: "create_skill",
    namespace: "yo",
    description: "Create or overwrite a skill. Provide the full SKILL.md prompt body and manifest fields. Call with just 'name' to get the current skill template.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name (lowercase, hyphens ok)" },
        description: { type: "string", description: "One-line description of what the skill does" },
        prompt: { type: "string", description: "The skill prompt (instructions for the LLM when this skill runs)" },
        allowed_tools: { type: "array", items: { type: "string" }, description: "Tools this skill can use, e.g. ['gmail.send_email', 'yo.search_captures']" },
        requires: { type: "array", items: { type: "string" }, description: "Other skills this skill can call" },
        schedule: { type: "string", description: "Cron expression for auto-scheduling, e.g. '0 9 * * 1-5' for weekdays at 9am" },
        inputs: { type: "array", items: { type: "object", properties: { name: { type: "string" }, type: { type: "string" }, description: { type: "string" } } }, description: "Input parameters the skill accepts" },
        runner_code: { type: "string", description: "Optional SKILL.js lifecycle runner code (advanced)" },
      },
      required: ["name", "description", "prompt"],
    },
    async run(input) {
      if (!deps.skillEngine) return "Skill engine not available.";
      const name = input.name as string;
      if (!name) return "Skill name is required.";
      const manifest: Record<string, unknown> = {
        name,
        description: input.description as string || "",
      };
      if (input.allowed_tools) manifest["allowed-tools"] = input.allowed_tools;
      if (input.requires) manifest.requires = input.requires;
      if (input.schedule) manifest.schedule = input.schedule;
      if (input.inputs) manifest.inputs = input.inputs;
      const prompt = input.prompt as string || "";
      const runner = input.runner_code as string | undefined;
      const ok = deps.skillEngine.writeSkill(name, manifest, prompt, runner);
      if (!ok) return `Failed to create skill "${name}".`;
      return `Skill "${name}" created. The user can run it with .yo format <content> ${name}, or you can call skill_${name.replace(/[^a-zA-Z0-9_]/g, "_")} to test it.`;
    },
  },
  {
    name: "update_skill",
    namespace: "yo",
    description: "Update an existing skill's prompt, manifest fields, or runner code. Only provided fields are changed.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name to update" },
        description: { type: "string", description: "Updated description" },
        prompt: { type: "string", description: "Updated prompt body" },
        allowed_tools: { type: "array", items: { type: "string" }, description: "Updated allowed tools list" },
        requires: { type: "array", items: { type: "string" }, description: "Updated skill dependencies" },
        schedule: { type: "string", description: "Updated cron schedule (empty string to remove)" },
        inputs: { type: "array", items: { type: "object", properties: { name: { type: "string" }, type: { type: "string" }, description: { type: "string" } } }, description: "Updated input parameters" },
        runner_code: { type: "string", description: "Updated SKILL.js code (null to remove)" },
      },
      required: ["name"],
    },
    async run(input) {
      if (!deps.skillEngine) return "Skill engine not available.";
      const name = input.name as string;
      const existing = deps.skillEngine.getSkill(name);
      if (!existing) return `Skill "${name}" not found. Use create_skill to create it.`;
      const manifest = { ...existing.manifest };
      if (input.description !== undefined) manifest.description = input.description;
      if (input.allowed_tools !== undefined) manifest["allowed-tools"] = input.allowed_tools;
      if (input.requires !== undefined) manifest.requires = input.requires;
      if (input.schedule !== undefined) manifest.schedule = (input.schedule as string) || null;
      if (input.inputs !== undefined) manifest.inputs = input.inputs;
      const prompt = (input.prompt as string) ?? existing.prompt;
      const runner = input.runner_code !== undefined ? (input.runner_code as string | null) : undefined;
      const ok = deps.skillEngine.writeSkill(name, manifest, prompt, runner);
      if (!ok) return `Failed to update skill "${name}".`;
      return `Skill "${name}" updated.`;
    },
  },
  {
    name: "read_skill",
    namespace: "yo",
    description: "Read a skill's full definition — manifest, prompt, runner status, and files.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name" },
      },
      required: ["name"],
    },
    async run(input) {
      if (!deps.skillEngine) return "Skill engine not available.";
      const name = input.name as string;
      const skill = deps.skillEngine.getSkill(name);
      if (!skill) return `Skill "${name}" not found.`;
      const lines = [
        `Skill: ${name}`,
        `Description: ${(skill.manifest as any).description || "(none)"}`,
        `Has runner: ${skill.hasRunner}`,
      ];
      const m = skill.manifest as Record<string, unknown>;
      if (m["allowed-tools"]) lines.push(`Allowed tools: ${(m["allowed-tools"] as string[]).join(", ")}`);
      if (m.requires) lines.push(`Requires: ${(m.requires as string[]).join(", ")}`);
      if (m.schedule) lines.push(`Schedule: ${m.schedule}`);
      if (m.inputs) lines.push(`Inputs: ${JSON.stringify(m.inputs)}`);
      lines.push("", "--- PROMPT ---", skill.prompt);
      if (skill.hasRunner) {
        const jsContent = deps.skillEngine.readSkillFile(name, "SKILL.js");
        if (jsContent) lines.push("", "--- SKILL.js ---", jsContent);
      }
      const files = deps.skillEngine.listSkillFiles(name);
      const extraFiles = files.filter(f => f !== "SKILL.md" && f !== "SKILL.js");
      if (extraFiles.length > 0) lines.push("", `Other files: ${extraFiles.join(", ")}`);
      return lines.join("\n");
    },
  },
  {
    name: "create_drip",
    namespace: "yo",
    description: "Create or overwrite a custom drip recipe. A drip is a visual effect overlay. Recipes combine built-in effects with optional count and opacity.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Drip name (lowercase, no spaces)" },
        recipe: { type: "string", description: "Recipe string, e.g. 'fireworks hearts 2' or '-1 0.5 matrix' for persistent" },
      },
      required: ["name", "recipe"],
    },
    async run(input) {
      if (!deps.dripManager) return "Drip manager not available.";
      const name = (input.name as string).toLowerCase().replace(/\s+/g, "-");
      const recipe = input.recipe as string;
      if (!name || !recipe) return "Name and recipe are required.";
      return deps.dripManager.saveCustom(name, recipe);
    },
  },
  {
    name: "update_drip",
    namespace: "yo",
    description: "Update an existing custom drip recipe.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Drip name to update" },
        recipe: { type: "string", description: "New recipe string" },
      },
      required: ["name", "recipe"],
    },
    async run(input) {
      if (!deps.dripManager) return "Drip manager not available.";
      const name = (input.name as string).toLowerCase();
      const customs = deps.dripManager.listCustoms();
      if (!customs.find(c => c.name === name)) return `Drip "${name}" not found. Use create_drip to create it.`;
      return deps.dripManager.saveCustom(name, input.recipe as string);
    },
  },
  {
    name: "read_drip",
    namespace: "yo",
    description: "Read drip definitions — a specific custom drip, or list all available effects and custom drips.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Drip name (omit to list all)" },
      },
    },
    async run(input) {
      if (!deps.dripManager) return "Drip manager not available.";
      const name = input.name as string;
      if (name) {
        const customs = deps.dripManager.listCustoms();
        const found = customs.find(c => c.name === name.toLowerCase());
        if (found) return `Drip: ${found.name}\nRecipe: ${found.recipe}`;
        const builtins = deps.dripManager.listBuiltinEffects();
        if (builtins.includes(name.toLowerCase())) return `"${name}" is a built-in effect (not a custom drip).`;
        return `Drip "${name}" not found.`;
      }
      const builtins = deps.dripManager.listBuiltinEffects();
      const customs = deps.dripManager.listCustoms();
      const lines = [`Built-in effects: ${builtins.join(", ")}`];
      if (customs.length > 0) {
        lines.push("", "Custom drips:");
        for (const c of customs) lines.push(`  ${c.name} → ${c.recipe}`);
      } else {
        lines.push("", "No custom drips yet.");
      }
      lines.push("", "Recipe syntax:", "  [count] [effects...] — one-shot, e.g. 'fireworks hearts 2'", "  -1 [opacity] [effects...] — persistent loop, e.g. '-1 0.5 matrix'", "  Opacity: 0-1 float (default 0.5 for persistent)", "  Count: integer 1-10 (default 1)");
      return lines.join("\n");
    },
  },
  {
    name: "create_layout",
    namespace: "yo",
    description: "Create or overwrite a named panel layout. A layout is a grid arrangement of app panels.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Layout name" },
        cols: { type: "number", description: "Number of columns (1-4)" },
        rows: { type: "number", description: "Number of rows (1-4)" },
        col_widths: { type: "array", items: { type: "number" }, description: "Column width fractions (must sum to ~1), e.g. [0.5, 0.5]" },
        row_heights: { type: "array", items: { type: "number" }, description: "Row height fractions (must sum to ~1), e.g. [0.6, 0.4]" },
        cells: {
          type: "array",
          items: {
            type: "object",
            properties: {
              panel_id: { type: "string", description: "App panel ID (e.g. 'gmail', 'claude', 'slack')" },
              col: { type: "number", description: "0-based column" },
              row: { type: "number", description: "0-based row" },
              col_span: { type: "number", description: "Width in grid cells (default 1)" },
              row_span: { type: "number", description: "Height in grid cells (default 1)" },
            },
            required: ["panel_id", "col", "row"],
          },
          description: "Panel placements in the grid",
        },
      },
      required: ["name", "cols", "rows", "cells"],
    },
    async run(input) {
      if (!deps.layoutManager) return "Layout manager not available.";
      const name = input.name as string;
      const cols = Math.max(1, Math.min(4, input.cols as number));
      const rows = Math.max(1, Math.min(4, input.rows as number));
      const colWidths = (input.col_widths as number[]) || Array(cols).fill(1 / cols);
      const rowHeights = (input.row_heights as number[]) || Array(rows).fill(1 / rows);
      const rawCells = input.cells as Array<{ panel_id: string; col: number; row: number; col_span?: number; row_span?: number }>;
      if (!rawCells || rawCells.length === 0) return "At least one cell is required.";
      const cells = rawCells.map(c => ({
        panelId: c.panel_id,
        col: c.col,
        row: c.row,
        colSpan: c.col_span || 1,
        rowSpan: c.row_span || 1,
      }));
      const grid = { name, version: 2 as const, cols, rows, colWidths, rowHeights, cells };
      deps.layoutManager.saveLayout(grid);
      return `Layout "${name}" saved (${cols}x${rows} grid, ${cells.length} panels). The user can apply it from the layouts page or with .dip layout ${name}.`;
    },
  },
  {
    name: "update_layout",
    namespace: "yo",
    description: "Update an existing layout's grid, panels, or proportions. Only provided fields are changed.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Layout name to update" },
        cols: { type: "number", description: "Updated column count" },
        rows: { type: "number", description: "Updated row count" },
        col_widths: { type: "array", items: { type: "number" }, description: "Updated column widths" },
        row_heights: { type: "array", items: { type: "number" }, description: "Updated row heights" },
        cells: {
          type: "array",
          items: {
            type: "object",
            properties: {
              panel_id: { type: "string" },
              col: { type: "number" },
              row: { type: "number" },
              col_span: { type: "number" },
              row_span: { type: "number" },
            },
            required: ["panel_id", "col", "row"],
          },
          description: "Updated panel placements",
        },
      },
      required: ["name"],
    },
    async run(input) {
      if (!deps.layoutManager) return "Layout manager not available.";
      const name = input.name as string;
      const existing = deps.layoutManager.getLayout(name);
      if (!existing) return `Layout "${name}" not found. Use create_layout to create it.`;
      const grid = { ...existing };
      if (input.cols !== undefined) grid.cols = Math.max(1, Math.min(4, input.cols as number));
      if (input.rows !== undefined) grid.rows = Math.max(1, Math.min(4, input.rows as number));
      if (input.col_widths) grid.colWidths = input.col_widths as number[];
      if (input.row_heights) grid.rowHeights = input.row_heights as number[];
      if (input.cells) {
        grid.cells = (input.cells as Array<{ panel_id: string; col: number; row: number; col_span?: number; row_span?: number }>).map(c => ({
          panelId: c.panel_id,
          col: c.col,
          row: c.row,
          colSpan: c.col_span || 1,
          rowSpan: c.row_span || 1,
        }));
      }
      deps.layoutManager.saveLayout(grid);
      return `Layout "${name}" updated.`;
    },
  },
  {
    name: "read_layout",
    namespace: "yo",
    description: "Read a layout's definition, or list all saved layouts.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Layout name (omit to list all)" },
      },
    },
    async run(input) {
      if (!deps.layoutManager) return "Layout manager not available.";
      const name = input.name as string;
      if (name) {
        const layout = deps.layoutManager.getLayout(name);
        if (!layout) return `Layout "${name}" not found.`;
        const lines = [
          `Layout: ${layout.name}`,
          `Grid: ${layout.cols}x${layout.rows}`,
          `Column widths: ${layout.colWidths.map(w => w.toFixed(2)).join(", ")}`,
          `Row heights: ${layout.rowHeights.map(h => h.toFixed(2)).join(", ")}`,
          "", "Cells:",
        ];
        for (const c of layout.cells) {
          const span = (c.colSpan > 1 || c.rowSpan > 1) ? ` (span ${c.colSpan}x${c.rowSpan})` : "";
          lines.push(`  [${c.col},${c.row}] ${c.panelId}${span}`);
        }
        return lines.join("\n");
      }
      const layouts = deps.layoutManager.listLayouts();
      if (layouts.length === 0) return "No saved layouts.";
      return layouts.map(l => {
        const panels = l.cells.map(c => c.panelId).join(", ");
        return `${l.name} — ${l.cols}x${l.rows} grid — ${panels}`;
      }).join("\n");
    },
  },
  {
    name: "create_vibe",
    namespace: "yo",
    description: "Create a vibe app — an interactive HTML panel powered by skills. Creates a skill with type: vibe and writes APP.html.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Vibe name (lowercase, hyphens ok)" },
        description: { type: "string", description: "One-line description" },
        html: { type: "string", description: "Full APP.html content — the vibe's UI (self-contained HTML with inline CSS/JS)" },
        prompt: { type: "string", description: "System prompt for the vibe's backing skill (optional)" },
        requires: { type: "array", items: { type: "string" }, description: "Skills this vibe can call via window.vibe.runSkill()" },
        allowed_tools: { type: "array", items: { type: "string" }, description: "Tools the backing skill can use" },
      },
      required: ["name", "description", "html"],
    },
    async run(input) {
      if (!deps.skillEngine) return "Skill engine not available.";
      const name = input.name as string;
      if (!name) return "Vibe name is required.";
      const manifest: Record<string, unknown> = {
        name,
        description: input.description as string || "",
        type: "vibe",
      };
      if (input.requires) manifest.requires = input.requires;
      if (input.allowed_tools) manifest["allowed-tools"] = input.allowed_tools;
      const prompt = (input.prompt as string) || "";
      const ok = deps.skillEngine.writeSkill(name, manifest, prompt);
      if (!ok) return `Failed to create vibe "${name}".`;
      deps.skillEngine.writeSkillFile(name, "APP.html", input.html as string);
      return `Vibe "${name}" created. Open it with .dip vibe-${name}`;
    },
  },
  {
    name: "update_vibe",
    namespace: "yo",
    description: "Update a vibe's HTML, prompt, or manifest. Only provided fields are changed.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Vibe name to update" },
        html: { type: "string", description: "Updated APP.html content" },
        description: { type: "string", description: "Updated description" },
        prompt: { type: "string", description: "Updated skill prompt" },
        requires: { type: "array", items: { type: "string" }, description: "Updated skill dependencies" },
        allowed_tools: { type: "array", items: { type: "string" }, description: "Updated allowed tools" },
      },
      required: ["name"],
    },
    async run(input) {
      if (!deps.skillEngine) return "Skill engine not available.";
      const name = input.name as string;
      const existing = deps.skillEngine.getSkill(name);
      if (!existing) return `Vibe "${name}" not found. Use create_vibe to create it.`;
      const manifest = { ...existing.manifest };
      if (input.description !== undefined) manifest.description = input.description;
      if (input.requires !== undefined) manifest.requires = input.requires;
      if (input.allowed_tools !== undefined) manifest["allowed-tools"] = input.allowed_tools;
      manifest.type = "vibe";
      const prompt = (input.prompt as string) ?? existing.prompt;
      deps.skillEngine.writeSkill(name, manifest, prompt);
      if (input.html !== undefined) {
        deps.skillEngine.writeSkillFile(name, "APP.html", input.html as string);
      }
      return `Vibe "${name}" updated.`;
    },
  },
  {
    name: "read_vibe",
    namespace: "yo",
    description: "Read a vibe's HTML and manifest, or list all vibes.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Vibe name (omit to list all)" },
      },
    },
    async run(input) {
      if (!deps.skillEngine) return "Skill engine not available.";
      const name = input.name as string;
      if (!name) {
        const vibes = deps.skillEngine.listVibes();
        if (vibes.length === 0) return "No vibes found. Use create_vibe to make one.";
        return vibes.map(v => `${v.name} — ${v.description || "(no description)"}`).join("\n");
      }
      const skill = deps.skillEngine.getSkill(name);
      if (!skill) return `Vibe "${name}" not found.`;
      const lines = [`Vibe: ${name}`, `Description: ${(skill.manifest as any).description || "(none)"}`];
      const m = skill.manifest as Record<string, unknown>;
      if (m.requires) lines.push(`Requires: ${(m.requires as string[]).join(", ")}`);
      if (m["allowed-tools"]) lines.push(`Allowed tools: ${(m["allowed-tools"] as string[]).join(", ")}`);
      const html = deps.skillEngine.readSkillFile(name, "APP.html");
      if (html) lines.push("", "--- APP.html ---", html);
      if (skill.prompt) lines.push("", "--- PROMPT ---", skill.prompt);
      return lines.join("\n");
    },
  },
  // ── Data store tools ──────────────────────────────────────
  {
    name: "store_set",
    namespace: "yo",
    description: "Store a value in a namespaced key-value store. Values are JSON — store objects, arrays, strings, numbers, etc.",
    input_schema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Store namespace (e.g. skill/vibe name, or any logical group)" },
        key: { type: "string", description: "Key to store under" },
        value: { description: "JSON value to store (object, array, string, number, boolean)" },
      },
      required: ["namespace", "key", "value"],
    },
    async run(input) {
      if (!deps.dataStore) return "Data store not available.";
      const ns = input.namespace as string;
      const key = input.key as string;
      deps.dataStore.set(ns, key, input.value);
      return `Stored "${key}" in "${ns}".`;
    },
  },
  {
    name: "store_get",
    namespace: "yo",
    description: "Get a value by key from a namespaced store.",
    input_schema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Store namespace" },
        key: { type: "string", description: "Key to retrieve" },
      },
      required: ["namespace", "key"],
    },
    async run(input) {
      if (!deps.dataStore) return "Data store not available.";
      const val = deps.dataStore.get(input.namespace as string, input.key as string);
      if (val === null) return `Key "${input.key}" not found in "${input.namespace}".`;
      return JSON.stringify(val, null, 2);
    },
  },
  {
    name: "store_delete",
    namespace: "yo",
    description: "Delete a key from a namespaced store.",
    input_schema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Store namespace" },
        key: { type: "string", description: "Key to delete" },
      },
      required: ["namespace", "key"],
    },
    async run(input) {
      if (!deps.dataStore) return "Data store not available.";
      const deleted = deps.dataStore.delete(input.namespace as string, input.key as string);
      return deleted ? `Deleted "${input.key}" from "${input.namespace}".` : `Key "${input.key}" not found.`;
    },
  },
  {
    name: "store_list",
    namespace: "yo",
    description: "List entries in a namespaced store. Optional prefix filter. Returns keys and values.",
    input_schema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Store namespace" },
        prefix: { type: "string", description: "Key prefix filter (optional)" },
        limit: { type: "number", description: "Max results (default 100)" },
      },
      required: ["namespace"],
    },
    async run(input) {
      if (!deps.dataStore) return "Data store not available.";
      const ns = input.namespace as string;
      const entries = deps.dataStore.list(ns, input.prefix as string | undefined, (input.limit as number) || 100);
      if (entries.length === 0) return `No entries in "${ns}"${input.prefix ? ` with prefix "${input.prefix}"` : ""}.`;
      return entries.map(e => `${e.key}: ${JSON.stringify(e.value)}`).join("\n");
    },
  },
  {
    name: "store_query",
    namespace: "yo",
    description: "Query a namespaced store by field values inside JSON objects. Filter by one or more fields to find matching entries.",
    input_schema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Store namespace" },
        filter: { type: "object", description: "Field-value pairs to match (e.g. {\"status\": \"active\", \"role\": \"admin\"})" },
        limit: { type: "number", description: "Max results (default 100)" },
      },
      required: ["namespace", "filter"],
    },
    async run(input) {
      if (!deps.dataStore) return "Data store not available.";
      const ns = input.namespace as string;
      const filter = input.filter as Record<string, unknown>;
      if (!filter || Object.keys(filter).length === 0) return "Filter must have at least one field.";
      const entries = deps.dataStore.query(ns, filter, (input.limit as number) || 100);
      if (entries.length === 0) return `No entries in "${ns}" matching filter.`;
      return entries.map(e => `${e.key}: ${JSON.stringify(e.value)}`).join("\n");
    },
  },
  {
    name: "store_info",
    namespace: "yo",
    description: "Get info about stores: list all namespaces, or count entries in a specific namespace.",
    input_schema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Namespace to count (omit to list all namespaces)" },
      },
    },
    async run(input) {
      if (!deps.dataStore) return "Data store not available.";
      const ns = input.namespace as string;
      if (!ns) {
        const namespaces = deps.dataStore.listNamespaces();
        if (namespaces.length === 0) return "No data stores exist yet. Use store_set to create one.";
        return namespaces.join("\n");
      }
      const count = deps.dataStore.count(ns);
      return `Store "${ns}": ${count} entries.`;
    },
  },
  {
    name: "search_notes",
    namespace: "yo",
    description: "Search saved notes in ~/yo/notes/.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results (default 10)" },
      },
      required: ["query"],
    },
    async run(input) {
      const query = input.query as string;
      const limit = (input.limit as number) || 10;
      if (!query) return "No query provided.";
      if (!deps.noteStore) return "Note store not available.";
      const results = await deps.noteStore.search(query, limit);
      if (results.length === 0) return "No matching notes found.";
      return results.map((r, i) =>
        `[${i + 1}] ${r.title} (${r.file}) — rank: ${r.rank.toFixed(2)}\n${r.content.slice(0, 600)}`
      ).join("\n\n---\n\n");
    },
  },
  {
    name: "read_file",
    namespace: "yo",
    description: "Read a file under ~/yo/ or ~/.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "File path (relative to ~/yo/ or absolute)" } },
      required: ["path"],
    },
    async run(input) {
      let filePath = input.path as string;
      if (!filePath) return "No path provided.";
      if (!path.isAbsolute(filePath)) filePath = path.join(os.homedir(), "yo", filePath);
      const resolved = path.resolve(filePath);
      const yoDir = path.join(os.homedir(), "yo");
      if (!resolved.startsWith(yoDir) && !resolved.startsWith(os.homedir())) {
        return "Access denied — can only read files under ~/";
      }
      if (!fs.existsSync(resolved)) return `File not found: ${resolved}`;
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) return `${resolved} is a directory.`;
      if (stat.size > 500_000) return `File too large (${(stat.size / 1024).toFixed(0)} KB). Max 500 KB.`;
      return fs.readFileSync(resolved, "utf-8");
    },
  },
  {
    name: "list_files",
    namespace: "yo",
    description: "List files in a directory under ~/.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path" },
        pattern: { type: "string", description: "Glob pattern" },
      },
    },
    async run(input) {
      let dirPath = (input.path as string) || path.join(os.homedir(), "yo", "notes");
      const pattern = (input.pattern as string) || "";
      if (!path.isAbsolute(dirPath)) dirPath = path.join(os.homedir(), "yo", dirPath);
      const resolved = path.resolve(dirPath);
      if (!resolved.startsWith(os.homedir())) return "Access denied — can only list files under ~/";
      if (!fs.existsSync(resolved)) return `Directory not found: ${resolved}`;
      if (!fs.statSync(resolved).isDirectory()) return `Not a directory: ${resolved}`;
      let entries = fs.readdirSync(resolved);
      if (pattern) {
        const re = new RegExp("^" + pattern.replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
        entries = entries.filter((e) => re.test(e));
      }
      if (entries.length === 0) return "No files found.";
      const lines = entries.slice(0, 100).map((name) => {
        try {
          const stat = fs.statSync(path.join(resolved, name));
          const size = stat.isDirectory() ? "dir" : `${(stat.size / 1024).toFixed(1)}K`;
          const modified = new Date(stat.mtimeMs).toISOString().slice(0, 16).replace("T", " ");
          return `${name.padEnd(40)} ${size.padStart(8)}  ${modified}`;
        } catch { return name; }
      });
      if (entries.length > 100) lines.push(`... and ${entries.length - 100} more`);
      return lines.join("\n");
    },
  },
  {
    name: "run_command",
    namespace: "yo",
    description: "Run a read-only shell command (allowlist: git, ls, cat, head, tail, wc, find, which, echo, pwd, date).",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command to run" },
        cwd: { type: "string", description: "Working directory" },
      },
      required: ["command"],
    },
    async run(input) {
      const command = input.command as string;
      if (!command) return "No command provided.";
      const firstWord = command.trim().split(/\s+/)[0];
      const allowed = new Set(["git", "ls", "cat", "head", "tail", "wc", "find", "which", "echo", "pwd", "date"]);
      if (!firstWord || !allowed.has(firstWord)) {
        return `Command not allowed: ${firstWord}. Allowed: ${[...allowed].join(", ")}`;
      }
      if (firstWord === "git") {
        const subCmd = command.trim().split(/\s+/)[1];
        const destructive = new Set(["push", "reset", "clean", "checkout", "rebase", "merge", "commit", "stash", "rm", "mv"]);
        if (subCmd && destructive.has(subCmd)) return `Destructive git command not allowed: git ${subCmd}`;
      }
      let cwd = (input.cwd as string) || os.homedir();
      if (!path.isAbsolute(cwd)) cwd = path.join(os.homedir(), cwd);
      try {
        const output = execSync(command, {
          cwd, timeout: 30_000, maxBuffer: 512 * 1024,
          encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
        });
        return output.slice(0, 10_000) || "(no output)";
      } catch (err: any) {
        return `Command failed: ${err.stderr || err.message || err}`.slice(0, 2000);
      }
    },
  },
  {
    name: "start_council",
    namespace: "yo",
    description: "Start a multi-model council debate.",
    input_schema: {
      type: "object",
      properties: {
        participants: { type: "array", items: { type: "string" }, description: "Model identifiers" },
        prompt: { type: "string", description: "Discussion prompt" },
        rounds: { type: "number", description: "Number of rounds (default 2)" },
      },
      required: ["participants", "prompt"],
    },
    async run(input) {
      const participants = input.participants as string[];
      const prompt = input.prompt as string;
      const rounds = (input.rounds as number) || 2;
      if (!participants || participants.length < 2) return "Council requires at least 2 participants.";
      if (!prompt) return "No prompt provided.";
      if (!deps.council) return "Council not available.";
      const result = await deps.council.start({ participants, prompt, rounds }, (msg) => console.log("[council]", msg));
      if (result.status === "error") return "Council failed to start.";
      if (result.status === "cancelled") return "Council was cancelled.";
      const lines = [
        `Council complete: ${result.rounds} round(s), ${result.participants.length} participants, ${result.totalCaptures} responses captured.`,
        "", "Participants: " + result.participants.join(", "),
      ];
      for (const [participant, resps] of result.responses) {
        if (resps.length > 0) {
          lines.push(`\n--- ${participant} (final response) ---`);
          lines.push(resps[resps.length - 1].slice(0, 3000));
        }
      }
      return lines.join("\n");
    },
  },
  {
    name: "delegate_navigate",
    namespace: "yo",
    description: "Delegate panel/app navigation tasks to a sub-agent.",
    input_schema: {
      type: "object",
      properties: { instruction: { type: "string", description: "Navigation task" } },
      required: ["instruction"],
    },
    async run(input) {
      const instruction = input.instruction as string;
      if (!instruction) return "No instruction provided.";
      if (!deps.navigatorAgent) return "Navigator not available.";
      try {
        deps.navigatorAgent.setBudget?.(null);
        const panelList = deps.navigatorAgent.listPanels();
        const enriched = panelList
          ? `${instruction}\n\nAVAILABLE APP PANELS:\n${panelList}`
          : instruction;
        const result = await deps.navigatorAgent.execute(enriched, null);
        return result.summary;
      } catch (err) {
        return `Delegation error: ${err instanceof Error ? err.message : err}`;
      }
    },
  },
  {
    name: "delegate_layout",
    namespace: "yo",
    description: "Delegate layout/grid arrangement tasks to a sub-agent.",
    input_schema: {
      type: "object",
      properties: { instruction: { type: "string", description: "Layout task" } },
      required: ["instruction"],
    },
    async run(input) {
      const instruction = input.instruction as string;
      if (!instruction) return "No instruction provided.";
      if (!deps.layoutAgent) return "Layout agent not available.";
      try {
        deps.layoutAgent.setBudget?.(null);
        const result = await deps.layoutAgent.execute(instruction, null);
        return result.summary;
      } catch (err) {
        return `Delegation error: ${err instanceof Error ? err.message : err}`;
      }
    },
  },
];

// Map for fast lookup
const BUILTIN_BY_NAME = new Map(BUILTIN_TOOLS.map((t) => [t.name, t]));

// ── Public API ──────────────────────────────────────────────

/**
 * Build the LLM tool spec dynamically: substrate + user skills + MCP.
 * `allowedTools` filters by qualified entries (yo.search_captures, gmail.send_email, etc).
 * Pass undefined/empty to get the full registry (substrate + all user skills).
 */
export function getAgentToolSpec(allowedTools?: string[]): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
  const out: Array<{ name: string; description: string; input_schema: Record<string, unknown> }> = [];
  const allowed = allowedTools && allowedTools.length > 0 ? new Set(allowedTools) : null;

  // Substrate tools
  for (const t of BUILTIN_TOOLS) {
    const qualified = `${t.namespace}.${t.name}`;
    if (allowed && !allowed.has(qualified)) continue;
    out.push({ name: t.name, description: t.description, input_schema: t.input_schema });
  }

  // User skills (unless filtered out by allowlist)
  if (deps.skillEngine) {
    for (const s of deps.skillEngine.listSkillsDetailed()) {
      const qualified = `skill.${s.name}`;
      if (allowed && !allowed.has(qualified)) continue;
      const skill = deps.skillEngine.getSkill(s.name);
      const inputs = (skill?.manifest.inputs ?? []) as Array<{ name: string; type: string; description?: string }>;
      const props: Record<string, unknown> = {};
      const required: string[] = [];
      for (const i of inputs) {
        props[i.name] = { type: i.type === "string" ? "string" : i.type === "number" ? "number" : "string", description: i.description ?? "" };
        required.push(i.name);
      }
      const schema = inputs.length > 0
        ? { type: "object", properties: props, required }
        : { type: "object", properties: { input: { type: "string", description: "Input for the skill" } } };
      out.push({
        name: `skill_${s.name.replace(/[^a-zA-Z0-9_]/g, "_")}`,
        description: `[user skill] ${s.description ?? s.name}`,
        input_schema: schema,
      });
    }
  }

  // MCP tools (already namespaced via skill-tool-router)
  if (deps.mcpRouter) {
    const mcpTools = deps.mcpRouter.resolveAll();
    for (const t of mcpTools) {
      if (allowed && !allowed.has(t.name)) continue;
      out.push(t);
    }
  }

  // Deduplicate by name — MCP servers can register the same tool twice
  const seen = new Set<string>();
  return out.filter(t => {
    if (seen.has(t.name)) return false;
    seen.add(t.name);
    return true;
  });
}

/**
 * Execute a tool by name. Routes to substrate, user skill, or MCP.
 * Returns the tool's text output.
 */
export async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  // 1. Substrate built-in?
  if (BUILTIN_BY_NAME.has(name)) {
    try {
      return await BUILTIN_BY_NAME.get(name)!.run(input);
    } catch (err) {
      return `Tool error (${name}): ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  // 2. User skill via the skill_<name> convention?
  if (name.startsWith("skill_")) {
    const skillName = name.slice(6).replace(/_/g, "-");
    if (!deps.skillEngine) return "Skill engine not available.";
    try {
      const skillInput = "input" in input ? input.input : input;
      const out = await deps.skillEngine.runSkill(skillName, skillInput, { trigger: "skill" });
      if (out === undefined || out === null) return "[skill produced no output]";
      return typeof out === "string" ? out : JSON.stringify(out, null, 2);
    } catch (err) {
      return `Skill error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  // 3. MCP tool (short name or legacy qualified name)?
  if (deps.mcpRouter?.callMcp && (name.startsWith("mcp__") || deps.mcpRouter.hasTool?.(name))) {
    return deps.mcpRouter.callMcp(name, input);
  }
  return `Unknown tool: ${name}`;
}

/** True if a tool is destructive (substrate-flagged or matches keywords). */
export function isDestructiveTool(name: string): boolean {
  const builtin = BUILTIN_BY_NAME.get(name);
  if (builtin?.destructive) return true;
  // Heuristic on name
  return /\b(send|delete|remove|publish|push|deploy|destroy)\b/i.test(name);
}

/** All registered tool names (for debugging / introspection). */
export function listAllTools(): string[] {
  return getAgentToolSpec().map((t) => t.name);
}

/**
 * Just the substrate built-in `yo.*` tools — used by skill-tool-router so
 * skills can declare `allowed-tools: [yo.search_captures]` etc.
 */
export function listBuiltinYoTools(): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
  return BUILTIN_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}
