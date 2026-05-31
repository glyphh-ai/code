/**
 * adaL LLM seams — ada's three build-time LLM hooks, rerouted through yo's own
 * one-shot completion path (sdkComplete → Claude Code OAuth creds) instead of a
 * direct `anthropic.Anthropic()` client.
 *
 * Ported seams:
 *   enrichFact   ← ada/encoder/llm_enricher.py  (HaikuEnricher.enrich)
 *                  + ada/cognitive/universal.py (UniversalEnricher)
 *                  Parses a fact into {subject, predicate, object, topic}.
 *   renderAnswer ← ada/cognitive/generate.py    (build_llm_renderer._render)
 *                  Renders a grounded answer from recalled context + a query.
 *
 * Both degrade gracefully: enrichFact falls back to the ported offline
 * HeuristicEnricher; renderAnswer returns null so callers fall back to the raw
 * substrate context. The substrate works fully without either — the LLM only
 * sharpens structure (enrich) or surface form (render).
 */

import crypto from "crypto";
import { sdkComplete } from "../sdk-llm";

const ENRICH_MODEL = "claude-haiku-4-5-20251001";
const RENDER_MODEL = "claude-haiku-4-5-20251001";

export interface StructuredFact {
  text: string;
  subject: string;
  predicate: string;
  object: string;
  topic: string;
}

function emptyFact(text: string): StructuredFact {
  return { text, subject: "", predicate: "", object: "", topic: "general" };
}

export function isStructured(f: StructuredFact): boolean {
  return Boolean(f.subject || f.predicate || f.object);
}

// ── Heuristic enricher (offline fallback, port of llm_enricher.py) ──────────

const strip = (s: string) => s.trim().replace(/[?.,!]+$/g, "").toLowerCase();

