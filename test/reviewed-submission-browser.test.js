import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { automateApplication } from "../worker/automation.js";
import { createHttpServer } from "../src/http.js";
import { ApplicationService } from "../src/service.js";
import { ProfileStore } from "../src/profile-store.js";
import { DiscoveryService } from "../src/discovery/service.js";
import { JsonStore } from "../src/store.js";
import { NeedsInputError, NeedsReviewError } from "../src/adapters/errors.js";

// Real browser + authenticated final API + durable state. Employer transport is
// route-served synthetic HTTPS; production egress/worker process needs deploy smoke.
const agent = { actorId: "fixture-reviewer", profileId: "fixture", roles: ["agent"] };
const owner = { actorId: "fixture-owner", profileId: "fixture", roles: ["owner"] };
const roleId = "11111111-1111-4111-8111-111111111111";
const destination = `https://jobs.ashbyhq.com/fixture/${roleId}/application`;
const html = (legal = false, privacy = false, mixed = false) => `<form onsubmit="event.preventDefault();window.submits=(window.submits||0)+1;document.body.innerHTML='<h2>Application received</h2><p>Your application was successfully submitted.</p>'">
<label>Email<input name="email" type="email" required></label>
<label>Why this role?<textarea name="motivation" required></textarea></label>
${privacy ? `<label>${mixed ? "Privacy consent and indemnification" : "I consent to recruitment privacy retention"}<input id="${mixed ? "terms_waiver" : "privacy"}" name="${mixed ? "terms_waiver" : "privacy"}" type="checkbox" required></label>` : ""}
${legal ? '<label>I accept unlimited liability<input name="liability" type="checkbox" required></label>' : ''}
<button type="submit">Submit Application</button></form>`;

