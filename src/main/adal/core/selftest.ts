/**
 * adaL HDC core self-test — proves the fresh substrate recalls by meaning.
 *
 * Not a unit-test framework; a runnable harness. After `npm run build:main`:
 *   node dist/main/adal/core/selftest.js
 * Exits non-zero if any assertion fails.
 */

import { bagOfWords } from "./encode";
import { cosineSimilarity, bind, bundle, generateSymbol } from "./ops";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  const tag = cond ? "  ok  " : " FAIL ";
  // eslint-disable-next-line no-console
  console.log(`[${tag}] ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
}

function approx(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps;
}

// ── ops algebra ───────────────────────────────────────────────────────────
const A = generateSymbol(42, "alpha", 2000);
const B = generateSymbol(42, "beta", 2000);

check("generateSymbol is deterministic", cosineSimilarity(A, generateSymbol(42, "alpha", 2000)) === 1);
check("distinct symbols are near-orthogonal", Math.abs(cosineSimilarity(A, B)) < 0.1,
  `cos=${cosineSimilarity(A, B).toFixed(4)}`);
check("self-cosine is 1.0", approx(cosineSimilarity(A, A), 1));

// bind is its own inverse for bipolar: (A⊗B)⊗B == A
const bound = bind(A, B);
check("bind is invertible", cosineSimilarity(bind(bound, B), A) === 1);
check("bound vector is dissimilar to operands", Math.abs(cosineSimilarity(bound, A)) < 0.1);

// bundle stays similar to its members
const C = generateSymbol(42, "gamma", 2000);
const bundled = bundle([A, B, C]);
check("bundle retains member similarity", cosineSimilarity(bundled, A) > 0.3,
  `cos=${cosineSimilarity(bundled, A).toFixed(4)}`);

// ── recall by meaning ───────────────────────────────────────────────────────
const fact = bagOfWords("my name is chris");
const paraphrase = bagOfWords("chris is my name");
const related = bagOfWords("chris timmerman builds glyphh");
const unrelated = bagOfWords("the weather in tokyo is rainy today");

const simPara = cosineSimilarity(fact, paraphrase);
const simRelated = cosineSimilarity(fact, related);
const simUnrelated = cosineSimilarity(fact, unrelated);

check("paraphrase recalls strongest", simPara > simRelated && simPara > simUnrelated,
  `para=${simPara.toFixed(3)} related=${simRelated.toFixed(3)} unrelated=${simUnrelated.toFixed(3)}`);
check("shared-token beats unrelated", simRelated > simUnrelated,
  `related=${simRelated.toFixed(3)} unrelated=${simUnrelated.toFixed(3)}`);
check("unrelated is near-orthogonal", Math.abs(simUnrelated) < 0.2,
  `unrelated=${simUnrelated.toFixed(3)}`);

// eslint-disable-next-line no-console
console.log(failures === 0 ? "\nadaL core: ALL PASS" : `\nadaL core: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
