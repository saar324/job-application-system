import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProfileStore } from "../src/profile-store.js";
import { JsonStore } from "../src/store.js";
import { ApplicationService } from "../src/service.js";
import { SimulationAdapter } from "../src/adapters/simulation.js";
import { createHttpServer } from "../src/http.js";

const agent = { actorId: "agent", profileId: "person", roles: ["agent"] };
const owner = { actorId: "owner", profileId: "person", roles: ["owner"] };
const policy = { mode: "automatic", modes: ["full_time"], sources: ["agent"],
  destinationHosts: ["example.test"], answerClasses: ["profile_fact", "resume", "link", "grounded_prose"],
  dailyCap: 1, campaignCap: 1 };
const config = { defaultMode: "full_time", execution: { maxApplicationsPerDay: 10 },
  modes: { full_time: { minimumScore: 0, autoApply: false, dailyApplicationCap: 8,
    requireConfirmationFor: [] } } };

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-policy-test-"));
  const profiles = await new ProfileStore(path.join(directory, "profiles.json"), { allowMissing: true }).init();
  await profiles.patch("person", { contact: { firstName: "Ada", lastName: "Lovelace",
    email: "ada@example.test", phone: "+10000000000", location: "Remote" },
  documents: { resume: "/private/resume.pdf" } });
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  const service = new ApplicationService({ store, profiles, config, adapter: new SimulationAdapter() });
  service.enqueue = () => {};
  return { profiles, service };
}

async function prepared(service, extra = {}) {
  const role = await service.addOpportunity({ title: "Engineer", company: "Example",
    applyUrl: "https://example.test/apply", score: 100, ...extra }, agent);
  const application = await service.requestApplication(role.id, {}, agent);
  await service.store.mutate((state) => {
    const item = state.applications.find((entry) => entry.id === application.id);
    item.status = "submitting";
    item.claim = { attemptId: "attempt-one" };
  });
  return application;
}

function decisionInput(application, overrides = {}) {
  return { applicationId: application.id, attemptId: "attempt-one",
    previewFingerprint: "a".repeat(64), preview: { destination: "https://example.test/apply",
      company: "Example", title: "Engineer", filled: [{ label: "Email", value: "ada@example.test",
        source: "profile" }], unfilled: [] }, ...overrides };
}

test("agent profile mutation cannot create standing submission authority", async () => {
  const { profiles, service } = await fixture();
  await assert.rejects(profiles.patch("person", { standingSubmissionPolicy: policy }), /not allowed/);
  await assert.rejects(profiles.setStandingSubmissionPolicy("person", policy, agent), /owner authority/);
  const job = await service.addOpportunity({ title: "Engineer", company: "Example",
    applyUrl: "https://example.test/apply", score: 100 }, agent);
  const application = await service.requestApplication(job.id, {}, agent);
  assert.equal(application.finalApprovalRequired, true);
  assert.equal(application.status, "waiting_confirmation");
});

test("owner policy covers intake and final permit; revocation before commit blocks click", async () => {
  const { profiles, service } = await fixture();
  const enabled = await profiles.setStandingSubmissionPolicy("person", policy, owner);
  assert.equal(enabled.version, 1);
  const application = await prepared(service);
  assert.equal(application.finalApprovalRequired, false);
  assert.equal(application.decision.autoApply, true);
  const input = decisionInput(application);
  const preparedDecision = await service.prepareFinalSubmission(input);
  assert.equal(preparedDecision.decision, "permit");
  await profiles.setStandingSubmissionPolicy("person", { ...policy, mode: "always" }, owner);
  await assert.rejects(service.commitFinalSubmission({ applicationId: application.id,
    attemptId: "attempt-one", previewFingerprint: input.previewFingerprint,
    permit: preparedDecision.permit }), /revoked/);
});

test("changed form and legal declarations hold independently of mode confirmation filters", async () => {
  const { profiles, service } = await fixture();
  await profiles.setStandingSubmissionPolicy("person", policy, owner);
  const application = await prepared(service);
  const changed = await service.prepareFinalSubmission(decisionInput(application, {
    preview: { ...decisionInput(application).preview, destination: "https://other.test/apply" }
  }));
  assert.deepEqual(changed.reasonCodes, ["destination_changed"]);
  const legal = await service.prepareFinalSubmission(decisionInput(application, {
    preview: { ...decisionInput(application).preview, filled: [
      { label: "I agree to the privacy policy", value: "Yes", source: "profile" }] }
  }));
  assert.ok(legal.reasonCodes.includes("legal_answer_unconfirmed"));
});

test("owner cap allows one final attempt and rejects a concurrent second reservation", async () => {
  const { profiles, service } = await fixture();
  await profiles.setStandingSubmissionPolicy("person", policy, owner);
  const first = await prepared(service);
  const secondRole = await service.addOpportunity({ title: "Engineer II", company: "Example",
    applyUrl: "https://example.test/apply/two", score: 100 }, agent);
  const second = await service.requestApplication(secondRole.id, {}, agent);
  await service.store.mutate((state) => {
    const item = state.applications.find((entry) => entry.id === second.id);
    item.status = "submitting";
    item.claim = { attemptId: "attempt-one" };
  });
  assert.equal((await service.prepareFinalSubmission(decisionInput(first))).decision, "permit");
  const secondDecision = await service.prepareFinalSubmission(decisionInput(second, {
    preview: { ...decisionInput(second).preview, title: "Engineer II",
      destination: "https://example.test/apply/two" }
  }));
  assert.ok(secondDecision.reasonCodes.includes("daily_cap_reached"));
});

test("HTTP policy mutation requires owner token bound to its profile", async () => {
  const { profiles, service } = await fixture();
  const httpConfig = { ...config, execution: { ...config.execution, workerCallbackToken: "worker-secret" } };
  const authenticate = (request) => request.headers.authorization === "Bearer owner-secret" ? owner
    : request.headers.authorization === "Bearer agent-secret" ? agent
      : request.headers.authorization === "Bearer other-owner"
        ? { actorId: "other", profileId: "other", roles: ["owner"] } : null;
  const server = createHttpServer({ service, profiles, config: httpConfig,
    discovery: {}, authenticate });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const put = (token) => fetch(`${base}/v1/standing-submission-policy`, { method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(policy) });
  try {
    assert.equal((await put("agent-secret")).status, 403);
    assert.equal((await put("owner-secret")).status, 200);
    const other = await fetch(`${base}/v1/standing-submission-policy`, {
      headers: { authorization: "Bearer other-owner" } });
    assert.equal((await other.json()).policy, null);
    const callback = await fetch(`${base}/v1/internal/final-decision`, { method: "POST",
      headers: { authorization: "Bearer agent-secret", "content-type": "application/json" },
      body: "{}" });
    assert.equal(callback.status, 403);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
