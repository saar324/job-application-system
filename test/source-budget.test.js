import assert from "node:assert/strict";
import test from "node:test";
import { SourceBudget, SourceTimeoutError } from "../src/discovery/source-budget.js";

test("source budget caps slow operations and later calls at one deadline", async () => {
  const budget = new SourceBudget(25);
  await assert.rejects(budget.run(() => new Promise(() => {})), SourceTimeoutError);
  assert.equal(budget.remainingMs(), 0);
  await assert.rejects(budget.run(() => Promise.resolve("late")), SourceTimeoutError);
});

test("host delay and shorter per-navigation timeout share the source deadline", () => {
  let now = 100;
  const budget = new SourceBudget(50, () => now);
  assert.equal(budget.timeoutMs(15), 15);
  now = 140;
  assert.equal(budget.timeoutMs(15), 10);
  now = 151;
  assert.throws(() => budget.timeoutMs(15), SourceTimeoutError);
});

test("per-host delay cannot overrun the source budget", async () => {
  const budget = new SourceBudget(15);
  await assert.rejects(budget.sleep(40), SourceTimeoutError);
  assert.ok(budget.remainingMs() <= 1);
});
