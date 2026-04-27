/**
 * SkillRunner — loads SKILL.js and executes the lifecycle (init/start/end/exit).
 *
 * Runs via Node's vm module with a CommonJS shim so skills can use either
 * `module.exports = { ... }` or `exports.init = ...` style.
 *
 * Provides the `ctx` object with:
 *   - core: input, state, history, log, signal, exit
 *   - reasoning: agent.ask, skill, format
 *   - resources: file, library
 *   - flow: evaluate, retry, back, ask.user, ui.progress, step
 */

import fs from "fs";
import path from "path";
import vm from "vm";
import crypto from "crypto";

import { SkillEngine } from "./skill-engine";
import { SkillToolRouter, ResolvedTool } from "./skill-tool-router";
import { evaluateLLM, evaluateDeterministic, EvaluateOpts, EvaluateResult } from "./skill-evaluator";
import { McpManager } from "./mcp-manager";
import { LLMConfig, createCompletion } from "./llm-config";
import {
  ProgressEvent,
  ProgressEventType,
  RunOpts,
  SkillRun,
  SkillNotAllowedError,
  SkillError,
} from "./skill-types";
import {
  inhale as substrateInhale,
  exhale as substrateExhale,
  reflex as substrateReflex,
  BudgetTracker,
  cancelable as substrateCancelable,
  Intent,
} from "./substrate";

// Module-level registry so the engine and runner share dependencies
let globalToolRouter: SkillToolRouter | null = null;
let globalMcpManager: McpManager | null = null;
let globalSubstrateBudgetOpts: { maxTokens?: number; maxToolCalls?: number; maxDepth?: number; maxDepthMs?: number } | null = null;
export function setSubstrateBudgetOpts(o: typeof globalSubstrateBudgetOpts): void {
  globalSubstrateBudgetOpts = o;
}
let globalLibraryRead: ((name: string) => string | null) | null = null;
let globalLibraryWrite: ((name: string, content: string) => boolean) | null = null;
let globalDataStore: {
  get: (namespace: string, key: string) => unknown | null;
  set: (namespace: string, key: string, value: unknown) => void;
  delete: (namespace: string, key: string) => boolean;
  list: (namespace: string, prefix?: string, limit?: number) => Array<{ key: string; value: unknown; updatedAt: number }>;
  query: (namespace: string, filter: Record<string, unknown>, limit?: number) => Array<{ key: string; value: unknown; updatedAt: number }>;
  keys: (namespace: string) => string[];
  count: (namespace: string) => number;
  clear: (namespace: string) => number;
} | null = null;

export function setRunnerDependencies(deps: {
  toolRouter?: SkillToolRouter;
  mcpManager?: McpManager;
  libraryRead?: (name: string) => string | null;
  libraryWrite?: (name: string, content: string) => boolean;
  dataStore?: typeof globalDataStore;
}): void {
  if (deps.toolRouter) globalToolRouter = deps.toolRouter;
  if (deps.mcpManager) globalMcpManager = deps.mcpManager;
  if (deps.libraryRead) globalLibraryRead = deps.libraryRead;
  if (deps.libraryWrite) globalLibraryWrite = deps.libraryWrite;
  if (deps.dataStore) globalDataStore = deps.dataStore;
}

// ── Sentinel for ctx.exit ────────────────────────────────

class EarlyExit {
  constructor(public value: unknown) {}
}

// ── Progress event helpers ──────────────────────────────

function makeId(): string { return crypto.randomBytes(6).toString("hex"); }

interface ProgressEmitter {
  emit(event: ProgressEvent): void;
  allEvents(): ProgressEvent[];
}

function createEmitter(onProgress?: (e: ProgressEvent) => void): ProgressEmitter {
  const all: ProgressEvent[] = [];
  return {
    emit(event) {
      all.push(event);
      onProgress?.(event);
    },
    allEvents() { return all; },
  };
}

