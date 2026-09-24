import assert from "node:assert/strict";
import test from "node:test";
import { selectSemanticCandidateIndexes } from "../src/discovery/semantic-candidate-selection.js";

function candidate(index, score, rolePriority, hardExclusion = null) {
  return { index, result: { score, scoreDetails: { rolePriority, hardExclusion } } };
}

test("semantic budget includes below-threshold and opportunistic roles", () => {
  const ranked = [
    ...Array.from({ length: 30 }, (_, index) => candidate(index, 100 - index, "primary")),
    ...Array.from({ length: 12 }, (_, index) => candidate(index + 30, 70 - index, "opportunistic")),
    ...Array.from({ length: 20 }, (_, index) => candidate(index + 42, 55 - index, undefined)),
    candidate(62, 0, "primary", "verified residence restriction")
  ];
  const selected = selectSemanticCandidateIndexes(ranked, 20, 75);
  assert.equal(selected.size, 20);
  assert.ok([...selected].some((index) => index >= 30 && index < 42));
  assert.ok([...selected].some((index) => index >= 42 && index < 62));
  assert.ok([...selected].some((index) => index >= 52 && index < 62),
    "sample should reach beyond the highest rejected scores");
  assert.equal(selected.has(62), false);
});

test("semantic budget fills unused groups without exceeding its limit", () => {
  const selected = selectSemanticCandidateIndexes(
    Array.from({ length: 12 }, (_, index) => candidate(index, 90 - index, "primary")), 5, 75);
  assert.equal(selected.size, 5);
  assert.equal(selectSemanticCandidateIndexes([], 20, 75).size, 0);
  assert.equal(selectSemanticCandidateIndexes([candidate(0, 50)], 0, 75).size, 0);
  const small = selectSemanticCandidateIndexes([
    candidate(0, 90, "primary"), candidate(1, 70, "opportunistic"),
    candidate(2, 50, undefined)
  ], 3, 75);
  assert.deepEqual([...small].sort(), [0, 1, 2]);
});
