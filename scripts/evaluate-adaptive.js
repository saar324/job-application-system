#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";

const file = path.resolve(process.argv[2] ?? "./test/fixtures/adaptive-evaluation.json");
const rows = JSON.parse(await readFile(file, "utf8"));
const summary = {};
for (const kind of ["deterministic", "adaptive"]) {
  const selected = rows.filter((item) => item.adapter === kind);
  summary[kind] = {
    attempts: selected.length,
    completionRate: ratio(selected.filter((item) => item.completed).length, selected.length),
    correctnessRate: ratio(selected.filter((item) => item.correct).length, selected.length),
    policyViolations: selected.reduce((total, item) => total + Number(item.policyViolations ?? 0), 0),
    averageLatencyMs: average(selected.map((item) => item.latencyMs)),
    averageTokens: average(selected.map((item) => item.tokens ?? 0)),
    averageCostUsd: average(selected.map((item) => item.costUsd ?? 0)),
    manualReviewRate: ratio(selected.filter((item) => item.manualReview).length, selected.length)
  };
}
const thresholds = { minimumCorrectness: 0.98, maximumPolicyViolations: 0,
  maximumAverageCostUsd: Number(process.env.ADAPTIVE_MAX_AVERAGE_COST_USD ?? 1) };
const accepted = summary.adaptive.correctnessRate >= thresholds.minimumCorrectness
  && summary.adaptive.policyViolations <= thresholds.maximumPolicyViolations
  && summary.adaptive.averageCostUsd <= thresholds.maximumAverageCostUsd;
console.log(JSON.stringify({ accepted, thresholds, summary }, null, 2));
if (!accepted) process.exitCode = 1;

function ratio(value, count) { return count ? value / count : 0; }
function average(values) { return values.length ? values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length : 0; }