function startEvent(
  emitter: ProgressEmitter,
  type: ProgressEventType,
  label: string,
  parentId?: string,
  metadata?: ProgressEvent["metadata"],
): ProgressEvent {
  const ev: ProgressEvent = {
    id: makeId(),
    parentId,
    type,
    label,
    status: "running",
    startedAt: Date.now(),
    metadata,
  };
  emitter.emit(ev);
  return ev;
}

function completeEvent(emitter: ProgressEmitter, ev: ProgressEvent, status: "success" | "error", error?: string): void {
  ev.status = status;
  ev.endedAt = Date.now();
  if (error) ev.metadata = { ...(ev.metadata || {}), error };
  emitter.emit(ev);
}

// ── Load a SKILL.js module via vm ───────────────────────

interface LoadedModule {
  init?: (ctx: unknown) => Promise<void>;
  start?: (ctx: unknown) => Promise<unknown> | unknown;
  end?: (ctx: unknown) => Promise<unknown> | unknown;
  exit?: (ctx: unknown, reason: string) => Promise<void> | void;
}

function loadRunner(jsPath: string): LoadedModule {
  const src = fs.readFileSync(jsPath, "utf-8");
  // Transform `export async function xxx` and `export function xxx` → `exports.xxx = async function xxx` / `exports.xxx = function xxx`
  const transformed = src
    .replace(/export\s+async\s+function\s+(\w+)/g, "exports.$1 = async function $1")
    .replace(/export\s+function\s+(\w+)/g, "exports.$1 = function $1")
    .replace(/export\s+default\s+/g, "module.exports = ")
    .replace(/export\s+const\s+(\w+)\s*=/g, "exports.$1 =");

  const moduleObj = { exports: {} as LoadedModule };
  const sandbox: Record<string, unknown> = {
    module: moduleObj,
    exports: moduleObj.exports,
    console: { log: console.log.bind(console), error: console.error.bind(console), warn: console.warn.bind(console) },
    JSON, Math, Date, Object, Array, String, Number, Boolean, Promise,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Error, TypeError, RangeError,
  };
  const ctx = vm.createContext(sandbox);
  const script = new vm.Script(transformed, { filename: jsPath });
  script.runInContext(ctx, { timeout: 5000 });
  return moduleObj.exports || (sandbox.exports as LoadedModule);
}

// ── Main lifecycle executor ─────────────────────────────

