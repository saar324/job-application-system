import assert from "node:assert/strict";
import test from "node:test";
import { executeInFreshContext } from "../worker/execution.js";

function fixture(result, failure) {
  let closes = 0;
  const context = {
    async route() {}, async newPage() { return {}; },
    async close() { closes += 1; }
  };
  const browser = { async newContext() { return context; } };
  const urlPolicy = { assertAllowed() {}, async assertPublic() {}, assertNetworkSafe() {} };
  const payload = {
    opportunity: { applyUrl: "https://jobs.example.test/apply", userRequested: true },
    application: {}, profile: { id: "applicant-one" }
  };
  const automate = async () => { if (failure) throw failure; return result; };
  return { browser, urlPolicy, payload, automate, closes: () => closes };
}

for (const status of ["submitted", "needs_input", "needs_human"]) {
  test(`fresh browser context closes after ${status}`, async () => {
    const item = fixture({ status });
    assert.equal((await executeInFreshContext({ ...item, artifactsDirectory: "/tmp" })).status, status);
    assert.equal(item.closes(), 1);
  });
}

test("fresh browser context closes after an automation error", async () => {
  const item = fixture(null, new Error("fixture failure"));
  await assert.rejects(executeInFreshContext({ ...item, artifactsDirectory: "/tmp" }), /fixture failure/);
  assert.equal(item.closes(), 1);
});
