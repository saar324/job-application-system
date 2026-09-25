import assert from "node:assert/strict";
import test from "node:test";
import { browserQueryPlan } from "../src/discovery/browser-query-plan.js";

test("browser search takes an explicit term or a saved title, never a software default", () => {
  assert.deepEqual(browserQueryPlan({}).queries, []);
  assert.deepEqual(browserQueryPlan({ explicitQuery: "  Nurse Practitioner  " }).queries,
    [{ term: "Nurse Practitioner", origin: "explicit" }]);
  const seed = { profile: { preferences: { fullTime: { jobTitles: ["Nurse Practitioner"] } } },
    verifiedSubmittedTitles: [] };
  assert.equal(browserQueryPlan({ seed, maximum: 2 }).queries[0].term, "Nurse Practitioner");
});

test("browser query seed accepts only preferences and rotates without applicant facts", () => {
  const seed = { profile: { preferences: { fullTime: {
    jobTitles: ["Nurse Practitioner", "Clinical Research Manager", "Product Designer"]
  } } }, verifiedSubmittedTitles: [] };
  assert.equal(browserQueryPlan({ seed, searchCycle: 0, maximum: 2 }).queries[0].term,
    "Nurse Practitioner");
  assert.equal(browserQueryPlan({ seed, searchCycle: 1, maximum: 2 }).queries[0].term,
    "Clinical Research Manager");
  assert.throws(() => browserQueryPlan({ seed: { ...seed,
    profile: { ...seed.profile, contact: { email: "person@example.test" } } } }),
  /preference-only/);
});
