/**
 * Substrate — the autonomic layer beneath every skill invocation.
 *
 * Exports all 15 primitives + a `wrapWithSubstrate` helper that the
 * skill-runner uses to apply the breath cycle:
 *
 *   inhale  → sense.context, sense.recall, sense.intent, sense.app
 *   think   → think.compose, think.govern, think.budget, think.critique
 *   exhale  → act.format, act.sanitize, act.respect-scope, act.checkpoint
 *   reflex  → reflex.cancel, reflex.retry, reflex.remember
 *
 * Skills (and the LLM) NEVER invoke these directly — only the runner does.
 */

export * from "./types";

// sense
export { senseContext, setContextDeps } from "./sense-context";
export { senseRecall, setRecallDeps } from "./sense-recall";
export { senseIntent, setIntentDeps } from "./sense-intent";
export { senseApp, setAppDeps } from "./sense-app";

// think
export { thinkCompose, setComposeDeps } from "./think-compose";
export { SkillToolRouter } from "./think-govern";
export type { ResolvedTool } from "./think-govern";
export { BudgetTracker, type BudgetOpts } from "./think-budget";
export { thinkCritique, setCritiqueDeps, setCritiqueEnabled } from "./think-critique";

// act
export { actFormat, type FormatTarget } from "./act-format";
export { actSanitize, type SanitizeResult } from "./act-sanitize";
export { actCheckpoint, isDestructive, type CheckpointOpts } from "./act-checkpoint";
export { actRespectScope, type OutputSpec } from "./act-respect-scope";

// reflex
export { reflexCancel, AbortError } from "./reflex-cancel";
export { reflexRetry, type RetryStrategy } from "./reflex-retry";
export { reflexRemember, setRememberOpts } from "./reflex-remember";

// store admin
export { recentRuns, clearMemory } from "./store";

// unified tool registry (substrate + user skills + MCP)
export {
  setSubstrateToolDeps,
  getAgentToolSpec,
  executeTool,
  isDestructiveTool,
  listAllTools,
  listBuiltinYoTools,
  type ToolDef,
  type SubstrateToolDeps,
} from "./tools";

// ── Orchestrator: one breath cycle around a skill invocation ──────

import { Intent } from "./types";
import { senseIntent } from "./sense-intent";
import { senseContext } from "./sense-context";
import { senseRecall } from "./sense-recall";
import { senseApp } from "./sense-app";
import { thinkCompose } from "./think-compose";
import { thinkCritique } from "./think-critique";
import { BudgetTracker } from "./think-budget";
import { actFormat, FormatTarget } from "./act-format";
import { actSanitize } from "./act-sanitize";
import { actRespectScope, OutputSpec } from "./act-respect-scope";
import { reflexCancel } from "./reflex-cancel";
import { reflexRemember } from "./reflex-remember";

export interface SubstrateInhaleResult {
  intent: Intent;
  context: ReturnType<typeof senseContext>;
  recall: Awaited<ReturnType<typeof senseRecall>>;
  app: string | null;
  composed: string[];
  budget: BudgetTracker;
}

export async function inhale(args: {
  userMessage: string;
  skillName: string;
  budget: BudgetTracker;
}): Promise<SubstrateInhaleResult> {
  const intent = await senseIntent(args.userMessage);
  const context = senseContext({ lastUserMessage: args.userMessage });
  const recall = await senseRecall(intent, args.skillName, args.userMessage);
  const app = senseApp(args.userMessage);
  const composed = thinkCompose(intent, args.userMessage);
  return { intent, context, recall, app, composed, budget: args.budget };
}

export async function exhale(args: {
  output: unknown;
  intent: Intent;
  userMessage: string;
  formatTarget: FormatTarget;
  outputSpec?: OutputSpec[];
  redactInjections?: boolean;
}): Promise<{ output: unknown; sanitizeWarnings: string[]; critique: { ok: boolean; issues?: string[] } }> {
  // 1. Validate scope
  actRespectScope(args.output, args.outputSpec);

  // 2. Format if string
  let out = args.output;
  let warnings: string[] = [];
  if (typeof out === "string") {
    const sanitized = actSanitize(out, { redactInjections: args.redactInjections });
    warnings = sanitized.warnings;
    out = actFormat(sanitized.text, args.formatTarget);
  }

  // 3. Critique (best-effort)
  const critique = typeof out === "string"
    ? await thinkCritique(args.userMessage, out, args.intent)
    : { ok: true };

  return { output: out, sanitizeWarnings: warnings, critique };
}

export function reflex(args: {
  intent: Intent;
  skillName: string;
  chain: string[];
  outcome: "success" | "error";
  durationMs: number;
  input?: unknown;
  output?: unknown;
}): void {
  reflexRemember({ ...args, skill: args.skillName });
}

// Convenience: cancel-aware promise wrapper
export const cancelable = reflexCancel;
