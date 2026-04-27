/**
 * think.budget — hard ceilings on tokens, tool calls, depth, and time.
 *
 * Created at the start of a top-level skill run. Sub-skills inherit the
 * SAME budget object (same instance), so nested invocations share the cap.
 *
 * Tunable via preferences:
 *   substrate.budget.maxTokens     (default 60000)
 *   substrate.budget.maxToolCalls  (default 20)
 *   substrate.budget.maxDepth      (default 5)
 *   substrate.budget.maxDepthMs    (default 120000 = 2 min)
 */

import { BudgetExceededError, BudgetState } from "./types";

export interface BudgetOpts {
  maxTokens?: number;
  maxToolCalls?: number;
  maxDepth?: number;
  maxDepthMs?: number;
}

const DEFAULTS: Required<BudgetOpts> = {
  maxTokens: 200_000,
  maxToolCalls: 40,
  maxDepth: 5,
  maxDepthMs: 300_000,
};

export class BudgetTracker {
  state: BudgetState;

  constructor(opts: BudgetOpts = {}) {
    const o = { ...DEFAULTS, ...opts };
    this.state = {
      maxTokens: o.maxTokens,
      maxToolCalls: o.maxToolCalls,
      maxDepth: o.maxDepth,
      maxDepthMs: o.maxDepthMs,
      usedTokens: 0,
      usedToolCalls: 0,
      depth: 0,
      startedAt: Date.now(),
    };
  }

  countTokens(n: number): void {
    this.state.usedTokens += n;
    this.assertOk();
  }

  countToolCall(): void {
    this.state.usedToolCalls += 1;
    this.assertOk();
  }

  enterDepth(): void {
    this.state.depth += 1;
    this.assertOk();
  }

  exitDepth(): void {
    if (this.state.depth > 0) this.state.depth -= 1;
  }

  remainingTokens(): number {
    return Math.max(0, this.state.maxTokens - this.state.usedTokens);
  }

  private assertOk(): void {
    const s = this.state;
    if (s.usedTokens > s.maxTokens) throw new BudgetExceededError("tokens", s);
    if (s.usedToolCalls > s.maxToolCalls) throw new BudgetExceededError("tool-calls", s);
    if (s.depth > s.maxDepth) throw new BudgetExceededError("depth", s);
    if (Date.now() - s.startedAt > s.maxDepthMs) throw new BudgetExceededError("time", s);
  }
}
