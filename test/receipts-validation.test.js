import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ReceiptStore } from "../worker/receipts.js";

test("explicit field rejection permits a corrected attempt; an uncertain click does not", async () => {
  const store = new ReceiptStore(await mkdtemp(path.join(os.tmpdir(), "job-receipts-test-")));
  const payload = (id) => ({ application: { id }, profile: { id: "one" }, opportunity: { id: "job" } });
  const rejected = await store.run(payload("rejected"), async (mark) => {
    await mark();
    return { status: "needs_input", phase: "before_final_action", validationRejected: true };
  });
  assert.equal(rejected.status, "needs_input");
  assert.equal((await store.status("rejected")).status, "before_final_action");
  const submitted = await store.run(payload("rejected"), async (mark) => {
    await mark();
    return { status: "submitted", receipt: { submittedAt: "2026-09-27T00:00:00Z",
      finalUrl: "https://example.test/success" } };
  });
  assert.equal(submitted.status, "submitted");
  await store.run(payload("uncertain"), async (mark) => {
    await mark();
    return { status: "needs_human", phase: "final_action_started" };
  });
  assert.equal((await store.status("uncertain")).status, "final_action_started");
});