function tryFact(text: string): StructuredFact | null {
  let m: RegExpMatchArray | null;

  if ((m = text.match(/^(\w+)(?:'s|s)\s+favorite\s+(\w+)\s+is\s+(.+?)\.?$/i)))
    return { text, subject: strip(m[1]), predicate: `favorite_${m[2].toLowerCase()}`, object: strip(m[3]), topic: "person.preference" };
  if ((m = text.match(/^(\w+)\s+is\s+(\d+)\s+years?\s+old\.?$/i)))
    return { text, subject: strip(m[1]), predicate: "age", object: m[2], topic: "person.age" };
  if ((m = text.match(/^(\w+)\s+lives?\s+in\s+(.+?)\.?$/i)))
    return { text, subject: strip(m[1]), predicate: "residence", object: strip(m[2]), topic: "person.location" };
  if ((m = text.match(/^(\w+)\s+works?\s+as\s+(?:a|an)?\s*(.+?)\.?$/i)))
    return { text, subject: strip(m[1]), predicate: "job", object: strip(m[2]), topic: "person.job" };
  if ((m = text.match(/^The\s+capital\s+of\s+(.+?)\s+is\s+(.+?)\.?$/i)))
    return { text, subject: strip(m[1]), predicate: "capital", object: strip(m[2]), topic: "geography.capital" };
  if ((m = text.match(/^(\w+)\s+stands\s+for\s+(.+?)\.?$/i)))
    return { text, subject: strip(m[1]), predicate: "abbreviation_of", object: strip(m[2]), topic: "knowledge.definition" };
  if ((m = text.match(/^The\s+(\w+)\s+server\s+runs\s+on\s+port\s+(\d+)\.?$/i)))
    return { text, subject: strip(m[1]), predicate: "port", object: m[2], topic: "ada.architecture" };

  return null;
}

function tryQuery(text: string): StructuredFact | null {
  let m: RegExpMatchArray | null;

  if ((m = text.match(/^(?:what\s+is\s+(\w+)(?:'s|s)\s+age|how\s+old\s+is\s+(\w+))\??$/i)))
    return { ...emptyFact(text), subject: strip(m[1] || m[2]), predicate: "age", topic: "person.age" };
  if ((m = text.match(/^where\s+does\s+(\w+)\s+live\??$/i)))
    return { ...emptyFact(text), subject: strip(m[1]), predicate: "residence", topic: "person.location" };
  if ((m = text.match(/^(?:what\s+job\s+does\s+(\w+)\s+have|what\s+does\s+(\w+)\s+do)\??$/i)))
    return { ...emptyFact(text), subject: strip(m[1] || m[2]), predicate: "job", topic: "person.job" };
  if ((m = text.match(/^what\s+is\s+(\w+)(?:'s|s)\s+favorite\s+(\w+)\??$/i)))
    return { ...emptyFact(text), subject: strip(m[1]), predicate: `favorite_${m[2].toLowerCase()}`, topic: "person.preference" };
  if ((m = text.match(/^what\s+is\s+the\s+capital\s+of\s+(.+?)\??$/i)))
    return { ...emptyFact(text), subject: strip(m[1]), predicate: "capital", topic: "geography.capital" };
  if ((m = text.match(/^what\s+port\s+does\s+(\w+)\s+run\s+on\??$/i)))
    return { ...emptyFact(text), subject: strip(m[1]), predicate: "port", topic: "ada.architecture" };

  return null;
}

export function heuristicEnrich(text: string): StructuredFact {
  const clean = text.trim();
  return tryFact(clean) || tryQuery(clean) || emptyFact(clean);
}

// ── LLM enricher (online, rerouted through sdkComplete) ─────────────────────

const _ENRICH_SYSTEM =
  "You parse a fact into a structured tuple. Return JSON with exactly these " +
  "keys: subject, predicate, object, topic. predicate is a snake_case verb-like " +
  "attribute name (age, residence, job, capital, favorite_color, abbreviation_of, " +
  "etc.). topic is a dotted hierarchical tag (person.age, person.location, " +
  "geography.capital, knowledge.definition, science.constant, etc.). " +
  "Be terse — no explanation, just JSON.";

const _enrichCache = new Map<string, StructuredFact>();

/** Parse a fact into structure. LLM-backed, cached, heuristic fallback. */
export async function enrichFact(text: string): Promise<StructuredFact> {
  const key = crypto.createHash("sha256").update(text).digest("hex");
  const cached = _enrichCache.get(key);
  if (cached) return cached;

  let fact: StructuredFact;
  try {
    const { text: raw } = await sdkComplete({
      system: _ENRICH_SYSTEM,
      prompt: `Fact: ${text}`,
      model: ENRICH_MODEL,
    });
    const json = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    const data = JSON.parse(json) as Record<string, unknown>;
    fact = {
      text,
      subject: String(data.subject ?? "").trim().toLowerCase(),
      predicate: String(data.predicate ?? "").trim().toLowerCase().replace(/\s+/g, "_"),
      object: String(data.object ?? "").trim().toLowerCase(),
      topic: String(data.topic ?? "general").trim().toLowerCase(),
    };
  } catch (err) {
    fact = heuristicEnrich(text);
  }
  _enrichCache.set(key, fact);
  return fact;
}

// ── LLM renderer (online, rerouted through sdkComplete) ─────────────────────

const _RENDER_SYSTEM =
  "You are a memory surface. Answer the user's query using ONLY the recalled " +
  "memories provided. If the memories don't contain the answer, say you don't " +
  "know — never invent facts. Be concise and direct.";

/**
 * Render a grounded answer from recalled context + a query. Returns null if the
 * LLM is unavailable / errors, so the caller falls back to the raw context.
 */
export async function renderAnswer(context: string, query: string): Promise<string | null> {
  try {
    const { text } = await sdkComplete({
      system: _RENDER_SYSTEM,
      prompt: `${context}\n\nAnswer this query using only the recalled memories: ${query}`,
      model: RENDER_MODEL,
    });
    const out = text.trim();
    return out || null;
  } catch {
    return null;
  }
}
