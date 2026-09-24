import assert from "node:assert/strict";
import test from "node:test";
import { searchTitleQueryPlan, searchTitleQueries } from "../src/discovery/search-title-queries.js";

test("lexical plan reserves a broad probe and keeps historical titles as retrieval only", () => {
  const profile = { preferences: { fullTime: { jobTitles: ["Orbit Engineer"] } } };
  const plan = searchTitleQueryPlan(profile,
    ["Senior Quantum Pipeline Engineer", "Senior Quantum Pipeline Engineer",
      "Unverified Application"], { maximum: 5 });
  assert.deepEqual(plan.queries.slice(0, 3).map((query) => query.term),
    ["Orbit Engineer", "Quantum Pipeline Engineer", "Orbit Developer"]);
  assert.equal(plan.queries.at(-1).origin, "broad_probe");
  assert.equal(plan.queries.at(-1).term, "software");
  assert.equal(plan.queries[1].origin, "verified_history");
  assert.ok(!plan.queries.some((query) => query.term === "Unverified Application"));
});

test("three cycles cover all configured title families within the query budget", () => {
  const titles = Array.from({ length: 15 }, (_, index) => `Area ${index} Engineer`);
  const profile = { preferences: { fullTime: { jobTitles: titles } } };
  const plans = [0, 1, 2].map((cycle) => searchTitleQueryPlan(profile, [],
    { maximum: 6, cycle }));
  const union = new Set(plans.flatMap((plan) => plan.queries.map((query) => query.term)));
  assert.ok(titles.every((title) => union.has(title)));
  assert.ok(plans.every((plan) => plan.queries.length <= 6
    && plan.queries.some((query) => query.origin === "broad_probe")
    && plan.coverageBlocked === false));
  assert.deepEqual(plans.map((plan) => plan.broadProbe), ["software", "developer", "engineer"]);
});

test("impossible three-cycle coverage is surfaced instead of silently dropping terms", () => {
  const profile = { preferences: { fullTime: { jobTitles:
    Array.from({ length: 16 }, (_, index) => `Area ${index} Engineer`) } } };
  const plan = searchTitleQueryPlan(profile, [], { maximum: 6, cycle: 0 });
  assert.equal(plan.coverageBlocked, true);
  assert.ok(plan.skippedTerms.some((entry) => entry.reason === "three_cycle_budget"));
  assert.equal(plan.queries.length, 6);
});

test("equivalent hyphen and space spellings do not consume multiple slots", () => {
  const profile = { preferences: { fullTime: { jobTitles: [
    "Full-stack Programmer", "Fullstack Programmer", "Back-end Programmer", "Backend Programmer"
  ] } } };
  const plan = searchTitleQueryPlan(profile, [], { maximum: 8 });
  assert.equal(plan.configuredFamilyCount, 2);
  assert.ok(searchTitleQueries(profile).includes("Full-stack Programmer"));
  assert.ok(!searchTitleQueries(profile).includes("Fullstack Programmer"));
});

test("no configured or verified titles never invent a search", () => {
  assert.deepEqual(searchTitleQueries({ preferences: { fullTime: { jobTitles: [] } } }), []);
});

test("a non-software preference does not produce a software broad probe", () => {
  const plan = searchTitleQueryPlan({ preferences: { fullTime: {
    jobTitles: ["Technical Writer"] } } }, [], { maximum: 3 });
  assert.deepEqual(plan.queries.map((query) => query.term), ["Technical Writer"]);
  assert.equal(plan.broadProbe, null);
});
