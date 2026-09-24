import assert from "node:assert/strict";
import test from "node:test";
import { selectFitReviewCandidates } from "../src/discovery/fit-review-selection.js";

const candidate = (source, index, score, extras = {}) => ({
  source, externalId: `${source}-${index}`, score, matchedSkillCount: 3, ...extras
});

test("fit review spreads bounded slots across sources and score bands", () => {
  const rows = [
    ...Array.from({ length: 20 }, (_, index) => candidate("large", index, 95 - index)),
    ...Array.from({ length: 5 }, (_, index) => candidate("large", index + 20, 50 - index)),
    candidate("large", 25, 38, { matchedSkillCount: 2 }),
    candidate("small", 0, 43, { matchedSkillCount: 2 }),
    candidate("other", 0, 35, { matchedSkillCount: 2 }),
    candidate("other", 1, 40, { hardExclusion: "unrelated occupation" })
  ];
  const chosen = selectFitReviewCandidates(rows, [], 12);
  assert.ok(chosen.length <= 12);
  assert.ok(chosen.some((item) => item.externalId === "large-8"),
    "existing strong-review rows stay visible within the budget");
  assert.ok(chosen.some((item) => item.externalId === "large-25"));
  assert.ok(chosen.some((item) => item.externalId === "small-0"));
  assert.ok(chosen.some((item) => item.externalId === "other-0"));
  assert.ok(!chosen.some((item) => item.externalId === "other-1"));
});

test("low-score configured software roles can enter review with one matched skill", () => {
  const chosen = selectFitReviewCandidates([
    candidate("ashby", 0, 45, { matchedSkillCount: 1, titlePriority: "primary" }),
    candidate("ashby", 1, 45, { matchedSkillCount: 1 }),
    candidate("ashby", 2, 29, { matchedSkillCount: 4 }),
    candidate("ashby", 3, 37, { matchedSkillCount: 0, titlePriority: "primary" })
  ], [], 5);
  assert.deepEqual(chosen.map((item) => item.externalId), ["ashby-0"]);
});

test("lower-score review rows have a per-source cap", () => {
  const rows = ["one", "two", "three"].flatMap((source) =>
    Array.from({ length: 12 }, (_, index) => candidate(source, index, 50 - index)));
  const chosen = selectFitReviewCandidates(rows);
  assert.ok(chosen.length <= 20);
  for (const source of ["one", "two", "three"]) {
    assert.ok(chosen.filter((item) => item.source === source).length <= 3);
  }
});

test("verified skill uncertainty retains a separate capped review reserve", () => {
  const regular = Array.from({ length: 20 }, (_, index) => candidate("source", index, 80 - index));
  const skill = Array.from({ length: 10 }, (_, index) => candidate("source", index + 20, 0,
    { matchedSkillCount: 10 - index, reason: "unverified_required_skill" }));
  const chosen = selectFitReviewCandidates(regular, skill);
  assert.ok(chosen.length <= 20);
  assert.equal(chosen.filter((item) => item.reason === "unverified_required_skill").length, 5);
});

test("specialist fit holds remain visible when the review reserve is crowded", () => {
  const skill = Array.from({ length: 10 }, (_, index) => candidate("source", index, 0,
    { matchedSkillCount: 10 - index, reason: "unverified_required_skill" }));
  const specialist = candidate("source", 20, 78,
    { matchedSkillCount: 2, reason: "unverified_specialization" });
  const chosen = selectFitReviewCandidates([], [...skill, specialist]);
  assert.ok(chosen.length <= 5);
  assert.ok(chosen.some((item) => item.externalId === specialist.externalId));
});