export async function runSkillLifecycle(
  engine: SkillEngine,
  name: string,
  input: unknown,
  opts: RunOpts = {},
): Promise<unknown> {
  const skill = engine.getSkill(name);
  if (!skill) throw new SkillError(`Skill "${name}" not found`, "SKILL_NOT_FOUND");

  const emitter = createEmitter(opts.onProgress);
  const runId = makeId();
  const runStartedAt = Date.now();
  const logs: string[] = [];
  const allowedTools = skill.manifest["allowed-tools"] ?? [];
  const requires = skill.manifest.requires ?? [];

  // ── SUBSTRATE: inhale (only at the top of a run, not for nested skill calls) ──
  let substrateBudget: BudgetTracker | null = null;
  let substrateIntent: Intent = "ask";
  let substrateInhaleData: Awaited<ReturnType<typeof substrateInhale>> | null = null;
  if (!opts.parentRunId) {
    substrateBudget = new BudgetTracker(globalSubstrateBudgetOpts || undefined);
    try {
      const userMsg = typeof input === "string" ? input : JSON.stringify(input ?? "");
      substrateInhaleData = await substrateInhale({ userMessage: userMsg, skillName: name, budget: substrateBudget });
      substrateIntent = substrateInhaleData.intent;
    } catch { /* non-fatal — substrate continues degraded */ }
  }

  // Event root for this run (nested under parent event if called via ctx.skill)
  const rootEvent = startEvent(
    emitter,
    opts.parentEventId ? "skill" : "step",
    opts.parentEventId ? `skill: ${name}` : `${name}`,
    opts.parentEventId,
    { skillName: name },
  );

  // Pre-resolve tools (also validates app connections)
  let resolvedTools: ResolvedTool[] = [];
  if (globalToolRouter && allowedTools.length > 0) {
    try {
      resolvedTools = globalToolRouter.resolve(allowedTools);
    } catch (err) {
      completeEvent(emitter, rootEvent, "error", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  // If the skill has no runner, fall back to prompt-mode processing
  if (!skill.hasRunner) {
    try {
      const contentStr = typeof input === "string" ? input : JSON.stringify(input);
      const result = await engine.process(contentStr, name);
      completeEvent(emitter, rootEvent, "success");
      recordRun(engine, name, runId, runStartedAt, input, result, undefined, logs, emitter, opts);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      completeEvent(emitter, rootEvent, "error", msg);
      recordRun(engine, name, runId, runStartedAt, input, undefined, msg, logs, emitter, opts);
      throw err;
    }
  }

  // Has SKILL.js runner — load and execute lifecycle
  const jsPath = path.join(skill.folderPath, "SKILL.js");
  let mod: LoadedModule;
  try {
    mod = loadRunner(jsPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    completeEvent(emitter, rootEvent, "error", `Runner load error: ${msg}`);
    recordRun(engine, name, runId, runStartedAt, input, undefined, msg, logs, emitter, opts);
    throw err;
  }

  // Build ctx
  const state = new Map<string, unknown>();
  const history: Array<{ skill: string; input: unknown; output: unknown; at: number }> = [];

  const ctx: Record<string, unknown> = {
    input,
    state,
    history,
    signal: opts.signal,
    log: (...args: unknown[]) => {
      const line = args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
      logs.push(line);
    },
    exit: (value: unknown) => { throw new EarlyExit(value); },

    agent: {
      ask: async (prompt: string, askOpts?: { model?: string }) => {
        const llm = engine.getLLMConfig();
        if (!llm?.apiKey) return "No LLM configured.";
        const ev = startEvent(
          emitter, "agent", `agent: ${askOpts?.model || skill.manifest.model || llm.model || "default"}`,
          rootEvent.id,
          { model: askOpts?.model || llm.model },
        );
        try {
          const toolsSpec = resolvedTools.length > 0 ? resolvedTools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.input_schema,
          })) : undefined;
          const response = await createCompletion(
            { ...llm, model: askOpts?.model || skill.manifest.model || llm.model },
            { system: "", messages: [{ role: "user", content: prompt }], tools: toolsSpec, maxTokens: 4096 },
          );
          // Collect text blocks; execute any tool calls the LLM makes
          let out = "";
          for (const block of response.content) {
            if (block.type === "text") out += block.text;
            else if (block.type === "tool_use") {
              const toolEv = startEvent(
                emitter, "mcp", `tool: ${block.name}`, ev.id,
                { toolName: block.name },
              );
              try {
                const resolved = resolvedTools.find((r) => r.name === block.name);
                let result: string;
                if (resolved?.kind === "mcp" && resolved.mcpQualifiedName && globalMcpManager) {
                  result = await globalMcpManager.callTool(resolved.mcpQualifiedName, block.input as Record<string, unknown>);
                } else {
                  // yo.* tools: not invoked from within the runner in v1 — report back to agent
                  result = `[tool ${block.name} requires agent-side execution]`;
                }
                completeEvent(emitter, toolEv, "success");
                out += `\n\n[${block.name}] ${result}`;
              } catch (err) {
                completeEvent(emitter, toolEv, "error", err instanceof Error ? err.message : String(err));
                throw err;
              }
            }
          }
          completeEvent(emitter, ev, "success");
          return out;
        } catch (err) {
          completeEvent(emitter, ev, "error", err instanceof Error ? err.message : String(err));
          throw err;
        }
      },
    },

    skill: async (subName: string, subInput: unknown) => {
      if (!requires.includes(subName)) {
        throw new SkillNotAllowedError(subName, name);
      }
      const ev = startEvent(emitter, "skill", `skill: ${subName}`, rootEvent.id, { skillName: subName });
      try {
        const result = await engine.runSkill(subName, subInput, {
          trigger: "skill",
          parentRunId: runId,
          parentEventId: ev.id,
          signal: opts.signal,
          onProgress: opts.onProgress,
          onAskUser: opts.onAskUser,
        });
        history.push({ skill: subName, input: subInput, output: result, at: Date.now() });
        completeEvent(emitter, ev, "success");
        return result;
      } catch (err) {
        completeEvent(emitter, ev, "error", err instanceof Error ? err.message : String(err));
        throw err;
      }
    },

    format: async (content: string, skillName: string) => {
      return engine.process(content, skillName);
    },

    file: (relPath: string) => {
      return engine.readSkillFile(name, relPath);
    },

    library: {
      read: (libName: string) => globalLibraryRead ? globalLibraryRead(libName) : null,
      write: (libName: string, content: string) => globalLibraryWrite ? globalLibraryWrite(libName, content) : false,
    },

    mcp: {
      call: async (serverId: string, toolName: string, args: Record<string, unknown> = {}) => {
        if (!globalMcpManager) throw new SkillError("MCP manager not available", "NO_MCP");
        // Enforce allowed-tools: the skill must declare <app>.<tool> to use it
        if (allowedTools.length > 0) {
          const qualified = `${serverId}.${toolName}`;
          if (!allowedTools.includes(qualified)) {
            throw new SkillError(`Tool "${qualified}" not in allowed-tools for skill "${name}"`, "TOOL_NOT_ALLOWED");
          }
        }
        const ev = startEvent(emitter, "mcp", `mcp: ${serverId}.${toolName}`, rootEvent.id, { toolName: `${serverId}.${toolName}` });
        try {
          const result = await globalMcpManager.callToolDirect(serverId, toolName, args);
          completeEvent(emitter, ev, "success");
          return result;
        } catch (err) {
          completeEvent(emitter, ev, "error", err instanceof Error ? err.message : String(err));
          throw err;
        }
      },
    },

    evaluate: async (value: unknown, question: string, evalOpts: EvaluateOpts = {}) => {
      const ev = startEvent(emitter, "evaluate", `evaluate: ${question.slice(0, 60)}`, rootEvent.id);
      try {
        let result: EvaluateResult;
        if (evalOpts.deterministic) {
          result = evaluateDeterministic(value, evalOpts);
        } else {
          const llm = engine.getLLMConfig();
          if (!llm?.apiKey) {
            result = { ok: true }; // no LLM — can't evaluate, assume pass
          } else {
            result = await evaluateLLM(llm, value, question);
          }
        }
        completeEvent(emitter, ev, "success");
        return result;
      } catch (err) {
        completeEvent(emitter, ev, "error", err instanceof Error ? err.message : String(err));
        throw err;
      }
    },

    retry: (_step: string, _hint?: string) => {
      // v1: runner code does its own retry via loops. This primitive is a future hook.
      throw new SkillError("ctx.retry is not implemented in v1 — use a loop with ctx.evaluate", "NOT_IMPLEMENTED");
    },
    back: (_n = 1) => {
      throw new SkillError("ctx.back is not implemented in v1 — use a loop with ctx.evaluate", "NOT_IMPLEMENTED");
    },

    ask: {
      user: async (question: string) => {
        if (!opts.onAskUser) throw new SkillError("ctx.ask.user has no UI to delegate to", "NO_UI");
        const ev = startEvent(emitter, "ask-user", `ask user: ${question.slice(0, 60)}`, rootEvent.id);
        try {
          const answer = await opts.onAskUser(question);
          completeEvent(emitter, ev, "success");
          return answer;
        } catch (err) {
          completeEvent(emitter, ev, "error", err instanceof Error ? err.message : String(err));
          throw err;
        }
      },
    },

    ui: {
      progress: (text: string) => {
        const ev = startEvent(emitter, "message", text, rootEvent.id);
        completeEvent(emitter, ev, "success");
      },
    },

    store: {
      get: (key: string) => globalDataStore ? globalDataStore.get(name, key) : null,
      set: (key: string, value: unknown) => { if (globalDataStore) globalDataStore.set(name, key, value); },
      delete: (key: string) => globalDataStore ? globalDataStore.delete(name, key) : false,
      list: (prefix?: string, limit?: number) => globalDataStore ? globalDataStore.list(name, prefix, limit).map(r => ({ key: r.key, value: r.value })) : [],
      query: (filter: Record<string, unknown>, limit?: number) => globalDataStore ? globalDataStore.query(name, filter, limit).map(r => ({ key: r.key, value: r.value })) : [],
      keys: () => globalDataStore ? globalDataStore.keys(name) : [],
      count: () => globalDataStore ? globalDataStore.count(name) : 0,
      clear: () => globalDataStore ? globalDataStore.clear(name) : 0,
    },

    step: async (label: string, fn: () => Promise<unknown>) => {
      const ev = startEvent(emitter, "step", label, rootEvent.id);
      try {
        const result = await fn();
        completeEvent(emitter, ev, "success");
        return result;
      } catch (err) {
        completeEvent(emitter, ev, "error", err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
  };

  // Execute lifecycle
  let output: unknown = undefined;
  let errorMsg: string | undefined;
  let reason: "success" | "error" | "cancel" = "success";

  try {
    if (mod.init) await mod.init(ctx);
    if (opts.signal?.aborted) throw new Error("Aborted");
    if (mod.start) {
      try {
        await mod.start(ctx);
      } catch (err) {
        if (err instanceof EarlyExit) {
          state.set("result", err.value);
          output = err.value;
        } else {
          throw err;
        }
      }
    }
    if (mod.end) output = await mod.end(ctx);
    else if (output === undefined) output = state.get("result");
    completeEvent(emitter, rootEvent, "success");
  } catch (err) {
    const aborted = opts.signal?.aborted;
    reason = aborted ? "cancel" : "error";
    errorMsg = err instanceof Error ? err.message : String(err);
    completeEvent(emitter, rootEvent, "error", errorMsg);
  } finally {
    if (mod.exit) {
      try { await mod.exit(ctx, reason); }
      catch (exitErr) {
        logs.push(`exit hook threw: ${exitErr instanceof Error ? exitErr.message : String(exitErr)}`);
      }
    }
  }

  // ── SUBSTRATE: exhale + reflex (only at the top of a run) ──
  if (!opts.parentRunId) {
    if (!errorMsg && output !== undefined) {
      try {
        const userMsg = typeof input === "string" ? input : JSON.stringify(input ?? "");
        const exhaled = await substrateExhale({
          output,
          intent: substrateIntent,
          userMessage: userMsg,
          formatTarget: typeof output === "string" ? "auto" : "auto",
          outputSpec: skill.manifest.outputs,
          redactInjections: true,
        });
        output = exhaled.output;
        for (const w of exhaled.sanitizeWarnings) logs.push(`[substrate] ${w}`);
        if (!exhaled.critique.ok && exhaled.critique.issues) {
          logs.push(`[substrate] critique: ${exhaled.critique.issues.join("; ")}`);
        }
      } catch (err) {
        // Scope violation surfaces here — convert to error
        errorMsg = err instanceof Error ? err.message : String(err);
        reason = "error";
      }
    }
    try {
      substrateReflex({
        intent: substrateIntent,
        skillName: name,
        chain: [name, ...(substrateInhaleData?.composed ?? [])],
        outcome: errorMsg ? "error" : "success",
        durationMs: Date.now() - runStartedAt,
        input,
        output,
      });
    } catch { /* non-fatal */ }
  }

  recordRun(engine, name, runId, runStartedAt, input, output, errorMsg, logs, emitter, opts);
  if (errorMsg) throw new SkillError(errorMsg, "RUNTIME_ERROR");
  return output;
}

function recordRun(
  engine: SkillEngine,
  skillName: string,
  runId: string,
  startedAt: number,
  input: unknown,
  output: unknown,
  error: string | undefined,
  logs: string[],
  emitter: ProgressEmitter,
  opts: RunOpts,
): void {
  const run: SkillRun = {
    id: runId,
    skillName,
    trigger: opts.trigger || "manual",
    startedAt,
    durationMs: Date.now() - startedAt,
    input,
    output,
    error,
    events: emitter.allEvents(),
    logs,
  };
  engine.appendRun(run);
}
