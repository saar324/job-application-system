import assert from "node:assert/strict";
import test from "node:test";
import { SourceProgress } from "../src/discovery/source-progress.js";
import { summarizeSourceHealth } from "../src/discovery/source-health.js";

function job(id, extra = {}) {
  return { externalId: String(id), title: "Senior Engineer", company: "Acme",
    applyUrl: `https://careers.acme.test/apply/${id}`, ...extra };
}

test("scanner continues to later pages until ten server-accepted roles, ignoring raw and duplicate rows", async () => {
  const scans = [];
  const progress = new SourceProgress({ sourceId: "board", maxBatch: 10, report: async (sourceId, items, metadata) => {
    const remaining = 10 - scans.reduce((sum, scan) => sum + scan.selected, 0);
    scans.push({ sourceId, found: items.length,
      selected: Math.min(remaining, items.filter((item) => item.accepted).length),
      completed: metadata.completed });
    return { sourceCoverage: { scans } };
  } });
  let pagesVisited = 0;
  for (const page of [
    Array.from({ length: 25 }, (_, i) => job(i, { accepted: false })),
    [job(0, { accepted: true }), ...Array.from({ length: 7 }, (_, i) => job(100 + i, { accepted: true }))],
    Array.from({ length: 12 }, (_, i) => job(200 + i, { accepted: true })),
    [job(300, { accepted: true })]
  ]) {
    pagesVisited += 1;
    await progress.add(page);
    await progress.flush();
    if (progress.done) break;
  }
  await progress.finish({ pagesVisited, requestsMade: pagesVisited, exhausted: false });
  assert.equal(pagesVisited, 3);
  assert.equal(progress.accepted, 10);
  assert.equal(progress.found, 42);
  assert.equal(scans.at(-1).completed, true);
  assert.equal(scans.at(-1).found, 0);
});

test("source health separates rate limits, challenges, missing destinations and zero yield", () => {
  assert.equal(summarizeSourceHealth("a", [{ sourceId: "a", found: 0, completed: true }]).status,
    "zero_extractable");
  assert.equal(summarizeSourceHealth("a", [{ sourceId: "a", found: 2, destinationPending: 2,
    completed: true }]).status, "missing_destination");
  assert.equal(summarizeSourceHealth("a", [{ sourceId: "a", rateLimited: true, completed: true }]).status,
    "rate_limited");
  assert.equal(summarizeSourceHealth("a", [{ sourceId: "a", challenge: true, completed: true }]).status,
    "challenge");
  assert.equal(summarizeSourceHealth("a", [{ sourceId: "a", parseDrift: true, completed: true }]).status,
    "parse_drift");
  assert.equal(summarizeSourceHealth("a", [{ sourceId: "a", found: 3, handledFiltered: 3,
    completed: true }]).status, "already_handled");
  const official = summarizeSourceHealth("ats", [{ sourceId: "ats", found: 3, excluded: 3,
    exclusionCounts: { hardExclusion: 1, belowScore: 2 }, completed: true }]);
  assert.equal(official.status, "ineligible");
  assert.deepEqual(official.exclusionCounts, {
    hardExclusion: 1, belowScore: 2, opportunisticRequirements: 0 });
});
