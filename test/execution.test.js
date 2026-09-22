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

test("public challenge iframe navigation does not replace the application destination", async () => {
  const item = fixture({ status: "needs_human" });
  const allowed = [];
  const publicUrls = [];
  let handler;
  item.browser.newContext = async () => ({
    async route(_pattern, callback) { handler = callback; },
    async newPage() { return {}; },
    async close() {}
  });
  item.urlPolicy.assertAllowed = (url) => { allowed.push(url); };
  item.urlPolicy.assertPublic = async (url) => { publicUrls.push(url); };
  await executeInFreshContext({ ...item, artifactsDirectory: "/tmp" });
  const navigate = async (url, parentFrame) => {
    let continued = false;
    await handler({
      request: () => ({ url: () => url, isNavigationRequest: () => true,
        frame: () => ({ parentFrame: () => parentFrame }) }),
      continue: async () => { continued = true; },
      abort: async () => { throw new Error("unexpected block"); }
    });
    assert.equal(continued, true);
  };
  await navigate("https://job-boards.greenhouse.io/example", null);
  await navigate("https://www.recaptcha.net/recaptcha/api2/anchor", {});
  assert.deepEqual(allowed, [item.payload.opportunity.applyUrl,
    "https://job-boards.greenhouse.io/example"]);
  assert.deepEqual(publicUrls, [item.payload.opportunity.applyUrl,
    "https://job-boards.greenhouse.io/example", "https://www.recaptcha.net/recaptcha/api2/anchor"]);
});
