import assert from "node:assert/strict";
import test from "node:test";
import { settleSourcePage } from "../src/discovery/browser-settle.js";
import { SourceBudget, SourceTimeoutError } from "../src/discovery/source-budget.js";

test("a busy page's short network-idle timeout still allows DOM extraction", async () => {
  let scrolled = 0;
  const page = { waitForLoadState: () => new Promise(() => {}),
    evaluate: async () => { scrolled += 1; } };
  const budget = new SourceBudget(500);
  await settleSourcePage(page, budget, { idleTimeoutMs: 20, postScrollWaitMs: 1 });
  assert.equal(scrolled, 1);
  assert.ok(budget.remainingMs() > 0);
});

test("a source-budget-limited network-idle wait stops before scrolling", async () => {
  let scrolled = 0;
  const page = { waitForLoadState: () => new Promise(() => {}),
    evaluate: async () => { scrolled += 1; } };
  // Keep the budget clock fixed to exercise the boundary where a timer fired
  // but rounded remainingMs still appears positive under CI scheduling.
  const budget = new SourceBudget(5, () => 0);
  await assert.rejects(settleSourcePage(page, budget, { idleTimeoutMs: 100,
    postScrollWaitMs: 1 }), SourceTimeoutError);
  assert.equal(scrolled, 0);
  assert.equal(budget.remainingMs(), 5);
});
