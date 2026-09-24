import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SourceProgress } from "../src/discovery/source-progress.js";
import { SourceJournal } from "../src/discovery/source-journal.js";
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
  const timeout = summarizeSourceHealth("a", [{ sourceId: "a", timedOut: true,
    exhausted: false, completed: true, requestsMade: 4 }]);
  assert.equal(timeout.status, "timed_out");
  assert.equal(timeout.requestsMade, 4);
  assert.equal(timeout.timedOut, true);
  assert.equal(summarizeSourceHealth("a", [{ sourceId: "a", challenge: true, completed: true }]).status,
    "challenge");
  assert.equal(summarizeSourceHealth("a", [{ sourceId: "a", parseDrift: true, completed: true }]).status,
    "parse_drift");
  const capped = summarizeSourceHealth("a", [{ sourceId: "a", completed: true,
    partialReasons: ["partial_page_cap"], exhausted: false, requestsMade: 3 }]);
  assert.equal(capped.status, "partial_cap");
  assert.equal(capped.exhausted, false);
  assert.deepEqual(capped.partialReasons, ["partial_page_cap"]);
  const browserCapped = summarizeSourceHealth("browser", [{ sourceId: "browser",
    completed: true, stopReason: "listing_page_cap", partialReasons: ["listing_page_cap"],
    exhausted: false, queryStats: [{ term: "software", pages: 5, rawRows: 100 }] }]);
  assert.equal(browserCapped.status, "partial_cap");
  assert.equal(browserCapped.stopReason, "listing_page_cap");
  assert.equal(browserCapped.queryStats[0].rawRows, 100);
  assert.equal(summarizeSourceHealth("a", [{ sourceId: "a", completed: true,
    sourceFailure: true, exhausted: false }]).status, "partial_error");
  assert.equal(summarizeSourceHealth("a", [{ sourceId: "a", found: 3, handledFiltered: 3,
    completed: true }]).status, "already_handled");
  const official = summarizeSourceHealth("ats", [{ sourceId: "ats", found: 3, excluded: 3,
    exclusionCounts: { hardExclusion: 1, belowScore: 2 }, completed: true }]);
  assert.equal(official.status, "ineligible");
  assert.deepEqual(official.exclusionCounts, {
    hardExclusion: 1, belowScore: 2, opportunisticRequirements: 0 });
});

test("a timed-out source reports observed candidates with the terminal timeout", async () => {
  const reports = [];
  const progress = new SourceProgress({ sourceId: "slow", report: async (sourceId, items, metadata) => {
    reports.push({ sourceId, items, metadata });
    return { sourceCoverage: { scans: [] } };
  } });
  await progress.add([job(1)]);
  await progress.finish({ timedOut: true, exhausted: false, requestsMade: 3 });
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0].items, [job(1)]);
  assert.equal(reports[0].metadata.timedOut, true);
  assert.equal(reports[0].metadata.exhausted, false);
});

test("an unsuccessful source report leaves observed candidates available for retry", async () => {
  let calls = 0;
  const progress = new SourceProgress({ sourceId: "slow", maxBatch: 1,
    report: async () => {
      calls += 1;
      if (calls === 1) throw new Error("temporary report failure");
      return { sourceCoverage: { scans: [] } };
    } });
  await assert.rejects(progress.add([job(1)]), /temporary report failure/);
  assert.deepEqual(progress.pending, [job(1)]);
  await progress.finish({ timedOut: true });
  assert.deepEqual(progress.pending, []);
});

test("a crashed reporter restores observed candidates from its private journal", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "source-journal-test-"));
  try {
    const journal = new SourceJournal({ campaignId: "campaign-1", sourceId: "board",
      directory });
    const failed = new SourceProgress({ sourceId: "board", maxBatch: 1, journal,
      report: async () => { throw new Error("reporter exited"); } });
    await assert.rejects(failed.add([job(1)]), /reporter exited/);
    assert.deepEqual(await journal.load(), [job(1)]);
    assert.equal((await stat(journal.file)).mode & 0o777, 0o600);
    const reports = [];
    const restarted = new SourceProgress({ sourceId: "board", maxBatch: 1, journal,
      pending: await journal.load(), report: async (_source, items, metadata) => {
        reports.push({ items, metadata });
        return { sourceCoverage: { scans: [] } };
      } });
    await restarted.flush();
    await restarted.finish({ exhausted: false, sourceFailure: true });
    assert.deepEqual(reports[0].items, [job(1)]);
    assert.equal(reports.at(-1).metadata.completed, true);
    assert.deepEqual(await journal.load(), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
