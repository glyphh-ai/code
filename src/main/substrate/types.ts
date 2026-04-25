/**
 * Substrate primitive types.
 *
 * The substrate is the autonomic nervous system of the .yo agent.
 * Primitives wrap every skill invocation in an inhale → think → exhale → reflex
 * cycle. Skills (and the LLM) never invoke these directly — the runner does.
 */

export type Intent =
  | "do"        // execute an action / use a tool
  | "ask"       // answer a question from knowledge
  | "find"      // search captures / library / web
  | "create"    // generate new content
  | "iterate"   // refine an existing artifact
  | "clarify";  // ask the user to disambiguate

export interface ContextSnapshot {
  activePanelId: string | null;
  activeAppName: string | null;
  focusedInputElementInfo?: { tag: string; placeholder?: string } | null;
  recentCaptures: Array<{ id: string; source: string; preview: string; at: number }>;
  lastUserMessage?: string;
}

export interface RecallMatch {
  intent: Intent;
  skills: string[];
  outcome: "success" | "error";
  durationMs: number;
  at: number;
  score?: number;
}

export interface BudgetState {
  maxTokens: number;
  maxToolCalls: number;
  maxDepthMs: number;
  maxDepth: number;
  usedTokens: number;
  usedToolCalls: number;
  startedAt: number;
  depth: number;
}

export interface CritiqueResult {
  ok: boolean;
  issues?: string[];
}

export interface CheckpointDecision {
  approved: boolean;
  reason?: string;
}

export interface RememberedRun {
  id: string;
  intent: Intent;
  skill: string;
  chain: string[];
  outcome: "success" | "error";
  durationMs: number;
  at: number;
  inputDigest?: string;
  outputDigest?: string;
}

export class BudgetExceededError extends Error {
  constructor(public kind: "tokens" | "tool-calls" | "depth" | "time", public state: BudgetState) {
    super(`Budget exceeded: ${kind}`);
    this.name = "BudgetExceededError";
  }
}

export class ScopeViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeViolationError";
  }
}
