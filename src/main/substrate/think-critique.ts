/**
 * think.critique — self-evaluate the agent's output before returning.
 *
 * Cheap LLM call: "Does this output satisfy the user's intent?
 * Is it well-formed? Did it cite evidence?"
 *
 * Returns a verdict the runner uses to decide retry/return.
 * If no LLM is available (or critique disabled), passes through.
 */

import { CritiqueResult, Intent } from "./types";

interface CritiqueDeps {
  llm?: (prompt: string) => Promise<string>;
}

let deps: CritiqueDeps = {};
let enabled = true;

export function setCritiqueDeps(d: CritiqueDeps): void { deps = { ...deps, ...d }; }
export function setCritiqueEnabled(v: boolean): void { enabled = v; }

const CRITIQUE_SYSTEM = `You are a strict but brief evaluator. Given the USER REQUEST and the AGENT OUTPUT, decide if the output is satisfactory.

Respond with a JSON object on a single line:
{"ok": true}                          — output is good
{"ok": false, "issues": ["..."]}      — output has problems (list 1-3 short issues)

Be lenient on style and tone. Be strict on:
- Did the output address the actual request?
- Is the format reasonable (not malformed JSON, not truncated mid-thought)?
- If a tool was needed and skipped, that's an issue.

Output ONLY the JSON object.`;

export async function thinkCritique(
  userRequest: string,
  output: string,
  intent: Intent,
): Promise<CritiqueResult> {
  if (!enabled) return { ok: true };
  if (!deps.llm) return { ok: true };

  // Skip critique for very short outputs (probably just an ack)
  if (output.length < 20) return { ok: true };

  // Skip for "ask" intent on long answers — the LLM is the source of truth
  if (intent === "ask" && output.length > 2000) return { ok: true };

  try {
    const prompt = `${CRITIQUE_SYSTEM}\n\nUSER REQUEST:\n${userRequest.slice(0, 1000)}\n\nAGENT OUTPUT:\n${output.slice(0, 4000)}`;
    const raw = await deps.llm(prompt);
    let text = raw.trim();
    const fence = text.match(/```(?:json)?\n?([\s\S]+?)\n?```/);
    if (fence) text = fence[1].trim();
    const parsed = JSON.parse(text);
    return parsed.ok ? { ok: true } : { ok: false, issues: Array.isArray(parsed.issues) ? parsed.issues.slice(0, 3) : ["unspecified"] };
  } catch {
    return { ok: true }; // critique failed → don't block, just pass
  }
}
