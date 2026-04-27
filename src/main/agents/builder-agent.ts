/**
 * BuilderAgent — skill & vibe coding specialist.
 *
 * Writes skills (SKILL.md + SKILL.js), vibes (APP.html), and wires data
 * stores. The orchestrator delegates here for any "build me X" request.
 *
 * Data pipeline pattern enforced by system prompt:
 *   skill extracts → store normalizes → vibe renders from store
 */

import { BaseSubAgent } from "./base-agent";
import type { ToolDef } from "./types";

export class BuilderAgent extends BaseSubAgent {
  protected agentName = "builder";
  protected maxIterations = 12;
  protected responseMaxTokens = 8192;

  private skillCallbacks: {
    getSkill: (name: string) => { manifest: Record<string, unknown>; prompt: string; hasRunner: boolean; hasApp: boolean; folderPath: string } | null;
    writeSkill: (name: string, manifest: Record<string, unknown>, prompt: string, runnerCode?: string | null) => boolean;
    readSkillFile: (name: string, rel: string) => string | null;
    writeSkillFile: (name: string, rel: string, content: string) => boolean;
    listSkillFiles: (name: string) => string[];
    listSkillsDetailed: () => Array<{ name: string; description?: string; hasRunner: boolean; hasApp: boolean }>;
    listVibes: () => Array<{ name: string; description?: string }>;
  } | null = null;

  private storeCallbacks: {
    get: (namespace: string, key: string) => unknown | null;
    set: (namespace: string, key: string, value: unknown) => void;
    delete: (namespace: string, key: string) => boolean;
    list: (namespace: string, prefix?: string, limit?: number) => Array<{ key: string; value: unknown }>;
    query: (namespace: string, filter: Record<string, unknown>, limit?: number) => Array<{ key: string; value: unknown }>;
    keys: (namespace: string) => string[];
    count: (namespace: string) => number;
    clear: (namespace: string) => number;
    listNamespaces: () => string[];
  } | null = null;

  setSkillCallbacks(cbs: typeof this.skillCallbacks): void { this.skillCallbacks = cbs; }
  setStoreCallbacks(cbs: typeof this.storeCallbacks): void { this.storeCallbacks = cbs; }

