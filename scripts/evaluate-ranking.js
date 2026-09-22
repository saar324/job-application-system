#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { scoreOpportunity } from "../src/discovery/scoring.js";

const file = path.resolve(process.argv[2] ?? "./test/fixtures/ranking-evaluation.json");
const corpus = JSON.parse(await readFile(file, "utf8"));
const started = performance.now();
const cases = corpus.map((entry) => {
  const actual = scoreOpportunity(entry.opportunity, entry.profile, "full_time");
  const matched = JSON.stringify(actual.scoreDetails.matchedSkills) === JSON.stringify(entry.expected.matchedSkills);
  const excluded = Boolean(actual.scoreDetails.hardExclusion) === entry.expected.hardExcluded;
  return { id: entry.id, passed: matched && excluded, matchedSkills: actual.scoreDetails.matchedSkills,
    hardExclusion: actual.scoreDetails.hardExclusion, score: actual.score };
});
const passed = cases.filter((entry) => entry.passed).length;
const report = { scorerVersion: "2.0.0", cases: cases.length, passed,
  accuracy: cases.length ? passed / cases.length : 1, latencyMs: performance.now() - started, results: cases };
console.log(JSON.stringify(report, null, 2));
if (passed !== cases.length) process.exitCode = 1;
