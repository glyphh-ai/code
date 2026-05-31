/**
 * adaL PrimitiveSpace — word → structural role matcher.
 *
 * ada's PrimitiveSpace does HDC-cosine matching against exemplar centroids
 * loaded from a JSONL corpus. On the fresh substrate we don't need that corpus:
 * a curated lexicon maps function/structural words to the same role names ada
 * uses (see ROLE_TO_LAYER_SEGMENT in encoder.ts). Unknown words fall through as
 * content words — exactly how ada treats words with no primitive match.
 *
 * A word may activate MULTIPLE roles ("who" → question + identity).
 */

const LEXICON: Record<string, string[]> = {
  // ── perspective — WHO ──
  i: ["self"], me: ["self"], my: ["self", "possession"], mine: ["self", "possession"],
  myself: ["self"], we: ["group"], us: ["group"], our: ["group", "possession"],
  you: ["other"], your: ["other", "possession"], yours: ["other", "possession"],
  he: ["third"], she: ["third"], him: ["third"], her: ["third", "possession"],
  his: ["third", "possession"], they: ["group"], them: ["group"], their: ["group", "possession"],

  // ── question / introspection ──
  who: ["question", "identity"], what: ["question"], which: ["question"],
  where: ["question", "location"], when: ["question", "present"], why: ["question", "causation"],
  how: ["question"], whose: ["question", "possession"],

  // ── affirmation / negation / presence ──
  yes: ["affirmation"], yeah: ["affirmation"], yep: ["affirmation"], true: ["affirmation"],
  no: ["negation"], not: ["negation"], never: ["negation"], none: ["absence"],
  false: ["negation"], without: ["absence"], missing: ["absence"],
  all: ["totality"], every: ["totality"], everything: ["totality"], some: ["quantity"],
  has: ["possession"], have: ["possession"], had: ["possession"], own: ["possession"],

  // ── relational — actions / abilities / desires ──
  is: ["equals"], am: ["equals", "self"], are: ["equals"], be: ["equals"],
  do: ["action"], does: ["action"], did: ["action"], make: ["action"], makes: ["action"],
  build: ["action"], builds: ["action"], create: ["action"], run: ["action"], go: ["action"],
  can: ["ability"], could: ["ability"], able: ["ability"],
  want: ["desire"], wants: ["desire"], need: ["desire"], needs: ["desire"], like: ["preference"],
  must: ["obligation"], should: ["obligation"], will: ["future"], would: ["future"],
  know: ["knowledge"], knows: ["knowledge"], think: ["knowledge"], say: ["communication"],
  said: ["communication", "past"], tell: ["communication"], told: ["communication", "past"],
  see: ["perception"], saw: ["perception", "past"], because: ["causation"], so: ["consequence"],
  if: ["condition"], cause: ["cause"], causes: ["cause"],

  // ── comparison ──
  same: ["similarity"], similar: ["similarity"], different: ["difference"],
  than: ["comparison"], more: ["comparison"], less: ["comparison"], like_: ["similarity"],
  but: ["opposition"], with: ["accompaniment"],

  // ── temporal — WHEN ──
  was: ["past"], were: ["past"], ago: ["past"], yesterday: ["past"], before: ["past"],
  now: ["present"], today: ["present"], currently: ["present"],
  tomorrow: ["future"], soon: ["future"], later: ["future"],

  // ── semantic quality / size / etc. ──
  big: ["size"], small: ["size"], large: ["size"], fast: ["speed"], slow: ["speed"],
  hot: ["temperature"], cold: ["temperature"], old: ["age"], new: ["age", "quality"],
  hard: ["difficulty"], easy: ["difficulty"], good: ["quality"], bad: ["quality"],
  very: ["intensifier"], really: ["intensifier"],
};

export class PrimitiveSpace {
  version = 1;

  /** Roles a word activates. Empty array ⇒ treat as a content word. */
  matchRoles(word: string): string[] {
    return LEXICON[word] ?? [];
  }

  stats(): { words: number; version: number } {
    return { words: Object.keys(LEXICON).length, version: this.version };
  }
}
