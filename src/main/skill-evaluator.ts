/**
 * SkillEvaluator — implements ctx.evaluate() for the observer pattern.
 *
 * Given a value and a question, returns:
 *   { ok: true }                               → accept, move on
 *   { ok: false, retry: true, feedback: "..." } → re-run with augmented hint
 *   { ok: false, back: N }                     → rewind N steps
 *   { ok: false, askUser: true, question }     → ask the user
 *
 * Default: uses LLM judgement. With opts.deterministic, uses regex/schema.
 */

import { LLMConfig, createCompletion } from "./llm-config";

export interface EvaluateResult {
  ok: boolean;
  retry?: boolean;
  back?: number;
  askUser?: boolean;
  question?: string;
  feedback?: string;
}

export interface EvaluateOpts {
  deterministic?: boolean;
  regex?: RegExp;
  schema?: (v: unknown) => boolean;
  maxRetries?: number;
}

const EVAL_SYSTEM = `You are an evaluator for a deterministic skill pipeline.

Given a VALUE produced by a step and a QUESTION about whether it's satisfactory, respond with a JSON object:
{
  "ok": <true if satisfactory, false otherwise>,
  "retry": <true if the step should be re-run with guidance, false otherwise>,
  "back": <number of steps to rewind, or 0>,
  "askUser": <true if a human should clarify, false otherwise>,
  "question": <string, only if askUser is true>,
  "feedback": <short string: what to change if retrying, or why ok is false>
}

Be decisive. If the value clearly satisfies the question, set ok=true and nothing else. Otherwise choose the smallest intervention that fixes it: retry with feedback is usually right; back > 0 only if earlier step was wrong; askUser only when you genuinely need human input.

Output ONLY the JSON object, nothing else.`;

export async function evaluateLLM(
  llm: LLMConfig,
  value: unknown,
  question: string,
): Promise<EvaluateResult> {
  const valueStr = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  try {
    const response = await createCompletion(llm, {
      system: EVAL_SYSTEM,
      messages: [
        { role: "user", content: `QUESTION: ${question}\n\nVALUE:\n${valueStr.slice(0, 8000)}` },
      ],
      maxTokens: 512,
    });
    const block = response.content[0];
    if (block.type !== "text") return { ok: true };
    // Extract JSON (tolerant to markdown fences)
    let text = block.text.trim();
    const fenceMatch = text.match(/```(?:json)?\n?([\s\S]+?)\n?```/);
    if (fenceMatch) text = fenceMatch[1];
    try {
      const parsed = JSON.parse(text) as EvaluateResult;
      return normaliseResult(parsed);
    } catch {
      return { ok: true }; // evaluator failed → assume pass (don't block)
    }
  } catch {
    return { ok: true };
  }
}

export function evaluateDeterministic(value: unknown, opts: EvaluateOpts): EvaluateResult {
  if (opts.regex) {
    const str = typeof value === "string" ? value : JSON.stringify(value);
    return { ok: opts.regex.test(str) };
  }
  if (opts.schema) {
    try {
      return { ok: !!opts.schema(value) };
    } catch {
      return { ok: false };
    }
  }
  return { ok: true };
}

function normaliseResult(r: Partial<EvaluateResult>): EvaluateResult {
  const ok = !!r.ok;
  if (ok) return { ok: true };
  return {
    ok: false,
    retry: !!r.retry,
    back: typeof r.back === "number" ? r.back : 0,
    askUser: !!r.askUser,
    question: r.question,
    feedback: r.feedback,
  };
}
