/**
 * reflex.remember — record (intent, skill chain, outcome) triples.
 *
 * Fed back to sense.recall on subsequent runs. After N successful repeats
 * of a pattern, the substrate proposes saving it as a real user skill
 * (via the optional onPatternRecognized callback).
 */

import crypto from "crypto";
import { Intent, RememberedRun } from "./types";
import { recordRun, countMatchingRuns } from "./store";

export interface RememberOpts {
  /** When N+ successful runs share the same (intent, skill) pair, fire this. */
  patternThreshold?: number;
  onPatternRecognized?: (info: { intent: Intent; skill: string; count: number }) => void;
}

let opts: RememberOpts = { patternThreshold: 5 };
export function setRememberOpts(o: RememberOpts): void { opts = { ...opts, ...o }; }

function digest(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const str = typeof value === "string" ? value : JSON.stringify(value);
  return crypto.createHash("sha256").update(str).digest("hex").slice(0, 16);
}

export function reflexRemember(args: {
  intent: Intent;
  skill: string;
  chain: string[];
  outcome: "success" | "error";
  durationMs: number;
  input?: unknown;
  output?: unknown;
}): void {
  const run: RememberedRun = {
    id: crypto.randomBytes(8).toString("hex"),
    intent: args.intent,
    skill: args.skill,
    chain: args.chain,
    outcome: args.outcome,
    durationMs: args.durationMs,
    at: Date.now(),
    inputDigest: digest(args.input),
    outputDigest: digest(args.output),
  };
  try { recordRun(run); } catch { /* memory store unavailable — non-fatal */ }

  if (args.outcome === "success" && opts.onPatternRecognized && opts.patternThreshold) {
    try {
      const count = countMatchingRuns(args.intent, args.skill, "success");
      if (count === opts.patternThreshold) {
        opts.onPatternRecognized({ intent: args.intent, skill: args.skill, count });
      }
    } catch { /* non-fatal */ }
  }
}
