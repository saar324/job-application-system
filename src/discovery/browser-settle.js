import { SourceTimeoutError } from "./source-budget.js";

// A busy page may never become network-idle. That short wait is a settling
// hint, not the source's wall-clock deadline.
export async function settleSourcePage(page, budget, { idleTimeoutMs = 1_500,
  postScrollWaitMs = 250 } = {}) {
  const idleTimeoutIsOnlyAHint = budget.remainingMs() > idleTimeoutMs;
  await budget.run(() => page.waitForLoadState("networkidle",
    { timeout: budget.timeoutMs(idleTimeoutMs) }), idleTimeoutMs).catch((error) => {
    if (error instanceof SourceTimeoutError
      && (!idleTimeoutIsOnlyAHint || budget.remainingMs() <= 0)) throw error;
  });
  await budget.run(() => page.evaluate(() => window.scrollTo(0,
    Math.min(document.body.scrollHeight, 4000)))).catch((error) => {
    if (error instanceof SourceTimeoutError) throw error;
  });
  await budget.sleep(postScrollWaitMs);
}
