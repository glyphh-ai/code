/**
 * sense.intent — classify the user's ask into one of six fixed intents.
 *
 * Cheap (cached prompt), deterministic taxonomy. All downstream primitives
 * (compose, recall, format) branch off the result.
 */

import { Intent } from "./types";

interface IntentDeps {
  llm?: (prompt: string) => Promise<string>;
}

let deps: IntentDeps = {};
export function setIntentDeps(d: IntentDeps): void { deps = { ...deps, ...d }; }

const INTENT_TAXONOMY: ReadonlyArray<Intent> = ["do", "ask", "find", "create", "iterate", "clarify"];

const INTENT_SYSTEM = `You classify user requests into ONE of these intents:
- do        : execute an action / use a tool (send, save, open, run, click)
- ask       : answer a question from knowledge ("what is", "explain", "why")
- find      : search for existing content ("find", "where is", "search")
- create    : generate new content ("write", "draft", "make")
- iterate   : refine an existing artifact ("change", "fix", "improve", "rewrite")
- clarify   : the user's request is ambiguous and needs a clarifying question first

Respond with ONLY the single word: do, ask, find, create, iterate, or clarify.`;

const KEYWORD_HINTS: Record<Intent, RegExp[]> = {
  do: [/\b(send|save|open|run|click|launch|delete|remove|push|publish|deploy|trigger)\b/i],
  ask: [/\b(what|why|how|explain|describe|when|who)\b\s/i, /\?$/],
  find: [/\b(find|search|where|locate|look\s*up|grep)\b/i],
  create: [/\b(write|draft|make|generate|create|build|compose)\b/i],
  iterate: [/\b(change|fix|improve|rewrite|refine|tweak|update|edit)\b/i],
  clarify: [/^(.{0,8})$/],
};

function ruleClassify(text: string): Intent | null {
  const t = text.trim();
  if (t.length < 2) return "clarify";
  // Score each intent by keyword matches; pick highest
  let best: Intent | null = null;
  let bestHits = 0;
  for (const intent of INTENT_TAXONOMY) {
    const hits = KEYWORD_HINTS[intent].reduce((n, re) => n + (re.test(t) ? 1 : 0), 0);
    if (hits > bestHits) { bestHits = hits; best = intent; }
  }
  return bestHits > 0 ? best : null;
}

export async function senseIntent(userMessage: string): Promise<Intent> {
  // Fast path: rule-based classifier handles ~70% of cases for free
  const ruleHit = ruleClassify(userMessage);
  if (ruleHit) return ruleHit;

  // Fallback: small LLM call
  if (!deps.llm) return "ask";
  try {
    const out = await deps.llm(`${INTENT_SYSTEM}\n\nUSER: ${userMessage.slice(0, 1000)}`);
    const word = out.trim().toLowerCase().split(/\s+/)[0];
    return (INTENT_TAXONOMY as readonly string[]).includes(word) ? (word as Intent) : "ask";
  } catch {
    return "ask";
  }
}
