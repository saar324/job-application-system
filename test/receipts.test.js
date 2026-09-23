import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ReceiptStore } from "../worker/receipts.js";

function payload(url = "https://example.test/apply") {
  return {
    application: { id: "application-one", opportunityId: "opportunity-one", profileId: "person-one" },
    profile: { id: "person-one" },
    opportunity: { id: "opportunity-one", applyUrl: url, dedupKey: "job:one" }
  };
}

test("receipt store serializes in-flight requests and reuses persisted results", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-receipts-test-"));
  const store = new ReceiptStore(directory);
  let attempts = 0;
  const submit = async () => {
    attempts += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { status: "submitted", receipt: { submittedAt: "now", finalUrl: "https://example.test/done" } };
  };
  const [first, second] = await Promise.all([store.run(payload(), submit), store.run(payload(), submit)]);
  const third = await new ReceiptStore(directory).run(payload(), submit);
  assert.equal(attempts, 1);
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
});

test("receipt store rejects reuse of an application ID with changed payload", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-receipts-test-"));
  const store = new ReceiptStore(directory);
  await store.run(payload(), async () => ({ status: "submitted", receipt: { submittedAt: "now", finalUrl: "done" } }));
  const conflict = await store.run(payload("https://example.test/other"), async () => { throw new Error("must not execute"); });
  assert.equal(conflict.status, "needs_human");
  assert.equal(conflict.requirements[0].kind, "idempotency_conflict");
});

test("attempt status exposes a late active run and its durable receipt", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-receipts-test-"));
  const store = new ReceiptStore(directory);
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  const running = store.run(payload(), async () => {
    await gate;
    return { status: "submitted", receipt: { submittedAt: "now", finalUrl: "https://example.test/done" } };
  });
  assert.equal((await store.status("application-one")).status, "active");
  finish();
  await running;
  assert.equal((await new ReceiptStore(directory).status("application-one")).status, "submitted");
});

test("a crashed pre-final attempt remains distinguishable from a started final action", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-receipts-test-"));
  const store = new ReceiptStore(directory);
  await assert.rejects(store.run(payload(), async () => { throw new Error("browser crashed during preparation"); }));
  assert.equal((await new ReceiptStore(directory).status("application-one")).status, "before_final_action");
  await assert.rejects(store.run(payload(), async (markFinalActionStarted) => {
    await markFinalActionStarted();
    throw new Error("browser crashed after final action began");
  }));
  assert.equal((await new ReceiptStore(directory).status("application-one")).status, "final_action_started");
  let retried = false;
  const fenced = await new ReceiptStore(directory).run(payload(), async () => { retried = true; });
  assert.equal(retried, false);
  assert.equal(fenced.requirements[0].kind, "submission_unverified");
});

test("safe pre-final replay obtains a fresh decision and a lost response reuses the durable receipt", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-receipts-test-"));
  const store = new ReceiptStore(directory);
  let decisions = 0;
  let clicks = 0;
  const first = await store.run(payload(), async () => {
    decisions += 1;
    return { status: "needs_input", requirements: [{ kind: "missing_answer" }] };
  });
  assert.equal(first.status, "needs_input");
  assert.equal((await store.status("application-one")).status, "before_final_action");
  // Simulate the caller losing the successful HTTP response after the receipt
  // was durably written. A new worker process must return it without a click.
  await new ReceiptStore(directory).run(payload(), async (markFinalActionStarted) => {
    decisions += 1;
    await markFinalActionStarted();
    clicks += 1;
    return { status: "submitted", receipt: { submittedAt: "now",
      finalUrl: "https://example.test/done" } };
  });
  const recovered = await new ReceiptStore(directory).run(payload(), async () => {
    clicks += 1;
    throw new Error("must not click again");
  });
  assert.equal(decisions, 2);
  assert.equal(clicks, 1);
  assert.equal(recovered.status, "submitted");
});
