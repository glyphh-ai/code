/**
 * act.respect-scope — validate output against the skill's declared shape.
 *
 * If the skill's manifest declares `outputs:`, validate the result against it.
 * Mismatches throw ScopeViolationError so the runner can either retry (with
 * augmented hint) or surface the error to the caller.
 *
 * v1: shallow validation by name + primitive type (string/number/boolean/array/object).
 * Future: full JSON-schema or zod validation.
 */

import { ScopeViolationError } from "./types";

export interface OutputSpec {
  name: string;
  type: string;
  description?: string;
}

function detectType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

export function actRespectScope(output: unknown, spec: OutputSpec[] | undefined): void {
  if (!spec || spec.length === 0) return; // skill didn't declare; permissive

  // Single-output shorthand: skill returns a value directly (not a {name: value} object)
  if (spec.length === 1) {
    const expected = spec[0].type.toLowerCase();
    const actual = detectType(output);
    if (expected === "any" || expected === "unknown") return;
    if (expected === actual) return;
    // Allow string ⊇ markdown / json (text formats are all strings)
    if (expected === "string" && (actual === "string")) return;
    throw new ScopeViolationError(`Skill output expected ${expected}, got ${actual}`);
  }

  // Multi-output: result must be an object with named keys matching spec
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    throw new ScopeViolationError(`Skill declared ${spec.length} outputs but returned non-object`);
  }
  const obj = output as Record<string, unknown>;
  for (const o of spec) {
    if (!(o.name in obj)) {
      throw new ScopeViolationError(`Skill output missing required field "${o.name}"`);
    }
    const expected = o.type.toLowerCase();
    if (expected === "any" || expected === "unknown") continue;
    const actual = detectType(obj[o.name]);
    if (expected !== actual) {
      throw new ScopeViolationError(`Skill output "${o.name}" expected ${expected}, got ${actual}`);
    }
  }
}
