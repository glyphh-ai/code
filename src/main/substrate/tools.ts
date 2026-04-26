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
    getSkill: (name: string) => { manifest: { description?: string; inputs?: Array<{ name: string; type: string; description?: string }> } } | null;
  };
  council?: { start: (opts: { participants: string[]; prompt: string; rounds: number }, log: (msg: string) => void) => Promise<{ status: string; rounds: number; participants: string[]; totalCaptures: number; responses: Map<string, string[]> }> };
  navigatorAgent?: { execute: (instruction: string, context: any) => Promise<{ summary: string }>; listPanels: () => string; setBudget?: (budget: any) => void };
  layoutAgent?: { execute: (instruction: string, context: any) => Promise<{ summary: string }>; setBudget?: (budget: any) => void };
  mcpRouter?: { resolveAll: () => Array<{ name: string; description: string; input_schema: Record<string, unknown> }>; callMcp?: (name: string, input: Record<string, unknown>) => Promise<string>; hasTool?: (name: string) => boolean; mcpCoveredApps?: () => Map<string, string[]> };
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
      const inputs = skill?.manifest.inputs ?? [];
      const props: Record<string, unknown> = {};
      const required: string[] = [];
      for (const i of inputs) {
        props[i.name] = { type: i.type === "string" ? "string" : i.type === "number" ? "number" : "string", description: i.description ?? "" };
        required.push(i.name);
      }
      // Default: single 'input' string param if no schema declared
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

  return out;
}

/**
 * Execute a tool by name. Routes to substrate, user skill, or MCP.
 * Returns the tool's text output.
 */
export async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  // 1. Substrate built-in?
  if (BUILTIN_BY_NAME.has(name)) {
    return BUILTIN_BY_NAME.get(name)!.run(input);
  }
  // 2. User skill via the skill_<name> convention?
  if (name.startsWith("skill_")) {
    const skillName = name.slice(6).replace(/_/g, "-");
    if (!deps.skillEngine) return "Skill engine not available.";
    try {
      const skillInput = "input" in input ? input.input : input;
      const out = await deps.skillEngine.runSkill(skillName, skillInput, { trigger: "skill" });
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
