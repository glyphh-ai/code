/**
 * adaL_* tools — the substrate's cognitive surface exposed to the agent loop.
 *
 * Registered into the substrate BUILTIN_TOOLS registry (namespace "yo"). adaL
 * calls are auto-allowed in the action gate — they never route through the
 * approval flow (they read/write the local substrate, no external side effects).
 */

import type { ToolDef } from "../substrate/tools";
import { getAdal } from "./index";
import { adalEnabled, ADAL_DISABLED_MESSAGE } from "./gate";

export const ADAL_TOOL_PREFIX = "adaL_";

/** Refuse cleanly when the account isn't entitled to adaL, rather than touching
 *  the substrate. Applied to every adaL_* tool below. */
function gated(tool: ToolDef): ToolDef {
  const run = tool.run;
  return {
    ...tool,
    run: async (input) => (adalEnabled() ? run(input) : ADAL_DISABLED_MESSAGE),
  };
}

const ADAL_TOOL_DEFS: ToolDef[] = [
  {
    name: "adaL_think",
    namespace: "yo",
    description:
      "adaL associative recall. Surfaces the constellation of substrate thoughts related to an input — grounded context for generation. No question framing; returns what resonates.",
    input_schema: {
      type: "object",
      properties: { input: { type: "string", description: "What to think about" } },
      required: ["input"],
    },
    async run(input) {
      const text = String(input.input || "").trim();
      if (!text) return "No input provided.";
      const act = getAdal().think(text);
      if (act.thoughts.length === 0) return "(no activation — substrate is empty or nothing resonated)";
      return act.groundedContext;
    },
  },
  {
    name: "adaL_ask",
    namespace: "yo",
    description:
      "adaL targeted retrieval. Returns one grounded fact + confidence, or refuses honestly with \"I don't know\" rather than inventing. Use when you need a specific remembered fact.",
    input_schema: {
      type: "object",
      properties: { question: { type: "string", description: "The question to answer from the substrate" } },
      required: ["question"],
    },
    async run(input) {
      const q = String(input.question || "").trim();
      if (!q) return "No question provided.";
      const a = getAdal().ask(q);
      if (a.refused) return `I don't know. (confidence ${a.confidence.toFixed(2)})`;
      return `${a.answer}\n(confidence ${a.confidence.toFixed(2)})`;
    },
  },
  {
    name: "adaL_answer",
    namespace: "yo",
    description:
      "adaL grounded answer. Recalls substrate context for a question, then renders a concise natural-language answer using ONLY recalled memories (or honest refusal). Use when you want a phrased answer rather than raw recalled facts.",
    input_schema: {
      type: "object",
      properties: { question: { type: "string", description: "The question to answer from the substrate" } },
      required: ["question"],
    },
    async run(input) {
      const q = String(input.question || "").trim();
      if (!q) return "No question provided.";
      const a = await getAdal().answer(q);
      return a.refused ? "I don't know." : a.answer;
    },
  },
  {
    name: "adaL_tell",
    namespace: "yo",
    description:
      "Absorb a fact into the adaL substrate so future turns recall it. Optionally pass a stable `key` to version a concept over time (queryable via adaL_history / adaL_drift).",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The fact to remember" },
        key: { type: "string", description: "Optional stable key for versioning, e.g. \"ada.port\"" },
      },
      required: ["text"],
    },
    async run(input) {
      const text = String(input.text || "").trim();
      if (!text) return "No text provided.";
      const key = input.key ? String(input.key) : null;
      const id = getAdal().tell(text, "incoming", key);
      return id ? `absorbed${key ? ` (key=${key})` : ""}: ${id}` : "(duplicate — not absorbed)";
    },
  },
  {
    name: "adaL_tell_raw",
    namespace: "yo",
    description: "Absorb a fact with no LLM enrichment (programmatic ingestion). Same persistence as adaL_tell.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string", description: "The fact to remember verbatim" } },
      required: ["text"],
    },
    async run(input) {
      const text = String(input.text || "").trim();
      if (!text) return "No text provided.";
      const id = getAdal().tellRaw(text);
      return id ? `absorbed (raw): ${id}` : "(duplicate — not absorbed)";
    },
  },
  {
    name: "adaL_history",
    namespace: "yo",
    description: "Version chain for a stable concept key in the adaL substrate.",
    input_schema: {
      type: "object",
      properties: { key: { type: "string", description: "The stable key, e.g. \"ada.port\"" } },
      required: ["key"],
    },
    async run(input) {
      const key = String(input.key || "").trim();
      if (!key) return "No key provided.";
      const hist = getAdal().history(key);
      if (!hist.length) return `(no history for "${key}")`;
      return hist.map((h) => `v${h.version ?? "?"}: ${h.content}`).join("\n");
    },
  },
  {
    name: "adaL_drift",
    namespace: "yo",
    description: "How the substrate's representation of a keyed concept has shifted across its versions (cosine drift).",
    input_schema: {
      type: "object",
      properties: { key: { type: "string", description: "The stable key, e.g. \"ada.port\"" } },
      required: ["key"],
    },
    async run(input) {
      const key = String(input.key || "").trim();
      if (!key) return "No key provided.";
      const d = getAdal().drift(key);
      if (d.driftRate === undefined) return `only ${d.versions} version(s) — drift needs ≥2`;
      return [
        `versions: ${d.versions}`,
        `consecutive sims: [${(d.consecutiveSimilarities ?? []).map((x) => x.toFixed(3)).join(", ")}]`,
        `first→last sim: ${d.firstToLastSimilarity?.toFixed(3)}`,
        `drift rate: ${d.driftRate?.toFixed(3)}`,
      ].join("\n");
    },
  },
  {
    name: "adaL_schema",
    namespace: "yo",
    description: "Summary of what the adaL substrate currently holds (thought count, average strength).",
    input_schema: { type: "object", properties: {} },
    async run() {
      const s = getAdal().schema();
      return `thoughts: ${s.count}\navg strength: ${s.avgStrength.toFixed(3)}`;
    },
  },
];

export const ADAL_TOOLS: ToolDef[] = ADAL_TOOL_DEFS.map(gated);