  get systemPrompt(): string {
    return `You are a skill & vibe builder for the yo workspace. You write production-quality code for skills and vibes.

CRITICAL: You MUST call write_skill and write_vibe tools to save your work. Do NOT just describe what you would build — actually build it by calling tools. Every skill and vibe must be saved via a tool call or it does not exist. No planning, no asking — just build.

WHAT YOU BUILD:
- Skills: SKILL.md (prompt/frontmatter) + optional SKILL.js (runner code) for data extraction and processing
- Vibes: Interactive HTML apps (APP.html) with the window.vibe API, backed by skills and data stores

DATA PIPELINE PATTERN (critical):
When building vibes that display data, ALWAYS follow this pattern:
1. EXTRACT: Create helper skills that return structured JSON (not prose). Use SKILL.js runners or prompt-based extraction.
2. STORE: The vibe calls the skill, then normalizes and stores results via vibe.store.set(key, {structured data}).
3. RENDER: The vibe UI always reads from vibe.store.query()/list() — never renders raw skill output directly.

This ensures: consistent data shape, instant re-renders, offline access, and decoupled extract/display logic.

Example — email summary vibe:
- Helper skill "fetch-emails" with SKILL.js that extracts {from, subject, summary, date} objects
- Vibe calls vibe.runSkill("fetch-emails", {count: 10}), stores each as vibe.store.set("email-" + id, record)
- UI renders from vibe.store.list("email-") with consistent card layout
- Refresh button re-runs the skill and updates the store

SKILL.MD FRONTMATTER:
\`\`\`yaml
---
name: skill-name
description: What it does
type: vibe          # only for vibes
requires:           # skills this vibe can call
  - helper-skill-1
  - helper-skill-2
allowed-tools:      # MCP tools the skill can use
  - namespace.tool
---
Prompt body here (used as system prompt for the skill's LLM call)
\`\`\`

SKILL.JS RUNNER:
- module.exports = async function(ctx) { ... }
- ctx.input — the input passed to the skill
- ctx.llm(prompt) — make an LLM call, returns text
- ctx.search(query, limit?) — vector search captures
- ctx.readFile(rel) — read from skill folder
- ctx.store.get/set/delete/list/query — data store (namespace = skill name)
- Return value is the skill's output (JSON preferred for data skills)

VIBE APP.HTML API (window.vibe):
- vibe.runSkill(name, input) → {ok, output} or {ok:false, error} — call a skill in requires list
- vibe.ask(prompt) → text — one-shot LLM call
- vibe.searchCaptures(query, limit?) → [{source, content, score}]
- vibe.readFile(relPath) → file contents from skill folder
- vibe.copyToClipboard(text)
- vibe.onData(cb) — listen for pushed data
- vibe.store.get(key) → value or null
- vibe.store.set(key, value) — store JSON value
- vibe.store.delete(key) → boolean
- vibe.store.list(prefix?, limit?) → [{key, value}]
- vibe.store.query(filter, limit?) → [{key, value}] — filter by field values e.g. {status: "active"}
- vibe.store.keys() → string[]
- vibe.store.count() → number
- vibe.store.clear() → number of deleted entries
- vibe.getName() → this vibe's name

CHART.JS:
Chart.js is available via <script src="yo-asset://chart.umd.min.js"></script>.
Use new Chart(ctx, config) to create charts. Works with all Chart.js chart types (bar, line, pie, doughnut, radar, etc.).
For Chart.js theme colors: use getComputedStyle(document.documentElement) to read CSS variables at runtime.
Example: const style = getComputedStyle(document.documentElement); const textColor = style.getPropertyValue('--text-2').trim();

VIBE STYLING:
A base design system CSS is auto-injected into every vibe. It includes both light and dark theme variables, reset, typography, buttons, inputs, cards, badges, tables, and utility classes. Vibes are theme-aware — they follow the app's light/dark mode automatically via data-theme attribute.

DO NOT hardcode colors. Always use CSS variables:
- Backgrounds: var(--bg), var(--surface), var(--surface-2), var(--card-bg), var(--input-bg)
- Text: var(--text), var(--text-bright), var(--text-2), var(--text-3), var(--text-muted)
- Borders: var(--border), var(--border-2), var(--border-3)
- Accent: var(--accent), var(--accent-hover), var(--accent-dark), var(--accent-bg)
- Semantic: var(--danger), var(--warning), var(--success), var(--blue), var(--purple)
- Radii: var(--radius), var(--radius-sm), var(--radius-lg)
- Fonts: var(--font-sans), var(--font-mono)

Available base classes (no need to redefine):
- Buttons: .btn-primary, .btn-danger, .btn-ghost, .btn-sm, .btn-lg
- Cards: .card, .card-sm, .card-lg, .card-header
- Badges: .badge, .badge-accent, .badge-danger, .badge-info, .badge-muted
- Layout: .flex, .flex-col, .items-center, .justify-between, .justify-center, .gap-1 through .gap-4
- Spacing: .p-2 through .p-4, .mt-2 through .mt-4, .mb-2, .mb-3
- Text: .text-accent, .text-muted, .text-danger, .text-sm, .text-xs, .text-center, .font-mono, .font-bold
- Other: .spinner, .divider, .truncate, .rounded, .hidden, .fade-in, .w-full

Write minimal custom CSS — use the base system. Keep UI clean and functional.

RULES:
- CALL TOOLS IMMEDIATELY. Do not describe code — write it and call write_skill or write_vibe to save it.
- Write complete, working code — no placeholders or TODOs
- SKILL.js must return structured JSON for data skills (not prose or markdown)
- Vibes must handle loading states and errors gracefully
- When updating, use read_skill/read_vibe first to see current state
- Create helper skills first, then the vibe that uses them
- Always list helper skills in the vibe's requires field
- Store namespace = the vibe name (auto-scoped in vibe.store.*)
- For the agent tools (store_set/get/etc), namespace can be anything descriptive

EXECUTION ORDER:
1. Call write_skill for each helper skill (with full prompt and/or runner_code)
2. Call write_vibe with the complete APP.html (must include all HTML, CSS, JS inline)
3. Verify by calling read_skill on what you created
4. Respond with summary

RESPONSE FORMAT (must follow exactly):
After ALL tools have been called and skills/vibes are saved, respond with:
- What was created (skill names and descriptions)
- How to use it
- End with: VIBE_NAME: <name> (if you created a vibe — this line is parsed by the system)`;
  }

