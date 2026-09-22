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