async function fixture(t, { legal = false, changeBeforeFinal = false, privacy = false, mixed = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "joined-reviewed-browser-"));
  const browser = await chromium.launch({ headless: true });
  const profiles = await new ProfileStore(path.join(directory, "profiles.json"), { allowMissing: true }).init();
  await profiles.patch("fixture", { contact: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.test", phone: "+10000000000", location: "Remote" },
    documents: { resume: "/synthetic/resume.pdf" }, applicationAnswers: { motivation: "I build reliable TypeScript services.", recruitmentPrivacy: true, unrelatedEmployment: "Yes" }, skills: ["TypeScript"] });
  await profiles.setStandingSubmissionPolicy("fixture", { mode: "automatic", modes: ["full_time"], sources: ["ashby"], destinationHosts: ["jobs.ashbyhq.com"],
    answerClasses: ["profile_fact", "grounded_prose", "link", "resume"], dailyCap: 5, campaignCap: 5 }, owner);
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  const config = { defaultMode: "full_time", execution: { maxApplicationsPerDay: 10, workerCallbackToken: "synthetic-worker-token" },
    discovery: { sourceOptions: { ashby: { boards: [{ slug: "fixture", company: "Fixture Employer" }] } } },
    modes: { full_time: { minimumScore: 0, autoApply: false, dailyApplicationCap: 8, requireConfirmationFor: [] } } };
  let base;
  let submits = 0;
  let permitCalls = 0;
  let commitCalls = 0;
  let mutate = false;
  let latestPreview;
  const errors = [];
  const timings = [];
  async function request(route, body, token = "synthetic-agent-token") {
    const response = await fetch(`${base}${route}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const value = await response.json();
    return { status: response.status, value };
  }
  const adapter = { name: "joined-browser-fixture", async submit(payload) {
    const started = performance.now();
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.route("https://jobs.ashbyhq.com/**", route => route.fulfill({ status: 200, contentType: "text/html", body: html(legal, privacy, mixed) }));
    try {
      const result = await automateApplication({ page, ...payload, artifactsDirectory: directory,
        authorizeFinal: async input => {
          permitCalls += 1;
          latestPreview = input;
          if (changeBeforeFinal && mutate) await page.locator("textarea").fill("Unreviewed changed content");
          const response = await request("/v1/internal/final-decision", input, "synthetic-worker-token");
          assert.equal(response.status, 200);
          return response.value;
        },
        commitFinal: async input => {
          commitCalls += 1;
          const response = await request("/v1/internal/final-commit", input, "synthetic-worker-token");
          if (response.status !== 200) throw new Error(response.value.error);
          return response.value;
        },
        markFinalActionStarted: async () => { submits += 1; }
      });
      timings.push({ elapsedMs: performance.now() - started, ...result.metrics });
      if (result.status === "submitted") return { ...result.receipt, simulated: true, metrics: result.metrics ?? result.receipt.metrics };
      if (result.status === "needs_input") throw new NeedsInputError(result.message, result.requirements, result);
      throw new NeedsReviewError(result.message, result.requirements, result);
    } finally { await context.close(); }
  } };
  const service = new ApplicationService({ store, profiles, config, adapter });
  service.enqueue = () => {};
  const description = "TypeScript engineering. Fully remote worldwide.";
  const officialJob = { id: roleId, title: "TypeScript Engineer", applyUrl: destination, jobUrl: destination.replace("/application", ""),
    descriptionPlain: description, location: "Remote worldwide", isRemote: true, isListed: true, employmentType: "Full-Time" };
  const discovery = new DiscoveryService({ applicationService: service, profiles, config,
    fetchImpl: async () => new Response(JSON.stringify({ jobs: [officialJob] })) });
  const server = createHttpServer({ service, discovery, profiles, config, authenticate: request => {
    if (request.headers.authorization === "Bearer synthetic-agent-token") return agent;
    if (request.headers.authorization === "Bearer synthetic-other-token") return { ...agent, profileId: "other" };
    return null;
  } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await browser.close(); await rm(directory, { recursive: true, force: true }); });
  const considered = await request("/v1/discovery/consider", { candidate: {
    title: officialJob.title, company: "Fixture Employer", source: "ashby", description,
    applyUrl: destination, location: "Remote worldwide", remote: true },
    fit: { decision: "relevant", reason: "Synthetic complete official listing requires TypeScript; profile verifies TypeScript and worldwide remote eligibility." }, apply: false });
  assert.equal(considered.status, 200);
  assert.equal(considered.value.status, "ready", JSON.stringify(considered.value));
  const role = { id: considered.value.opportunityId };
  const application = await service.requestApplication(role.id, { answers: { motivation: "I build reliable TypeScript services.", ...(legal ? { liability: true, "I accept unlimited liability": true } : {}), ...(privacy ? { [mixed ? "terms_waiver" : "privacy"]: true } : {}) } }, agent);
  return { service, profiles, request, application, timings, errors, setMutation: () => { mutate = true; },
    counters: () => ({ submits, permitCalls, commitCalls }), latest: () => latestPreview,
    pending: () => service.list("confirmations", "fixture").find(item => item.status === "pending") };
}

function review(confirmation) {
  return { approved: true, review: { previewFingerprint: confirmation.previewFingerprint,
    authorizationSource: "synthetic owner delegation for exact professional review",
    fields: confirmation.preview.filled.filter(field => field.source === "application answer").map(field => ({
      step: field.step ?? 0, key: field.key, answerClass: "profile_fact", sourceKind: "saved_profile_fact",
      sourceReference: "synthetic verified profile.applicationAnswers.motivation", profileAnswerKey: "motivation"
    })) } };
}

test("joined authenticated review reaches one browser receipt and never counts as a real pilot receipt", async t => {
  const f = await fixture(t);
  await f.service.execute(f.application.id);
  const hold = f.pending();
  assert.equal(hold.kind, "final_policy_hold", JSON.stringify(hold));
  assert.equal(f.counters().submits, 0);
  assert.ok(hold.previewFingerprint);
  assert.ok(hold.preview.filled.some(field => field.key === "motivation"));
  const rejected = await f.request(`/v1/confirmations/${hold.id}`, review(hold), "synthetic-other-token");
  assert.equal(rejected.status, 404);
  const accepted = await f.request(`/v1/confirmations/${hold.id}`, review(hold));
  assert.equal(accepted.status, 200, JSON.stringify(accepted.value));
  await f.service.execute(f.application.id);
  const saved = f.service.list("applications", "fixture").find(item => item.id === f.application.id);
  assert.equal(saved.status, "submitted");
  assert.equal(saved.receipt.simulated, true);
  assert.ok(saved.receipt.submittedAt);
  assert.equal(f.counters().submits, 1);
  assert.equal(f.counters().commitCalls, 1);
  assert.deepEqual(f.errors, []);
  assert.equal(f.timings.length, 2);
  assert.ok(f.timings.every(sample => sample.elapsedMs > 0));
  const attempts = f.service.list("attempts", "fixture");
  assert.equal(attempts.length, 2);
  assert.ok(attempts.every(attempt => Number.isFinite(attempt.queueMs) && attempt.queueMs >= 0));
  const metrics = f.service.applicationMetrics("fixture");
  assert.equal(metrics.queue.samples, 2);
  assert.equal(metrics.execution.samples, 2);
  assert.equal(metrics.ownerWait.samples, 1);
  assert.ok(metrics.ownerWait.medianMs >= 0);
  assert.equal(metrics.worker.activeMs.samples, 2);
  assert.equal(f.service.applicationMetrics("other").attempts, 0);
  t.diagnostic(JSON.stringify({ pipelineMetrics: metrics, fixtureOnly: true, realReceipts: 0, elapsedSamplesMs: f.timings.map(sample => sample.elapsedMs), submits: 1 }));
});

test("joined browser invalidates an answer changed while final authorization is in flight", async t => {
  const f = await fixture(t, { changeBeforeFinal: true });
  await f.service.execute(f.application.id);
  const hold = f.pending();
  assert.equal((await f.request(`/v1/confirmations/${hold.id}`, review(hold))).status, 200);
  f.setMutation();
  await f.service.execute(f.application.id);
  assert.equal(f.counters().submits, 0);
  assert.equal(f.counters().commitCalls, 0);
  assert.equal(f.pending().kind, "final_review_changed");
});

test("joined generic exact review cannot accept an uncovered liability commitment", async t => {
  const f = await fixture(t, { legal: true });
  await f.service.execute(f.application.id);
  assert.equal(f.counters().submits, 0);
  const hold = f.pending();
  assert.ok(["legal_attestation", "final_policy_hold"].includes(hold.kind));
  if (hold.kind === "final_policy_hold") {
    const response = await f.request(`/v1/confirmations/${hold.id}`, review(hold));
    assert.ok(response.status >= 400);
  }
});

test("joined scoped privacy checkbox reaches a receipt without broad legal permission", async t => {
  const f = await fixture(t, { privacy: true });
  await f.service.execute(f.application.id);
  const hold = f.pending();
  assert.equal(hold.kind, "final_policy_hold", JSON.stringify(hold));
  const payload = review(hold);
  const field = payload.review.fields.find(item => item.key === "privacy");
  Object.assign(field, { sourceKind: "saved_recruitment_consent", profileAnswerKey: "recruitmentPrivacy", sourceReference: "synthetic scoped recruitment retention permission" });
  const response = await f.request(`/v1/confirmations/${hold.id}`, payload);
  assert.equal(response.status, 200, JSON.stringify(response.value));
  await f.service.execute(f.application.id);
  assert.equal(f.counters().submits, 1);
  assert.equal(f.service.list("applications", "fixture")[0].receipt.simulated, true);
});

test("joined unrelated affirmative fact and mixed privacy indemnity cannot authorize final action", async t => {
  const f = await fixture(t, { privacy: true, mixed: true });
  await f.service.execute(f.application.id);
  const hold = f.pending();
  assert.equal(hold.kind, "final_policy_hold", JSON.stringify(hold));
  for (const savedKey of ["unrelatedEmployment", "recruitmentPrivacy"]) {
    const payload = review(hold);
    Object.assign(payload.review.fields.find(item => item.key === "terms_waiver"), {
      sourceKind: "saved_recruitment_consent", profileAnswerKey: savedKey, sourceReference: "synthetic claimed consent" });
    const response = await f.request(`/v1/confirmations/${hold.id}`, payload);
    assert.equal(response.status, 400);
  }
  assert.equal(f.counters().submits, 0);
  assert.equal(f.counters().commitCalls, 0);
  assert.equal(f.service.list("applications", "fixture")[0].receipt, undefined);
});