  get tools(): ToolDef[] {
    return [
      {
        name: "read_skill",
        description: "Read a skill's manifest, prompt, runner code, and files. Also use to list all skills or vibes.",
        input_schema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Skill name to read (omit to list all)" },
            file: { type: "string", description: "Specific file to read (e.g. SKILL.js, APP.html). Omit for manifest + prompt." },
            list_vibes: { type: "boolean", description: "If true, list only vibes instead of all skills" },
          },
        },
      },
      {
        name: "write_skill",
        description: "Create or update a skill. Writes SKILL.md (frontmatter + prompt) and optionally SKILL.js (runner code).",
        input_schema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Skill name" },
            description: { type: "string", description: "What the skill does" },
            prompt: { type: "string", description: "Prompt body (goes after frontmatter in SKILL.md)" },
            runner_code: { type: "string", description: "SKILL.js content (module.exports = async function(ctx) {...})" },
            allowed_tools: { type: "array", items: { type: "string" }, description: "MCP tools to allow (namespace.tool)" },
            requires: { type: "array", items: { type: "string" }, description: "Skills this skill/vibe can call" },
            schedule: { type: "string", description: "Cron expression for scheduled execution" },
          },
          required: ["name"],
        },
      },
      {
        name: "write_vibe",
        description: "Create or update a vibe app. Writes SKILL.md (type: vibe) + APP.html.",
        input_schema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Vibe name" },
            description: { type: "string", description: "What the vibe does" },
            prompt: { type: "string", description: "Optional prompt body" },
            html: { type: "string", description: "Full APP.html content" },
            requires: { type: "array", items: { type: "string" }, description: "Skills this vibe can call via vibe.runSkill()" },
            allowed_tools: { type: "array", items: { type: "string" }, description: "MCP tools to allow" },
          },
          required: ["name", "html"],
        },
      },
      {
        name: "write_file",
        description: "Write an arbitrary file to a skill's folder.",
        input_schema: {
          type: "object",
          properties: {
            skill: { type: "string", description: "Skill name" },
            path: { type: "string", description: "Relative file path within the skill folder" },
            content: { type: "string", description: "File content" },
          },
          required: ["skill", "path", "content"],
        },
      },
      {
        name: "list_files",
        description: "List files in a skill's folder.",
        input_schema: {
          type: "object",
          properties: {
            skill: { type: "string", description: "Skill name" },
          },
          required: ["skill"],
        },
      },
      {
        name: "store_set",
        description: "Store a value in the data store.",
        input_schema: {
          type: "object",
          properties: {
            namespace: { type: "string", description: "Store namespace" },
            key: { type: "string", description: "Key" },
            value: { description: "JSON value to store" },
          },
          required: ["namespace", "key", "value"],
        },
      },
      {
        name: "store_get",
        description: "Get a value from the data store.",
        input_schema: {
          type: "object",
          properties: {
            namespace: { type: "string", description: "Store namespace" },
            key: { type: "string", description: "Key to retrieve" },
          },
          required: ["namespace", "key"],
        },
      },
      {
        name: "store_list",
        description: "List entries in a data store namespace.",
        input_schema: {
          type: "object",
          properties: {
            namespace: { type: "string", description: "Store namespace" },
            prefix: { type: "string", description: "Key prefix filter" },
            limit: { type: "number", description: "Max results" },
          },
          required: ["namespace"],
        },
      },
      {
        name: "store_query",
        description: "Query data store by field values inside stored JSON objects.",
        input_schema: {
          type: "object",
          properties: {
            namespace: { type: "string", description: "Store namespace" },
            filter: { type: "object", description: "Field-value pairs to match" },
            limit: { type: "number", description: "Max results" },
          },
          required: ["namespace", "filter"],
        },
      },
      {
        name: "store_info",
        description: "List all store namespaces, or count entries in one.",
        input_schema: {
          type: "object",
          properties: {
            namespace: { type: "string", description: "Namespace to count (omit to list all)" },
          },
        },
      },
    ];
  }

  async execTool(name: string, input: Record<string, unknown>): Promise<string> {
    switch (name) {
      case "read_skill": return this.execReadSkill(input);
      case "write_skill": return this.execWriteSkill(input);
      case "write_vibe": return this.execWriteVibe(input);
      case "write_file": return this.execWriteFile(input);
      case "list_files": return this.execListFiles(input);
      case "store_set": return this.execStoreSet(input);
      case "store_get": return this.execStoreGet(input);
      case "store_list": return this.execStoreList(input);
      case "store_query": return this.execStoreQuery(input);
      case "store_info": return this.execStoreInfo(input);
      default: return `Unknown tool: ${name}`;
    }
  }

  private execReadSkill(input: Record<string, unknown>): string {
    if (!this.skillCallbacks) return "Skill engine not available.";
    const name = input.name as string | undefined;

    if (input.list_vibes) {
      const vibes = this.skillCallbacks.listVibes();
      if (vibes.length === 0) return "No vibes found.";
      return vibes.map(v => `${v.name} — ${v.description || "(no description)"}`).join("\n");
    }

    if (!name) {
      const skills = this.skillCallbacks.listSkillsDetailed();
      if (skills.length === 0) return "No skills found.";
      return skills.map(s => {
        const tags = [s.hasRunner ? "JS" : null, s.hasApp ? "VIBE" : null].filter(Boolean).join(",");
        return `${s.name}${tags ? ` [${tags}]` : ""} — ${s.description || "(no description)"}`;
      }).join("\n");
    }

    const file = input.file as string | undefined;
    if (file) {
      const content = this.skillCallbacks.readSkillFile(name, file);
      return content ?? `File "${file}" not found in skill "${name}".`;
    }

    const skill = this.skillCallbacks.getSkill(name);
    if (!skill) return `Skill "${name}" not found.`;
    const lines = [`Name: ${name}`, `Description: ${(skill.manifest as any).description || "(none)"}`];
    if (skill.manifest.type) lines.push(`Type: ${skill.manifest.type}`);
    if (skill.manifest.requires) lines.push(`Requires: ${(skill.manifest.requires as string[]).join(", ")}`);
    if (skill.manifest["allowed-tools"]) lines.push(`Allowed tools: ${(skill.manifest["allowed-tools"] as string[]).join(", ")}`);
    if (skill.prompt) lines.push("", "--- PROMPT ---", skill.prompt);
    if (skill.hasRunner) {
      const js = this.skillCallbacks.readSkillFile(name, "SKILL.js");
      if (js) lines.push("", "--- SKILL.js ---", js);
    }
    if (skill.hasApp) {
      const html = this.skillCallbacks.readSkillFile(name, "APP.html");
      if (html) lines.push("", "--- APP.html ---", html);
    }
    const files = this.skillCallbacks.listSkillFiles(name);
    const extra = files.filter(f => f !== "SKILL.md" && f !== "SKILL.js" && f !== "APP.html");
    if (extra.length > 0) lines.push("", "Other files: " + extra.join(", "));
    return lines.join("\n");
  }

  private execWriteSkill(input: Record<string, unknown>): string {
    if (!this.skillCallbacks) return "Skill engine not available.";
    const name = input.name as string;
    if (!name) return "Name is required.";

    const existing = this.skillCallbacks.getSkill(name);
    const manifest: Record<string, unknown> = existing ? { ...existing.manifest } : { name };

    if (input.description !== undefined) manifest.description = input.description;
    if (input.allowed_tools) manifest["allowed-tools"] = [...new Set(input.allowed_tools as string[])];
    if (input.requires) manifest.requires = [...new Set(input.requires as string[])];
    if (input.schedule !== undefined) manifest.schedule = input.schedule;

    const prompt = (input.prompt as string) ?? existing?.prompt ?? "";
    const runner = input.runner_code !== undefined
      ? (input.runner_code as string || null)
      : (existing?.hasRunner ? undefined : null);

    const ok = this.skillCallbacks.writeSkill(name, manifest, prompt, runner);
    return ok ? `Skill "${name}" saved.` : `Failed to save skill "${name}".`;
  }

  private execWriteVibe(input: Record<string, unknown>): string {
    if (!this.skillCallbacks) return "Skill engine not available.";
    const name = input.name as string;
    if (!name) return "Name is required.";
    const html = input.html as string;
    if (!html) return "HTML content is required.";

    const existing = this.skillCallbacks.getSkill(name);
    const manifest: Record<string, unknown> = existing ? { ...existing.manifest } : { name };
    manifest.type = "vibe";
    if (input.description !== undefined) manifest.description = input.description;
    if (input.requires) manifest.requires = [...new Set(input.requires as string[])];
    if (input.allowed_tools) manifest["allowed-tools"] = [...new Set(input.allowed_tools as string[])];

    const prompt = (input.prompt as string) ?? existing?.prompt ?? "";
    const ok = this.skillCallbacks.writeSkill(name, manifest, prompt, null);
    if (!ok) return `Failed to save vibe "${name}".`;
    this.skillCallbacks.writeSkillFile(name, "APP.html", html);
    return `Vibe "${name}" saved with APP.html.`;
  }

  private execWriteFile(input: Record<string, unknown>): string {
    if (!this.skillCallbacks) return "Skill engine not available.";
    const skill = input.skill as string;
    const filePath = input.path as string;
    const content = input.content as string;
    if (!skill || !filePath || content === undefined) return "skill, path, and content are required.";
    const ok = this.skillCallbacks.writeSkillFile(skill, filePath, content);
    return ok ? `Wrote ${filePath} to ${skill}.` : `Failed to write ${filePath}.`;
  }

  private execListFiles(input: Record<string, unknown>): string {
    if (!this.skillCallbacks) return "Skill engine not available.";
    const skill = input.skill as string;
    if (!skill) return "Skill name is required.";
    const files = this.skillCallbacks.listSkillFiles(skill);
    return files.length > 0 ? files.join("\n") : `No files in "${skill}".`;
  }

  private execStoreSet(input: Record<string, unknown>): string {
    if (!this.storeCallbacks) return "Data store not available.";
    this.storeCallbacks.set(input.namespace as string, input.key as string, input.value);
    return `Stored "${input.key}" in "${input.namespace}".`;
  }

  private execStoreGet(input: Record<string, unknown>): string {
    if (!this.storeCallbacks) return "Data store not available.";
    const val = this.storeCallbacks.get(input.namespace as string, input.key as string);
    if (val === null) return `Key "${input.key}" not found in "${input.namespace}".`;
    return JSON.stringify(val, null, 2);
  }

  private execStoreList(input: Record<string, unknown>): string {
    if (!this.storeCallbacks) return "Data store not available.";
    const entries = this.storeCallbacks.list(
      input.namespace as string, input.prefix as string | undefined, (input.limit as number) || 100
    );
    if (entries.length === 0) return `No entries in "${input.namespace}".`;
    return entries.map(e => `${e.key}: ${JSON.stringify(e.value)}`).join("\n");
  }

  private execStoreQuery(input: Record<string, unknown>): string {
    if (!this.storeCallbacks) return "Data store not available.";
    const filter = input.filter as Record<string, unknown>;
    if (!filter || Object.keys(filter).length === 0) return "Filter must have at least one field.";
    const entries = this.storeCallbacks.query(
      input.namespace as string, filter, (input.limit as number) || 100
    );
    if (entries.length === 0) return "No matching entries.";
    return entries.map(e => `${e.key}: ${JSON.stringify(e.value)}`).join("\n");
  }

  private execStoreInfo(input: Record<string, unknown>): string {
    if (!this.storeCallbacks) return "Data store not available.";
    const ns = input.namespace as string;
    if (!ns) {
      const namespaces = this.storeCallbacks.listNamespaces();
      return namespaces.length > 0 ? namespaces.join("\n") : "No data stores exist yet.";
    }
    return `Store "${ns}": ${this.storeCallbacks.count(ns)} entries.`;
  }
}
