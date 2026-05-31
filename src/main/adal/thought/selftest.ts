/**
 * adaL substrate self-test — absorb facts, recall by meaning, version drift.
 * After `npm run build:main`:  node dist/main/adal/thought/selftest.js
 */

import { ThoughtGlyphSpace, ThoughtStore, ThoughtRow } from "./space";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  // eslint-disable-next-line no-console
  console.log(`[${cond ? "  ok  " : " FAIL "}] ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
}

// Pure-JS store so the test runs under plain `node` (better-sqlite3 is built
// for Electron's ABI). The SqliteThoughtStore implements the same interface and
// is exercised at runtime under Electron.
class MemoryThoughtStore implements ThoughtStore {
  private rows = new Map<string, ThoughtRow>();
  upsert(row: ThoughtRow): void {
    this.rows.set(row.thoughtId, JSON.parse(JSON.stringify(row)) as ThoughtRow);
  }
  delete(id: string): void {
    this.rows.delete(id);
  }
  loadAll(): ThoughtRow[] {
    return [...this.rows.values()].map((r) => JSON.parse(JSON.stringify(r)) as ThoughtRow);
  }
}

const store = new MemoryThoughtStore();
const space = new ThoughtGlyphSpace(undefined, store);

space.absorb("my name is chris", "incoming");
space.absorb("chris builds glyphh", "incoming");
space.absorb("the capital of france is paris", "incoming");
space.absorb("water boils at one hundred degrees", "incoming");

check("absorbed 4 thoughts", space.count === 4, `count=${space.count}`);
check("dedup rejects exact repeat", space.absorb("my name is chris") === null);

const nameHits = space.recall("what is my name", 3);
check("name query recalls a chris fact",
  nameHits.length > 0 && /chris/.test(nameHits[0].thought.content),
  nameHits.map((r) => `${r.similarity.toFixed(2)}:${r.thought.content}`).join(" | "));

const geoHits = space.recall("which city is the capital of france", 3);
check("geo query recalls paris fact",
  geoHits.length > 0 && /paris/.test(geoHits[0].thought.content),
  geoHits.map((r) => `${r.similarity.toFixed(2)}:${r.thought.content}`).join(" | "));

// Versioned drift.
space.absorb("ada runs on port 8000", "incoming", {}, "ada.port");
space.absorb("ada runs on port 9000", "incoming", {}, "ada.port");
space.absorb("ada runs on port 9000 with tls", "incoming", {}, "ada.port");
const d = space.drift("ada.port");
check("drift tracks 3 versions", d.versions === 3, `versions=${d.versions}`);
check("drift rate is in [0,1]", (d.driftRate ?? -1) >= 0 && (d.driftRate ?? 2) <= 1,
  `driftRate=${d.driftRate?.toFixed(3)}`);

// Persistence round-trip: new space over same store re-hydrates + re-encodes.
const space2 = new ThoughtGlyphSpace(undefined, store);
check("re-hydrated from store", space2.count === space.count, `count=${space2.count}`);
const rehit = space2.recall("what is my name", 1);
check("recall works after re-hydrate", rehit.length > 0 && /chris/.test(rehit[0].thought.content));

// eslint-disable-next-line no-console
console.log(failures === 0 ? "\nadaL substrate: ALL PASS" : `\nadaL substrate: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
