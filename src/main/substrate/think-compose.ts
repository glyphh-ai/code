/**
 * think.compose — pick the user-skill chain to invoke based on intent + context.
 *
 * Heuristic:
 *   1. If intent is "find", prefer skills with `find` / `search` in description
 *   2. Score every skill by description match against user message + intent
 *   3. Return ordered list (top N)
 *
 * The agent doesn't decide "should I compose?" — the substrate does it for them.
 */

import { Intent } from "./types";

interface ComposeDeps {
  listSkills?: () => Array<{ name: string; description?: string; when_to_use?: string }>;
}

let deps: ComposeDeps = {};
export function setComposeDeps(d: ComposeDeps): void { deps = { ...deps, ...d }; }

export function thinkCompose(intent: Intent, userMessage: string, opts: { topN?: number } = {}): string[] {
  const skills = deps.listSkills?.() ?? [];
  if (skills.length === 0) return [];

  const topN = opts.topN ?? 3;
  const lower = userMessage.toLowerCase();
  const tokens = lower.split(/\s+/).filter((t) => t.length > 2);

  // Intent → keyword bias
  const intentKeywords: Record<Intent, string[]> = {
    do: ["execute", "send", "run", "perform", "trigger"],
    ask: ["explain", "answer", "summarize"],
    find: ["search", "find", "lookup", "discover"],
    create: ["generate", "create", "draft", "write"],
    iterate: ["refine", "improve", "rewrite", "polish"],
    clarify: [],
  };
  const intentBias = intentKeywords[intent] || [];

  const scored = skills.map((s) => {
    const haystack = `${s.name} ${s.description || ""} ${s.when_to_use || ""}`.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (haystack.includes(t)) score += 2;
    }
    for (const k of intentBias) {
      if (haystack.includes(k)) score += 1;
    }
    // Direct skill name mention is strongest signal
    if (lower.includes(s.name.toLowerCase())) score += 10;
    return { name: s.name, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.filter((s) => s.score > 0).slice(0, topN).map((s) => s.name);
}
