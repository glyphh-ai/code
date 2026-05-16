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
import { webSearch, fetchPage } from "../web-search";
import { getWorkingDirectory } from "../working-directory";

// Privileged accessors injected by main.ts. Substrate tools use these;
// user-skill ctx never sees them.
export interface SubstrateToolDeps {
  captureStore?: { search: (q: string, n: number) => Promise<Array<{ meta: { id: string; source: string; created: number }; content: string; score: number }>> };
  sessionCache?: { get: () => string | null };
  noteStore?: { search: (q: string, n: number) => Promise<Array<{ file: string; title: string; content: string; rank: number }>>; write: (title: string, content: string, source?: string) => Promise<string> };
  memoryStore?: { save: (content: string, category: string) => Promise<string> };
  skillEngine?: {
    process: (content: string, skillName?: string) => Promise<string>;
    listSkillsDetailed: () => Array<{ name: string; description?: string; scheduled: boolean; scheduleExpr?: string; hasRunner?: boolean; hasApp?: boolean }>;
    getSkill: (name: string) => { manifest: Record<string, unknown>; prompt: string; folderPath: string } | null;
    writeSkill: (name: string, manifest: Record<string, unknown>, prompt: string) => boolean;
    deleteSkill: (name: string) => boolean;
    readSkillFile: (name: string, rel: string) => string | null;
    writeSkillFile: (name: string, rel: string, content: string) => boolean;
    listSkillFiles: (name: string) => string[];
    runSkill?: (name: string, input: unknown, opts?: { trigger?: "manual" | "schedule" | "skill" }) => Promise<unknown>;
    getRunHistory?: (name: string) => Array<{ id: string; trigger: string; startedAt: number; durationMs?: number; output?: unknown; error?: string; logs: string[]; events: Array<{ type: string; label: string; status: string }> }>;
    hasRunner?: (name: string) => boolean;
  };
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
  workspace?: {
    teamStatus: () => string;
    readLog: (filter: Record<string, unknown>) => string;
    postTo: (agent: string, body: string, kind?: string) => string;
    post: (body: string, tags?: string[], kind?: string) => string;
    readAgent: (name: string, kind?: string) => string;
    broadcastAndWait: (body: string, tags: string[], kind: string | undefined, timeoutMs: number) => Promise<string>;
  };
  panels?: {
    list: () => string;
    scan: (panelId: string) => Promise<string | null>;
    grab: (panelId: string) => Promise<string | null>;
    click: (panelId: string, text?: string, selector?: string) => Promise<string>;
    navigate: (panelId: string, url: string) => Promise<string>;
    type: (panelId: string, text: string, opts: { label?: string; placeholder?: string; selector?: string; clear?: boolean; submit?: boolean }) => Promise<string>;
    open: (url: string, panelId?: string) => Promise<string>;
    openBackground: (url: string, panelId?: string) => Promise<string>;
    runCommand: (panelId: string, command: string, value?: string) => Promise<string>;
    screenshot: (panelId: string) => Promise<string | null>;
    refresh: (panelId?: string) => Promise<string>;
  };
  tabs?: {
    list: () => Array<{ id: string; title: string; url?: string }>;
    switch: (id: string) => void;
    close: (id: string) => void;
    create: () => string;
  };
  execCommand?: (cmd: string) => Promise<string>;
  cypher?: {
    /** The cypher id the .yo is currently piloting (Drop's active Workspace). */
    getCurrent: () => string | null;
    /** Post a broadcast event to the bus. Returns text status. */
    post: (cypherId: string, text: string) => Promise<string>;
    /** Direct a message to a specific jammer by agent_local_id. */
    postTo: (cypherId: string, agentLocalId: string, text: string) => Promise<string>;
    /** Read the cypher's status: goal, roster, assignments, recent activity. */
    status: (cypherId: string) => Promise<string>;
    /** Wrap (close) the cypher. Host-only at the server. */
    wrap: (cypherId: string) => Promise<string>;
  };
  project?: {
    /** Get the project linked to the current cypher. */
    getForCypher: (cypherId: string) => Promise<string | null>;
    /** Create a project linked to the current cypher. */
    create: (cypherId: string, goal: string, linkedRepos: string[]) => Promise<string>;
    /** Read the project board — items with statuses. */
    board: (projectRef: string) => Promise<string>;
    /** Create a work item on the board. */
    createItem: (projectRef: string, title: string, body?: string, assignee?: string) => Promise<string>;
    /** Update an item's status (Backlog, InProgress, Review, Done). */
    updateItemStatus: (projectRef: string, itemId: string, status: string) => Promise<string>;
    /** Assign an item to a jammer. */
    assignItem: (projectRef: string, itemId: string, assigneeAgentId: string) => Promise<string>;
    /** Post a comment on an issue/item. */
    commentOnItem: (projectRef: string, itemId: string, body: string) => Promise<string>;
  };
  council?: {
    getCurrent: () => string | null;
    setCurrent: (id: string | null) => void;
    create: (config: {
      name: string;
      council_prompt: string;
      style: "chained" | "free_for_all" | "debate";
      round_cap: number;
      members: Array<{ provider: string; model: string; startup_prompt: string }>;
    }) => Promise<{ ok: boolean; council_id?: string; error?: string }>;
    runRound: (councilId: string) => Promise<{ ok: boolean; round?: number; error?: string }>;
    interject: (councilId: string, text: string) => { ok: boolean; error?: string };
    askMember: (councilId: string, memberId: string, question: string) => Promise<{ ok: boolean; text?: string; error?: string }>;
    stop: (councilId: string) => { ok: boolean; error?: string };
    summarize: (councilId: string) => Promise<{ ok: boolean; path?: string; text?: string; error?: string }>;
    status: (councilId: string) => string;
    listProviderModels: () => Promise<Array<{ provider: string; model: string; display_name: string }>>;
    openPanel: () => Promise<void>;
    setMode: (mode: string) => void;
    notifyReady: (info: { name: string; council_prompt: string; members: Array<{ provider: string; model: string }>; style: string; round_cap: number }) => void;
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
        return await deps.skillEngine.process(content, skill);
      } catch (err) {
        return `Skill error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },

  // ── Skill authoring (agent uses these to build user skills on demand) ──
  {
    name: "mcp_tools_list",
    namespace: "yo",
    description: "List every connected MCP tool with name, description, and a typed-key summary. Inputs are shown as 'key:type*' where * means required. ALWAYS call this before drafting a skill so allowed-tools and ctx.tools.call(...) reference real names. Use mcp_tool_schema for the full input schema of a specific tool.",
    input_schema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Filter to one MCP namespace (server id)" },
      },
    },
    async run(input) {
      if (!deps.mcpRouter?.resolveAll) return "MCP router not available.";
      const filter = (input.namespace as string | undefined)?.trim();
      const tools = deps.mcpRouter.resolveAll();
      const filtered = filter ? tools.filter(t => t.name.startsWith(filter + ".") || t.name.startsWith(filter + "_") || t.name.split(".")[0] === filter) : tools;
      if (filtered.length === 0) return filter ? `No tools found for namespace "${filter}".` : "No MCP tools connected.";
      const lines = filtered.map((t) => {
        const props = (t.input_schema?.properties || {}) as Record<string, { type?: string }>;
        const required = new Set((t.input_schema?.required || []) as string[]);
        const keys = Object.entries(props)
          .map(([k, v]) => `${k}:${v?.type || "any"}${required.has(k) ? "*" : ""}`)
          .join(", ");
        return `- ${t.name}${keys ? ` (${keys})` : ""}\n    ${t.description?.slice(0, 200) || ""}`;
      });
      return `${filtered.length} MCP tool(s) (* = required):\n\n${lines.join("\n")}`;
    },
  },
  {
    name: "mcp_tool_schema",
    namespace: "yo",
    description: "Return the complete JSON input schema for a single MCP tool, qualified as '<server>.<tool>' (e.g. 'gmail.gmail-find-email'). Use this BEFORE writing a ctx.tools.call(...) so you don't miss required fields like Pipedream's withTextPayload.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Qualified tool name '<server>.<tool>'" },
      },
      required: ["name"],
    },
    async run(input) {
      if (!deps.mcpRouter?.resolveAll) return "MCP router not available.";
      const target = (input.name as string)?.trim();
      if (!target || target.indexOf(".") < 1) {
        return "Invalid name. Use '<server>.<tool>' (e.g. 'gmail.gmail-find-email').";
      }
      const dot = target.indexOf(".");
      const ns = target.slice(0, dot);
      const toolName = target.slice(dot + 1);
      // resolveAll returns short names like "gmail__gmail_find_email" (hyphens
      // converted to underscores). Compare against the qualified pair from
      // mcpManager directly. We re-walk getAllTools because resolveAll
      // doesn't keep the raw schema mapping addressable by qualified name.
      const tools = deps.mcpRouter.resolveAll();
      const match = tools.find(t => {
        const short = `${ns.replace(/-/g, "_")}__${toolName.replace(/-/g, "_")}`;
        return t.name === short;
      });
      if (!match) return `Tool "${target}" not found. Run mcp_tools_list to see what's connected.`;
      return [
        `# ${target}`,
        ``,
        match.description || "(no description)",
        ``,
        `## input_schema`,
        "```json",
        JSON.stringify(match.input_schema, null, 2),
        "```",
      ].join("\n");
    },
  },
  {
    name: "skill_list",
    namespace: "yo",
    description: "List user skills (folder + SKILL.md + optional SKILL.js under ~/.claude/skills/). Returns name, description, hasRunner, schedule.",
    input_schema: { type: "object", properties: {} },
    async run() {
      if (!deps.skillEngine) return "Skill engine not available.";
      const skills = deps.skillEngine.listSkillsDetailed();
      if (skills.length === 0) return "No skills found in ~/.claude/skills/.";
      return skills.map(s => {
        const tags = [];
        if (s.hasRunner) tags.push("runner");
        if (s.scheduled) tags.push(`cron: ${s.scheduleExpr}`);
        const tagStr = tags.length ? ` [${tags.join(", ")}]` : "";
        return `- ${s.name}${tagStr}${s.description ? ` — ${s.description}` : ""}`;
      }).join("\n");
    },
  },
  {
    name: "skill_get",
    namespace: "yo",
    description: "Read a skill's SKILL.md (frontmatter + body) and SKILL.js (if present). Use to inspect or template off existing skills before editing.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill folder name" },
      },
      required: ["name"],
    },
    async run(input) {
      const name = input.name as string;
      if (!deps.skillEngine) return "Skill engine not available.";
      const s = deps.skillEngine.getSkill(name);
      if (!s) return `Skill "${name}" not found.`;
      const runnerCode = deps.skillEngine.readSkillFile(name, "SKILL.js");
      const out: string[] = [];
      out.push(`# Skill: ${name}`);
      out.push(`folder: ${s.folderPath}`);
      out.push(`hasRunner: ${!!runnerCode}`);
      out.push("");
      out.push("## SKILL.md");
      out.push("```yaml");
      out.push(JSON.stringify(s.manifest, null, 2));
      out.push("```");
      out.push("");
      out.push("### body");
      out.push(s.prompt || "(empty)");
      if (runnerCode) {
        out.push("");
        out.push("## SKILL.js");
        out.push("```js");
        out.push(runnerCode);
        out.push("```");
      }
      return out.join("\n");
    },
  },
  {
    name: "skill_create",
    namespace: "yo",
    description: "Create or replace a skill's SKILL.md (frontmatter + body). For SKILL.js use skill_write_runner. Frontmatter fields: description, allowed-tools (array of '<server>.<tool>'), schedule (cron, optional), when_to_use, model.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Folder name (alphanumeric, hyphens)" },
        manifest: {
          type: "object",
          description: "YAML frontmatter object: { description, when_to_use?, allowed-tools?, schedule?, model? }",
        },
        body: { type: "string", description: "Markdown body of SKILL.md (description, usage notes, examples)" },
      },
      required: ["name", "manifest", "body"],
    },
    async run(input) {
      const name = input.name as string;
      const manifest = input.manifest as Record<string, unknown>;
      const body = input.body as string;
      if (!deps.skillEngine) return "Skill engine not available.";
      const ok = deps.skillEngine.writeSkill(name, { name, ...manifest }, body || "");
      if (!ok) return `Failed to write skill "${name}". Bad name?`;
      return `Wrote ~/.claude/skills/${name}/SKILL.md`;
    },
  },
  {
    name: "skill_write_runner",
    namespace: "yo",
    description: "Write or replace a skill's SKILL.js (the deterministic runner). The code uses module.exports = { schedule?, init?, async start(ctx) {...}, exit? }. ctx surface: ctx.claude(prompt, {system,model}) → string, ctx.tools.call('server.tool', args) → string, ctx.step, ctx.evaluate, ctx.ask, ctx.progress, ctx.state, ctx.exit(value), ctx.log, ctx.config (frontmatter), ctx.file, ctx.library.{read,write}.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill folder name (must already exist)" },
        code: { type: "string", description: "Full JS content for SKILL.js" },
      },
      required: ["name", "code"],
    },
    async run(input) {
      const name = input.name as string;
      const code = input.code as string;
      if (!deps.skillEngine) return "Skill engine not available.";
      if (!deps.skillEngine.getSkill(name)) return `Skill "${name}" doesn't exist — call skill_create first.`;
      const ok = deps.skillEngine.writeSkillFile(name, "SKILL.js", code);
      return ok ? `Wrote ~/.claude/skills/${name}/SKILL.js (${code.length} chars)` : "Failed to write SKILL.js";
    },
  },
  {
    name: "skill_delete",
    namespace: "yo",
    description: "Delete a skill folder under ~/.claude/skills/. Destructive — confirm with the user before calling.",
    destructive: true,
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill folder name" },
      },
      required: ["name"],
    },
    async run(input) {
      const name = input.name as string;
      if (!deps.skillEngine) return "Skill engine not available.";
      const ok = deps.skillEngine.deleteSkill(name);
      return ok ? `Deleted skill "${name}".` : `Skill "${name}" not found or could not be removed.`;
    },
  },
  {
    name: "skill_run",
    namespace: "yo",
    description: "Execute a skill end-to-end (runner if SKILL.js exists, prompt-mode otherwise) and return the structured run output. Use after authoring/editing to verify it works before iterating.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name" },
        input: { description: "Optional input passed to the skill" },
      },
      required: ["name"],
    },
    async run(input) {
      const name = input.name as string;
      if (!deps.skillEngine?.runSkill) return "Skill engine runSkill not available.";
      try {
        const out = await deps.skillEngine.runSkill(name, input.input ?? null, { trigger: "manual" });
        return `Skill "${name}" ran. Output:\n${typeof out === "string" ? out : JSON.stringify(out, null, 2)}`;
      } catch (err) {
        return `Skill "${name}" errored: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },
  {
    name: "skill_run_history",
    namespace: "yo",
    description: "Read the last 10 runs of a skill — duration, output, error, logs, event tree. Use to debug failures and iterate on a skill.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name" },
      },
      required: ["name"],
    },
    async run(input) {
      const name = input.name as string;
      if (!deps.skillEngine?.getRunHistory) return "Run history not available.";
      const runs = deps.skillEngine.getRunHistory(name);
      if (runs.length === 0) return `No runs recorded for "${name}".`;
      return runs.map((r, i) => {
        const when = new Date(r.startedAt).toLocaleString();
        const status = r.error ? `ERROR: ${r.error}` : "ok";
        const events = r.events.length > 0 ? `\n  events: ${r.events.map(e => `${e.type}/${e.label}/${e.status}`).slice(0, 8).join(", ")}` : "";
        const logs = r.logs.length > 0 ? `\n  logs: ${r.logs.slice(0, 5).join(" | ")}` : "";
        const out = r.output !== undefined ? `\n  output: ${typeof r.output === "string" ? r.output.slice(0, 200) : JSON.stringify(r.output).slice(0, 200)}` : "";
        return `[${i + 1}] ${when} (${r.durationMs ?? "?"}ms, ${r.trigger}) — ${status}${events}${logs}${out}`;
      }).join("\n\n");
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
      const ok = deps.skillEngine.writeSkill(name, manifest, prompt);
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
      const ok = deps.skillEngine.writeSkill(name, manifest, prompt);
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
      ];
      const m = skill.manifest as Record<string, unknown>;
      if (m["allowed-tools"]) lines.push(`Allowed tools: ${(m["allowed-tools"] as string[]).join(", ")}`);
      if (m.requires) lines.push(`Requires: ${(m.requires as string[]).join(", ")}`);
      if (m.schedule) lines.push(`Schedule: ${m.schedule}`);
      if (m.inputs) lines.push(`Inputs: ${JSON.stringify(m.inputs)}`);
      lines.push("", "--- PROMPT ---", skill.prompt);
      const files = deps.skillEngine.listSkillFiles(name);
      const extraFiles = files.filter(f => f !== "SKILL.md");
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
  // ── Data store tools ──────────────────────────────────────
  {
    name: "store_set",
    namespace: "yo",
    description: "Store a value in a namespaced key-value store. Values are JSON — store objects, arrays, strings, numbers, etc.",
    input_schema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "Store namespace (e.g. skill name, or any logical group)" },
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
      // Default to the app-wide working directory so the yo agent's shell
      // commands run where the .Yo Editor / cypher repo lives — falling back
      // to ~ only when no working directory is set.
      const base = getWorkingDirectory() || os.homedir();
      let cwd = (input.cwd as string) || base;
      if (!path.isAbsolute(cwd)) cwd = path.join(base, cwd);
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
  // ── Panel interaction tools ──────────────────────────────
  {
    name: "list_panels",
    namespace: "yo",
    description: "List all available workspace panels with IDs and URLs.",
    input_schema: { type: "object", properties: {} },
    async run() {
      if (!deps.panels) return "Panel system not available.";
      return deps.panels.list();
    },
  },
  {
    name: "scan_panel",
    namespace: "yo",
    description: "Fast DOM scan of a panel — returns actionable elements (inputs, buttons, links, content areas). Use this FIRST for element discovery before click/type.",
    input_schema: {
      type: "object",
      properties: { panel_id: { type: "string", description: "Panel ID to scan" } },
      required: ["panel_id"],
    },
    async run(input) {
      if (!deps.panels) return "Panel system not available.";
      const scan = await deps.panels.scan(input.panel_id as string);
      if (!scan) return `Could not scan panel: ${input.panel_id}`;
      return scan.length > 4000 ? scan.slice(0, 4000) + "\n[scan truncated]" : scan;
    },
  },
  {
    name: "grab_panel",
    namespace: "yo",
    description: "Grab full visible text content from a panel. EXPENSIVE (~10K tokens). Use scan_panel first for element discovery.",
    input_schema: {
      type: "object",
      properties: { panel_id: { type: "string", description: "Panel ID to grab content from" } },
      required: ["panel_id"],
    },
    async run(input) {
      if (!deps.panels) return "Panel system not available.";
      const content = await deps.panels.grab(input.panel_id as string);
      if (!content) return `Could not grab content from panel: ${input.panel_id}`;
      return content.length > 4000 ? content.slice(0, 4000) + "\n[content truncated]" : content;
    },
  },
  {
    name: "click_element",
    namespace: "yo",
    description: "Click an element in a panel by visible text or CSS selector.",
    input_schema: {
      type: "object",
      properties: {
        panel_id: { type: "string", description: "Panel ID" },
        text: { type: "string", description: "Visible text to click" },
        selector: { type: "string", description: "CSS selector to click" },
      },
      required: ["panel_id"],
    },
    async run(input) {
      if (!deps.panels) return "Panel system not available.";
      const text = input.text as string | undefined;
      const selector = input.selector as string | undefined;
      if (!text && !selector) return "Provide either text or selector to click.";
      return deps.panels.click(input.panel_id as string, text, selector);
    },
  },
  {
    name: "navigate_panel",
    namespace: "yo",
    description: "Navigate an existing panel to a specific URL.",
    input_schema: {
      type: "object",
      properties: {
        panel_id: { type: "string", description: "Panel ID" },
        url: { type: "string", description: "URL to navigate to" },
      },
      required: ["panel_id", "url"],
    },
    async run(input) {
      if (!deps.panels) return "Panel system not available.";
      return deps.panels.navigate(input.panel_id as string, input.url as string);
    },
  },
  {
    name: "type_text",
    namespace: "yo",
    description: "Type text into an input field in a panel. Use submit=true for Enter.",
    input_schema: {
      type: "object",
      properties: {
        panel_id: { type: "string", description: "Panel ID" },
        text: { type: "string", description: "Text to type" },
        label: { type: "string", description: "Input label to target" },
        placeholder: { type: "string", description: "Input placeholder to target" },
        selector: { type: "string", description: "CSS selector of the input" },
        clear: { type: "boolean", description: "Clear existing text first" },
        submit: { type: "boolean", description: "Press Enter after typing" },
      },
      required: ["panel_id", "text"],
    },
    async run(input) {
      if (!deps.panels) return "Panel system not available.";
      return deps.panels.type(input.panel_id as string, input.text as string, {
        label: input.label as string | undefined,
        placeholder: input.placeholder as string | undefined,
        selector: input.selector as string | undefined,
        clear: input.clear as boolean | undefined,
        submit: input.submit as boolean | undefined,
      });
    },
  },
  {
    name: "open_panel",
    namespace: "yo",
    description: "Open a NEW app panel by URL. Only use for apps not already in list_panels.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to open" },
        panel_id: { type: "string", description: "Optional panel ID to assign" },
      },
      required: ["url"],
    },
    async run(input) {
      if (!deps.panels) return "Panel system not available.";
      return deps.panels.open(input.url as string, input.panel_id as string | undefined);
    },
  },
  {
    name: "run_panel_command",
    namespace: "yo",
    description: "Execute a pre-mapped app command (grab, input, submit, new, search, read-latest). Faster than manual click/type.",
    input_schema: {
      type: "object",
      properties: {
        panel_id: { type: "string", description: "Panel ID" },
        command: { type: "string", description: "Command name" },
        value: { type: "string", description: "Optional value for the command" },
      },
      required: ["panel_id", "command"],
    },
    async run(input) {
      if (!deps.panels) return "Panel system not available.";
      return deps.panels.runCommand(input.panel_id as string, input.command as string, input.value as string | undefined);
    },
  },
  {
    name: "refresh_panel",
    namespace: "yo",
    description: "Reload a panel's page.",
    input_schema: {
      type: "object",
      properties: { panel_id: { type: "string", description: "Panel ID (omit for active panel)" } },
    },
    async run(input) {
      if (!deps.panels) return "Panel system not available.";
      return deps.panels.refresh(input.panel_id as string | undefined);
    },
  },
  {
    name: "manage_tabs",
    namespace: "yo",
    description: "Manage workspace tabs: list, switch, close, create new.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "switch", "close", "new"], description: "Tab action" },
        tab_id: { type: "string", description: "Tab ID (for switch/close)" },
      },
      required: ["action"],
    },
    async run(input) {
      if (!deps.tabs) return "Tab management not available.";
      const action = input.action as string;
      switch (action) {
        case "list": {
          const tabs = deps.tabs.list();
          if (tabs.length === 0) return "No tabs open.";
          return tabs.map((t) => `${t.id} — ${t.title}${t.url ? ` (${t.url})` : ""}`).join("\n");
        }
        case "switch": {
          const id = input.tab_id as string;
          if (!id) return "Provide tab_id to switch to.";
          deps.tabs.switch(id);
          return `Switched to tab: ${id}`;
        }
        case "close": {
          const id = input.tab_id as string;
          if (!id) return "Provide tab_id to close.";
          deps.tabs.close(id);
          return `Closed tab: ${id}`;
        }
        case "new": {
          const id = deps.tabs.create();
          return `Created new tab: ${id}`;
        }
        default: return `Unknown tab action: ${action}`;
      }
    },
  },
  // ── Layout tools ──────────────────────────────────────────
  {
    name: "switch_panel",
    namespace: "yo",
    description: "Switch to a single panel fullscreen.",
    input_schema: {
      type: "object",
      properties: { panel_id: { type: "string", description: "Panel ID to switch to" } },
      required: ["panel_id"],
    },
    async run(input) {
      if (!deps.execCommand) return "Command runner not available.";
      return deps.execCommand(`dip ${input.panel_id}`);
    },
  },
  {
    name: "split_view",
    namespace: "yo",
    description: "Create split view with 2+ panels side by side. Use / for rows.",
    input_schema: {
      type: "object",
      properties: { panels: { type: "string", description: "Panel IDs space-separated, / for row break (e.g. 'gmail slack / claude')" } },
      required: ["panels"],
    },
    async run(input) {
      if (!deps.execCommand) return "Command runner not available.";
      return deps.execCommand(`dip split ${input.panels}`);
    },
  },
  {
    name: "grid_layout",
    namespace: "yo",
    description: "Create grid layout with optional col/row sizes and spans.",
    input_schema: {
      type: "object",
      properties: {
        panels: { type: "string", description: "Panel cells (e.g. 'gmail:2x1 slack claude')" },
        col_widths: { type: "string", description: "Column widths (e.g. '2,1,1')" },
        row_heights: { type: "string", description: "Row heights (e.g. '1,2')" },
      },
      required: ["panels"],
    },
    async run(input) {
      if (!deps.execCommand) return "Command runner not available.";
      let cmd = "dip grid";
      if (input.col_widths) cmd += ` [${input.col_widths}]`;
      if (input.row_heights) cmd += ` [${input.row_heights}]`;
      cmd += ` ${input.panels}`;
      return deps.execCommand(cmd);
    },
  },
  {
    name: "apply_saved_layout",
    namespace: "yo",
    description: "Apply a previously saved layout by name.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string", description: "Layout name" } },
      required: ["name"],
    },
    async run(input) {
      if (!deps.execCommand) return "Command runner not available.";
      return deps.execCommand(`dip ${input.name}`);
    },
  },
  {
    name: "save_current_layout",
    namespace: "yo",
    description: "Save current panel arrangement as a named layout.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string", description: "Layout name to save as" } },
      required: ["name"],
    },
    async run(input) {
      if (!deps.execCommand) return "Command runner not available.";
      return deps.execCommand(`dip save ${input.name}`);
    },
  },
  {
    name: "web_search",
    namespace: "yo",
    description: "Search the web via DuckDuckGo. Returns titles, URLs, and snippets. Use this to find current information, news, documentation, or any web content. Chain with web_read to get full page content from specific results.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results (default 8, max 20)" },
      },
      required: ["query"],
    },
    async run(input) {
      const query = input.query as string;
      if (!query) return "No query provided.";
      const limit = Math.min((input.limit as number) || 8, 20);
      try {
        const results = await webSearch(query, limit);
        if (results.length === 0) return "No results found.";
        return results.map((r, i) =>
          `[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.snippet}`
        ).join("\n\n");
      } catch (err) {
        return `Search failed: ${err instanceof Error ? err.message : err}`;
      }
    },
  },
  {
    name: "web_read",
    namespace: "yo",
    description: "Fetch a web page and extract its text content. Strips navigation, scripts, and ads — returns the readable body text. Use after web_search to read specific pages, or directly with a known URL.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full URL to fetch (https://...)" },
        max_length: { type: "number", description: "Max characters to return (default 8000)" },
      },
      required: ["url"],
    },
    async run(input) {
      const url = input.url as string;
      if (!url) return "No URL provided.";
      if (!url.startsWith("http://") && !url.startsWith("https://")) return "URL must start with http:// or https://";
      const maxChars = Math.min((input.max_length as number) || 8000, 30000);
      try {
        const content = await fetchPage(url, maxChars);
        if (!content.trim()) return "Page returned no readable content.";
        return `Source: ${url}\n\n${content}`;
      } catch (err) {
        return `Fetch failed: ${err instanceof Error ? err.message : err}`;
      }
    },
  },
  // ── Workspace tools (code mode) ─────────────────────────────
  {
    name: "ws_team_status",
    namespace: "yo",
    description: "List all agents in the active workspace with roles and last-post timestamps.",
    input_schema: { type: "object", properties: {} },
    run: async () => {
      if (!deps.workspace) return "Workspace not available. Is MCP running?";
      return deps.workspace.teamStatus();
    },
  },
  {
    name: "ws_read_log",
    namespace: "yo",
    description: "Read workspace event log. Filter by tags, sender, kind, or time range.",
    input_schema: {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" }, description: "Filter by tags" },
        from: { type: "array", items: { type: "string" }, description: "Filter by sender agent names" },
        to: { type: "string", description: "Filter events addressed to this agent" },
        since: { type: "number", description: "Events after this timestamp (ms)" },
        kinds: { type: "array", items: { type: "string" }, description: "Filter by event kind" },
        limit: { type: "number", description: "Max events to return" },
      },
    },
    run: async (input) => {
      if (!deps.workspace) return "Workspace not available. Is MCP running?";
      return deps.workspace.readLog(input);
    },
  },
  {
    name: "ws_post_to",
    namespace: "yo",
    description: "Send a direct message to a specific agent in the workspace.",
    input_schema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Target agent name" },
        body: { type: "string", description: "Message body" },
        kind: { type: "string", enum: ["post", "status", "question", "answer", "artifact"], description: "Message kind" },
      },
      required: ["agent", "body"],
    },
    destructive: true,
    run: async (input) => {
      if (!deps.workspace) return "Workspace not available. Is MCP running?";
      return deps.workspace.postTo(String(input.agent), String(input.body), input.kind as string | undefined);
    },
  },
  {
    name: "ws_broadcast",
    namespace: "yo",
    description: "Broadcast a message to all agents in the workspace.",
    input_schema: {
      type: "object",
      properties: {
        body: { type: "string", description: "Message body" },
        tags: { type: "array", items: { type: "string" }, description: "Additional tags" },
        kind: { type: "string", enum: ["post", "status", "question", "answer", "artifact"], description: "Message kind" },
      },
      required: ["body"],
    },
    destructive: true,
    run: async (input) => {
      if (!deps.workspace) return "Workspace not available. Is MCP running?";
      const tags = (input.tags as string[] || []).concat(["broadcast"]);
      return deps.workspace.post(String(input.body), tags, input.kind as string | undefined);
    },
  },
  {
    name: "ws_request",
    namespace: "yo",
    description: "Broadcast a message and wait for agent responses. Returns all responses received within the timeout.",
    input_schema: {
      type: "object",
      properties: {
        body: { type: "string", description: "Message body to broadcast" },
        tags: { type: "array", items: { type: "string" }, description: "Additional tags" },
        kind: { type: "string", enum: ["post", "status", "question", "answer", "artifact"], description: "Message kind (default: question)" },
        timeout: { type: "number", description: "Max seconds to wait for responses (default: 30, max: 120)" },
      },
      required: ["body"],
    },
    destructive: true,
    run: async (input) => {
      if (!deps.workspace) return "Workspace not available. Is MCP running?";
      if (!deps.workspace.broadcastAndWait) return "broadcastAndWait not available.";
      const timeoutSec = Math.min(Math.max(Number(input.timeout) || 30, 5), 120);
      const tags = (input.tags as string[] || []).concat(["broadcast"]);
      const kind = (input.kind as string) || "question";
      return deps.workspace.broadcastAndWait(String(input.body), tags, kind, timeoutSec * 1000);
    },
  },
  {
    name: "ws_read_agent",
    namespace: "yo",
    description: "Read another agent's scratchpad or post history.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Agent name" },
        kind: { type: "string", enum: ["scratchpad", "log"], description: "What to read (default: scratchpad)" },
      },
      required: ["name"],
    },
    run: async (input) => {
      if (!deps.workspace) return "Workspace not available. Is MCP running?";
      return deps.workspace.readAgent(String(input.name), input.kind as string | undefined);
    },
  },

  // ── Cypher driver tools — only meaningful when a cypher is "current"
  // (the user is in The Drop's Workspace view). When no cypher is active
  // these return a friendly error rather than failing.
  {
    name: "cypher_post",
    namespace: "yo",
    description: "Broadcast a message to all jammers in the current cypher's bus. Use for status updates, decisions, or open prompts the team should react to.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Message body" },
      },
      required: ["text"],
    },
    run: async (input) => {
      if (!deps.cypher) return "Cypher driver not wired.";
      const id = deps.cypher.getCurrent();
      if (!id) return "No cypher is active. Open a cypher in The Drop's Workspace first.";
      return deps.cypher.post(id, String(input.text));
    },
  },
  {
    name: "cypher_post_to",
    namespace: "yo",
    description: "Direct-message a specific jammer in the current cypher by their agent id. Use to assign work or ask a focused question.",
    input_schema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "The jammer's agent_local_id" },
        text: { type: "string", description: "Message body" },
      },
      required: ["agent_id", "text"],
    },
    run: async (input) => {
      if (!deps.cypher) return "Cypher driver not wired.";
      const id = deps.cypher.getCurrent();
      if (!id) return "No cypher is active.";
      return deps.cypher.postTo(id, String(input.agent_id), String(input.text));
    },
  },
  {
    name: "cypher_status",
    namespace: "yo",
    description: "Read the current cypher's goal, roster, draft assignments, and recent activity. Always call this first to orient before posting work.",
    input_schema: { type: "object", properties: {} },
    run: async () => {
      if (!deps.cypher) return "Cypher driver not wired.";
      const id = deps.cypher.getCurrent();
      if (!id) return "No cypher is active.";
      return deps.cypher.status(id);
    },
  },
  {
    name: "cypher_wrap",
    namespace: "yo",
    description: "Close the current cypher. Match ends, performance is recorded, jammers terminate. Host-only at the server.",
    input_schema: { type: "object", properties: {} },
    destructive: true,
    run: async () => {
      if (!deps.cypher) return "Cypher driver not wired.";
      const id = deps.cypher.getCurrent();
      if (!id) return "No cypher is active.";
      return deps.cypher.wrap(id);
    },
  },

  // ── Project board tools — track state via GitHub-backed project items
  {
    name: "project_board",
    namespace: "yo",
    description: "Read the project board for the current cypher. Shows all items with their status (Backlog, InProgress, Review, Done) and assignees. Call this to understand what's been assigned and where things stand.",
    input_schema: { type: "object", properties: {} },
    run: async () => {
      if (!deps.project || !deps.cypher) return "Project tools not wired.";
      const cypherId = deps.cypher.getCurrent();
      if (!cypherId) return "No cypher is active.";
      const ref = await deps.project.getForCypher(cypherId);
      if (!ref) return "No project linked to this cypher yet. Use project_create to set one up.";
      return deps.project.board(ref);
    },
  },
  {
    name: "project_create",
    namespace: "yo",
    description: "Create a project board for the current cypher. Call this at cypher start to set up the tracking layer. Provide the goal and any linked GitHub repos.",
    input_schema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "Project goal (from cypher goal)" },
        repos: { type: "array", items: { type: "string" }, description: "Linked repo full names (owner/repo)" },
      },
      required: ["goal"],
    },
    run: async (input) => {
      if (!deps.project || !deps.cypher) return "Project tools not wired.";
      const cypherId = deps.cypher.getCurrent();
      if (!cypherId) return "No cypher is active.";
      return deps.project.create(cypherId, String(input.goal), (input.repos as string[]) || []);
    },
  },
  {
    name: "project_add_item",
    namespace: "yo",
    description: "Add a work item to the project board. Use to break down the goal into discrete tasks. Optionally assign to a jammer agent_id immediately.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short task title" },
        body: { type: "string", description: "Details, acceptance criteria" },
        assignee: { type: "string", description: "agent_local_id to assign, or omit for unassigned" },
      },
      required: ["title"],
    },
    run: async (input) => {
      if (!deps.project || !deps.cypher) return "Project tools not wired.";
      const cypherId = deps.cypher.getCurrent();
      if (!cypherId) return "No cypher is active.";
      const ref = await deps.project.getForCypher(cypherId);
      if (!ref) return "No project exists yet. Call project_create first.";
      return deps.project.createItem(ref, String(input.title), input.body as string | undefined, input.assignee as string | undefined);
    },
  },
  {
    name: "project_update_status",
    namespace: "yo",
    description: "Move a project item to a new status column. Statuses: Backlog, InProgress, Review, Done.",
    input_schema: {
      type: "object",
      properties: {
        item_id: { type: "string", description: "The item ID" },
        status: { type: "string", enum: ["Backlog", "InProgress", "Review", "Done"], description: "New status" },
      },
      required: ["item_id", "status"],
    },
    run: async (input) => {
      if (!deps.project || !deps.cypher) return "Project tools not wired.";
      const cypherId = deps.cypher.getCurrent();
      if (!cypherId) return "No cypher is active.";
      const ref = await deps.project.getForCypher(cypherId);
      if (!ref) return "No project exists.";
      return deps.project.updateItemStatus(ref, String(input.item_id), String(input.status));
    },
  },
  {
    name: "project_assign",
    namespace: "yo",
    description: "Assign a project item to a jammer. The jammer will receive the task via the cypher bus.",
    input_schema: {
      type: "object",
      properties: {
        item_id: { type: "string", description: "The item ID" },
        agent_id: { type: "string", description: "The jammer's agent_local_id" },
      },
      required: ["item_id", "agent_id"],
    },
    run: async (input) => {
      if (!deps.project || !deps.cypher) return "Project tools not wired.";
      const cypherId = deps.cypher.getCurrent();
      if (!cypherId) return "No cypher is active.";
      const ref = await deps.project.getForCypher(cypherId);
      if (!ref) return "No project exists.";
      return deps.project.assignItem(ref, String(input.item_id), String(input.agent_id));
    },
  },
  {
    name: "project_comment",
    namespace: "yo",
    description: "Post a comment on a project item (GitHub issue). Use to log progress, ask questions, or document decisions on a task.",
    input_schema: {
      type: "object",
      properties: {
        item_id: { type: "string", description: "The item/issue ID or number" },
        body: { type: "string", description: "Comment body (markdown supported)" },
      },
      required: ["item_id", "body"],
    },
    run: async (input) => {
      if (!deps.project || !deps.cypher) return "Project tools not wired.";
      const cypherId = deps.cypher.getCurrent();
      if (!cypherId) return "No cypher is active.";
      const ref = await deps.project.getForCypher(cypherId);
      if (!ref) return "No project exists.";
      return deps.project.commentOnItem(ref, String(input.item_id), String(input.body));
    },
  },

  // ── Council tools ─────────────────────────────────────────
  // The .yo moderates a multi-LLM debate. council_create spins up a session
  // (called when the user says "create a council with X, Y, Z to debate Q").
  // council_broadcast runs the next round; council_interject inserts a moderator
  // note; council_stop halts in-flight; council_summarize finalizes + writes
  // the summary to the user's note store; council_status returns text.
  {
    name: "council_create",
    namespace: "yo",
    description: "Create a council — a multi-LLM debate session. Use when the user asks to convene a council, debate, or have models argue a topic. Members are { provider, model, startup_prompt }. Style: chained (sequential, see prior) | free_for_all (parallel) | debate (structured back-and-forth). Round cap defaults to 3. After creation, the council is set as current; ask the user whether to broadcast round 1 unless they explicitly said to start.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short title for the council, e.g. \"Postgres vs Mongo\"" },
        council_prompt: { type: "string", description: "The question or topic the council debates" },
        style: { type: "string", enum: ["chained", "free_for_all", "debate"], description: "Debate style. Default: chained." },
        round_cap: { type: "number", description: "Maximum rounds before manual extension required. Default 3." },
        members: {
          type: "array",
          description: "List of council members. Each: { provider, model, startup_prompt }. Need 2-10.",
          items: {
            type: "object",
            properties: {
              provider: { type: "string", description: "anthropic | openai | google | xai | perplexity" },
              model: { type: "string", description: "Provider-specific model id, e.g. claude-sonnet-4-6, gpt-5, gemini-2.5-pro" },
              startup_prompt: { type: "string", description: "System prompt for this member (their persona / stance)" },
            },
            required: ["provider", "model", "startup_prompt"],
          },
        },
      },
      required: ["name", "council_prompt", "members"],
    },
    run: async (input) => {
      if (!deps.council) return "Council driver not wired.";
      const config = {
        name: String(input.name),
        council_prompt: String(input.council_prompt),
        style: ((input.style as string) || "chained") as "chained" | "free_for_all" | "debate",
        round_cap: typeof input.round_cap === "number" ? input.round_cap : 3,
        members: (input.members as Array<{ provider: string; model: string; startup_prompt: string }>),
      };
      const r = await deps.council.create(config);
      if (!r.ok || !r.council_id) return `Council create failed: ${r.error ?? "unknown"}`;
      deps.council.setCurrent(r.council_id);
      await deps.council.openPanel();
      deps.council.setMode("council");
      deps.council.notifyReady({
        name: config.name,
        council_prompt: config.council_prompt,
        members: config.members.map((m) => ({ provider: m.provider, model: m.model })),
        style: config.style,
        round_cap: config.round_cap,
      });
      return `Council "${config.name}" created. Panel opened, council mode active, user has been shown the welcome prompt. Wait for the user to say "go" or give other instructions.`;
    },
  },
  {
    name: "council_broadcast",
    namespace: "yo",
    description: "Run the next council round. Each member responds per the council's style. Use when the user says \"go\", \"start\", \"next round\", \"continue\", or similar. Refuses if the round cap is reached.",
    input_schema: { type: "object", properties: {} },
    run: async () => {
      if (!deps.council) return "Council driver not wired.";
      const id = deps.council.getCurrent();
      if (!id) return "No council is active. Create one first with council_create.";
      const r = await deps.council.runRound(id);
      if (!r.ok) return `Round failed: ${r.error}`;
      return `Round ${r.round} ran.`;
    },
  },
  {
    name: "council_interject",
    namespace: "yo",
    description: "Insert a moderator note into the current council. Members will see it as guidance on the next round. Use when the user wants to redirect the debate, add a constraint, or correct a misunderstanding.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Moderator message body" },
      },
      required: ["text"],
    },
    run: async (input) => {
      if (!deps.council) return "Council driver not wired.";
      const id = deps.council.getCurrent();
      if (!id) return "No council is active.";
      const r = deps.council.interject(id, String(input.text));
      return r.ok ? "Moderator note queued for next round." : `Failed: ${r.error}`;
    },
  },
  {
    name: "council_ask_member",
    namespace: "yo",
    description: "Send a targeted question to a specific council member and get an immediate response. Use when the user wants to drill into one member's position, clarify a point, or ask a follow-up to a specific model — without running a full round. The member sees recent transcript context plus your question.",
    input_schema: {
      type: "object",
      properties: {
        member_id: { type: "string", description: "The member's id (e.g. \"anthropic/claude-sonnet-4-6\" or custom id). Use council_status to see member ids." },
        question: { type: "string", description: "The question or prompt to send to this specific member" },
      },
      required: ["member_id", "question"],
    },
    run: async (input) => {
      if (!deps.council) return "Council driver not wired.";
      const id = deps.council.getCurrent();
      if (!id) return "No council is active.";
      const r = await deps.council.askMember(id, String(input.member_id), String(input.question));
      if (!r.ok) return `Ask failed: ${r.error}`;
      return `[${input.member_id}]: ${r.text}`;
    },
  },
  {
    name: "council_stop",
    namespace: "yo",
    description: "Halt all in-flight council members immediately. Use when the user says \"stop\", \"pause\", \"halt\", or wants to interrupt a runaway round. After stopping, you can summarize, interject, or call broadcast again to resume.",
    input_schema: { type: "object", properties: {} },
    destructive: true,
    run: async () => {
      if (!deps.council) return "Council driver not wired.";
      const id = deps.council.getCurrent();
      if (!id) return "No council is active.";
      const r = deps.council.stop(id);
      return r.ok ? "Council stopped." : `Failed: ${r.error}`;
    },
  },
  {
    name: "council_status",
    namespace: "yo",
    description: "Read the current council's state: question, members, style, current round, recent turn snippets. Always call this first to orient before broadcasting or interjecting.",
    input_schema: { type: "object", properties: {} },
    run: async () => {
      if (!deps.council) return "Council driver not wired.";
      const id = deps.council.getCurrent();
      if (!id) return "No council is active.";
      return deps.council.status(id);
    },
  },
  {
    name: "council_summarize",
    namespace: "yo",
    description: "Produce a structured summary of the council debate and save it to ~/yo/notes/council/<name>.md so you can reference the conclusions in future turns. Use when the user says \"summarize\", \"wrap up\", or has heard enough rounds. Returns the path of the saved note.",
    input_schema: { type: "object", properties: {} },
    run: async () => {
      if (!deps.council) return "Council driver not wired.";
      const id = deps.council.getCurrent();
      if (!id) return "No council is active.";
      const r = await deps.council.summarize(id);
      if (!r.ok) return `Summarize failed: ${r.error}`;
      return `Saved summary to ${r.path}.\n\n${r.text}`;
    },
  },
  {
    name: "council_list_models",
    namespace: "yo",
    description: "List available providers and models for council members. Use when the user asks to create a council and you need to map their loose names (\"Gemini\", \"Grok\", \"Claude\") to canonical (provider, model) tuples.",
    input_schema: { type: "object", properties: {} },
    run: async () => {
      if (!deps.council) return "Council driver not wired.";
      const models = await deps.council.listProviderModels();
      if (models.length === 0) return "No models available.";
      const grouped = new Map<string, Array<{ model: string; display_name: string }>>();
      for (const m of models) {
        if (!grouped.has(m.provider)) grouped.set(m.provider, []);
        grouped.get(m.provider)!.push({ model: m.model, display_name: m.display_name });
      }
      const lines: string[] = ["Available models:"];
      for (const [provider, list] of grouped) {
        lines.push(`  ${provider}:`);
        for (const m of list) lines.push(`    - ${m.model} (${m.display_name})`);
      }
      return lines.join("\n");
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
 *
 * Path-gate: every tool call is checked against the .yo trust boundary
 * (~/.yo/). Calls that resolve to paths outside this boundary are rejected
 * before execution. Cypher-scoped jammers run with a tighter boundary;
 * that's wired separately at the agent-runner layer (v2).
 *
 * Cypher-internal tools (cypher_post, cypher_post_to, etc.) are exempt —
 * they don't touch the filesystem, only the cypher bus.
 */
const PATH_GATE_EXEMPT = new Set([
  "cypher_post", "cypher_post_to", "cypher_status", "cypher_wrap",
  "council_create", "council_broadcast", "council_interject", "council_stop",
  "council_status", "council_summarize", "council_list_models",
  "search_captures", "search_notes", "store_get", "store_set", "store_list", "store_query",
  // Skill-authoring tools — take a `name` not a path; SkillEngine.sanitizeName
  // already constrains the folder, and skill folders live under ~/.claude/skills
  // (outside the ~/.yo/ trust boundary the gate enforces by default).
  "mcp_tools_list", "mcp_tool_schema", "skill_list", "skill_get", "skill_create",
  "skill_write_runner", "skill_delete", "skill_run", "skill_run_history",
]);

export async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  // Path-gate: reject anything resolving outside ~/.yo/ unless the tool is
  // explicitly exempt (bus tools, semantic search, etc.).
  if (!PATH_GATE_EXEMPT.has(name)) {
    const { checkToolCall } = await import("./path-gate.js");
    // The solo yo agent may also operate on the app-wide working directory —
    // that's the folder the user pointed it at (.Yo Editor / project repo).
    const wd = getWorkingDirectory();
    const violation = checkToolCall(input, wd ? { extraRoots: [wd] } : {});
    if (violation) {
      return `Refused: ${violation}.`;
    }
  }

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
      const content = "input" in input ? String(input.input) : JSON.stringify(input);
      return await deps.skillEngine.process(content, skillName);
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
