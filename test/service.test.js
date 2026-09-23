import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SimulationAdapter } from "../src/adapters/simulation.js";
import { NeedsInputError, NeedsReviewError, PostingUnavailableError,
  RetryableExecutionError } from "../src/adapters/errors.js";
import { ApplicationService } from "../src/service.js";
import { JsonStore } from "../src/store.js";

const config = {
  defaultMode: "full_time",
  modes: {
    full_time: { minimumScore: 75, autoApply: true, dailyApplicationCap: 8, requireConfirmationFor: ["missing_answer", "legal_attestation"] },
    freelance: { minimumScore: 70, autoApply: true, dailyApplicationCap: 5, requireConfirmationFor: ["missing_answer", "legal_attestation"] }
  }
};
const identity = { actorId: "bot-one", profileId: "person-one" };

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-server-test-"));
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  return new ApplicationService({ store, config: structuredClone(config), adapter: new SimulationAdapter() });
}

async function opportunity(service, extra = {}) {
  return service.addOpportunity({
    title: "Senior Engineer", company: "Example", applyUrl: "https://example.test/apply", score: 90, ...extra
  }, identity);
}

test("application metrics retain bounded worker timings and isolate profiles", async () => {
  const service = await fixture();
  await service.store.mutate((state) => {
    state.attempts.push({ id: "first", profileId: "person-one", applicationId: "app-one",
      status: "review_required", queueMs: 150,
      executionStartedAt: "2026-09-22T10:00:00.000Z", completedAt: "2026-09-22T10:00:02.000Z",
      workerMetrics: { activeMs: 1800, draftCalls: 1 } });
    state.attempts.push({ id: "other", profileId: "person-two", applicationId: "app-two",
      status: "submitted", queueMs: 9999, workerMetrics: { activeMs: 9999 } });
    state.confirmations.push({ id: "confirmation", profileId: "person-one", applicationId: "app-one",
      status: "approved", createdAt: "2026-09-22T10:01:00.000Z",
      resolvedAt: "2026-09-22T10:02:00.000Z" });
  });
  const metrics = service.applicationMetrics("person-one");
  assert.equal(metrics.attempts, 1);
  assert.deepEqual(metrics.outcomes, { review_required: 1 });
  assert.equal(metrics.queue.medianMs, 150);
  assert.equal(metrics.execution.medianMs, 2000);
  assert.equal(metrics.ownerWait.medianMs, 60000);
  assert.equal(metrics.worker.activeMs.p95Ms, 1800);
  assert.deepEqual(metrics.draftCalls, { samples: 1, total: 1 });
  assert.equal(metrics.modelInputTokens, null);
  assert.equal(service.applicationMetrics("unknown").worker.activeMs.medianMs, null);
});

test("blocked worker attempts persist numeric timings without private payloads", async () => {
  const service = await fixture();
  service.adapter.submit = async () => { throw new NeedsReviewError("Review", [{ kind: "unsupported_form" }], {
    metrics: { loadMs: 40, activeMs: 75, fields: 0, draftCalls: 0, privateValue: "secret" }
  }); };
  const job = await opportunity(service);
  await service.requestApplication(job.id, {}, identity);
  await service.waitForIdle();
  const attempt = service.store.snapshot().attempts[0];
  assert.equal(attempt.status, "review_required");
  assert.deepEqual(attempt.workerMetrics, { loadMs: 40, activeMs: 75, fields: 0, draftCalls: 0 });
  assert.ok(attempt.queueMs >= 0);
  assert.equal(service.applicationMetrics(identity.profileId).worker.activeMs.medianMs, 75);
});

test("an explicit unavailable posting is skipped without approval or submission", async () => {
  const service = await fixture();
  service.adapter.submit = async () => { throw new PostingUnavailableError("Job not found", {
    reasonCode: "posting_not_found", metrics: { activeMs: 250, fields: 0 }
  }); };
  const job = await opportunity(service);
  await service.requestApplication(job.id, {}, identity);
  await service.waitForIdle();
  const application = service.list("applications", identity.profileId)[0];
  assert.equal(application.status, "skipped");
  assert.equal(application.receipt, undefined);
  assert.deepEqual(service.list("confirmations", identity.profileId), []);
  assert.equal(service.store.snapshot().attempts[0].workerMetrics.activeMs, 250);
});

test("full-time is the default and a high-score routine application submits", async () => {
  const service = await fixture();
  const job = await opportunity(service);
  const application = await service.requestApplication(job.id, {}, identity);
  assert.equal(job.mode, "full_time");
  assert.equal(application.status, "queued");
  await service.waitForIdle();
  const submitted = service.list("applications", identity.profileId)[0];
  assert.equal(submitted.status, "submitted");
  assert.equal(submitted.receipt.simulated, true);
});

test("an opportunity below the mode threshold is skipped", async () => {
  const service = await fixture();
  const job = await opportunity(service, { score: 40 });
  const application = await service.requestApplication(job.id, {}, identity);
  assert.equal(application.status, "skipped");
});

test("a legal attestation pauses and resumes after explicit approval", async () => {
  const service = await fixture();
  const job = await opportunity(service, {
    legalAttestations: [{ key: "truthful", label: "I certify that this application is truthful" }]
  });
  const pending = await service.requestApplication(job.id, {}, identity);
  assert.equal(pending.status, "waiting_confirmation");
  const confirmation = service.list("confirmations", identity.profileId)[0];
  const queued = await service.resolveConfirmation(
    confirmation.id, { approved: true, answers: { truthful: true } }, identity
  );
  assert.equal(queued.status, "queued");
  await service.waitForIdle();
  const submitted = service.list("applications", identity.profileId)[0];
  assert.equal(submitted.status, "submitted");
});

test("profiles cannot see one another's records", async () => {
  const service = await fixture();
  await service.addOpportunity({
    title: "Engineer",
    company: "Example",
    applyUrl: "https://example.test/apply",
    score: 90,
    profileId: "person-two"
  }, identity);
  assert.equal(service.list("opportunities", identity.profileId).length, 1);
  assert.equal(service.list("opportunities", "person-two").length, 0);
});

test("employer status is recorded separately from submission state", async () => {
  const service = await fixture();
  const job = await opportunity(service);
  const application = await service.requestApplication(job.id, {}, identity);
  await service.waitForIdle();
  const result = await service.recordEmployerStatus(application.id, {
    status: "assessment",
    observedAt: "2026-09-15T08:00:00Z",
    source: "email",
    sourceId: "gmail-message-one",
    subject: "Assessment invitation"
  }, identity);
  assert.equal(result.status, "submitted");
  assert.equal(result.employerStatus.status, "assessment");
  assert.equal(result.employerStatus.sourceId, "gmail-message-one");
});

test("employer status updates are profile-isolated and chronological", async () => {
  const service = await fixture();
  const job = await opportunity(service);
  const application = await service.requestApplication(job.id, {}, identity);
  await service.waitForIdle();
  await assert.rejects(
    service.recordEmployerStatus(application.id, {
      status: "rejected", observedAt: "2026-09-15T08:00:00Z"
    }, { actorId: "bot-two", profileId: "person-two" }),
    /application not found/
  );
  await service.recordEmployerStatus(application.id, {
    status: "under_review", observedAt: "2026-09-15T08:00:00Z"
  }, identity);
  await assert.rejects(
    service.recordEmployerStatus(application.id, {
      status: "application_received", observedAt: "2026-09-14T08:00:00Z"
    }, identity),
    /older than the current status/
  );
});

test("tracking parameters do not create duplicate opportunities", async () => {
  const service = await fixture();
  const first = await opportunity(service, { applyUrl: "https://example.test/apply?utm_source=feed" });
  const second = await opportunity(service, { applyUrl: "https://example.test/apply?utm_source=bot" });
  assert.equal(second.id, first.id);
  assert.equal(service.list("opportunities", identity.profileId).length, 1);
});

test("the same application URL is deduplicated across direct and feed sources", async () => {
  const service = await fixture();
  const first = await service.addOpportunity({
    title: "Direct application", company: "jobs.example.test",
    applyUrl: "https://jobs.example.test/company/role/application?source=linkedin",
    source: "direct", score: 100
  }, identity);
  const second = await service.addOpportunity({
    title: "Senior Engineer", company: "Example",
    applyUrl: "https://jobs.example.test/company/role/application",
    source: "ashby", externalId: "company:role", score: 90
  }, identity);
  assert.equal(second.id, first.id);
  assert.equal(service.list("opportunities", identity.profileId).length, 1);
});

test("direct user intent upgrades an existing low-scoring discovered opportunity", async () => {
  const service = await fixture();
  const discovered = await opportunity(service, {
    applyUrl: "https://careers.example.test/jobs/one?utm_source=feed", source: "feed", score: 20
  });
  const direct = await service.directApplication({ url: "https://careers.example.test/jobs/one" }, identity);
  assert.equal(direct.opportunity.id, discovered.id);
  assert.equal(direct.opportunity.userRequested, true);
  assert.equal(direct.opportunity.score, 100);
  assert.equal(direct.application.status, "queued");
  await service.waitForIdle();
});

test("different profiles execute independently under the global concurrency limit", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-server-test-"));
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  const releases = new Map();
  const starts = [];
  let bothStartedResolve;
  const bothStarted = new Promise((resolve) => { bothStartedResolve = resolve; });
  const adapter = { name: "parallel", async submit({ application }) {
    starts.push(application.profileId);
    if (new Set(starts).size === 2) bothStartedResolve();
    await new Promise((resolve) => releases.set(application.profileId, resolve));
    return { submittedAt: new Date().toISOString(), finalUrl: "https://example.test/done" };
  } };
  const localConfig = structuredClone(config); localConfig.execution = { concurrency: 2 };
  const service = new ApplicationService({ store, config: localConfig, adapter });
  const secondIdentity = { actorId: "bot-two", profileId: "person-two" };
  const first = await opportunity(service, { applyUrl: "https://example.test/one" });
  const second = await service.addOpportunity({ title: "Engineer", company: "Example",
    applyUrl: "https://example.test/two", score: 90 }, secondIdentity);
  await service.requestApplication(first.id, {}, identity);
  await service.requestApplication(second.id, {}, secondIdentity);
  await Promise.race([bothStarted, new Promise((_, reject) => setTimeout(
    () => reject(new Error("profile lanes did not start concurrently")), 1_000
  ))]);
  assert.deepEqual(new Set(starts), new Set(["person-one", "person-two"]));
  releases.get("person-one")(); releases.get("person-two")();
  await service.waitForIdle();
});

test("worker-discovered questions create resumable confirmations", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-server-test-"));
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  let attempts = 0;
  const adapter = {
    name: "test-worker",
    async submit() {
      attempts += 1;
      if (attempts === 1) {
        throw new NeedsInputError("answer required", [{
          kind: "missing_answer", message: "Years of Kotlin experience", fields: ["kotlin_years"]
        }]);
      }
      return { submittedAt: new Date().toISOString(), finalUrl: "https://example.test/confirmation" };
    }
  };
  const service = new ApplicationService({ store, config, adapter });
  const job = await opportunity(service);
  const queued = await service.requestApplication(job.id, {}, identity);
  assert.equal(queued.status, "queued");
  await service.waitForIdle();
  const waiting = service.list("applications", identity.profileId)[0];
  assert.equal(waiting.status, "waiting_confirmation");
  const confirmation = service.list("confirmations", identity.profileId)[0];
  const resumed = await service.resolveConfirmation(
    confirmation.id, { approved: true, answers: { kotlin_years: 3 } }, identity
  );
  assert.equal(resumed.status, "queued");
  await service.waitForIdle();
  const submitted = service.list("applications", identity.profileId)[0];
  assert.equal(submitted.status, "submitted");
  assert.equal(attempts, 2);
});

test("an incomplete final preview can be superseded without approval or submission", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-server-test-"));
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  let attempts = 0;
  const adapter = { name: "test-worker", async submit() {
    attempts += 1;
    if (attempts === 1) throw new NeedsInputError("Review", [{
      kind: "final_submission_approval", previewFingerprint: "a".repeat(64),
      preview: { destination: "https://example.test/apply", filled: [], unfilled: [] }
    }]);
    throw new NeedsInputError("Custom question", [{
      kind: "missing_answer", message: "Required custom question", fields: ["custom"]
    }]);
  } };
  const service = new ApplicationService({ store, config, adapter });
  const job = await opportunity(service);
  const application = await service.requestApplication(job.id, {}, identity);
  await service.waitForIdle();
  const oldApproval = service.list("confirmations", identity.profileId)[0];
  assert.equal(oldApproval.kind, "final_submission_approval");
  await assert.rejects(service.refreshFinalPreview(application.id,
    { actorId: "other", profileId: "other" }), /not waiting/);
  const queued = await service.refreshFinalPreview(application.id, identity);
  assert.equal(queued.status, "queued");
  await service.waitForIdle();
  const confirmations = service.list("confirmations", identity.profileId);
  assert.equal(confirmations.find((item) => item.id === oldApproval.id).status, "superseded");
  assert.equal(confirmations.find((item) => item.status === "pending").kind, "missing_answer");
  assert.equal(service.list("applications", identity.profileId)[0].receipt, undefined);
  assert.equal(attempts, 2);
  await assert.rejects(service.approvePreparedBatch([
    { applicationId: application.id, previewFingerprint: "a".repeat(64) }
  ], identity), /not ready/);
});

test("unverified submission review cannot accidentally retry", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-server-test-"));
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  const adapter = {
    name: "test-worker",
    async submit() {
      throw new NeedsReviewError("submission could not be verified", [{ kind: "submission_unverified" }]);
    }
  };
  const service = new ApplicationService({ store, config, adapter });
  const job = await opportunity(service);
  await service.requestApplication(job.id, {}, identity);
  await service.waitForIdle();
  const waiting = service.list("applications", identity.profileId)[0];
  const confirmation = service.list("confirmations", identity.profileId)[0];
  assert.equal(waiting.status, "waiting_confirmation");
  await assert.rejects(
    service.resolveConfirmation(confirmation.id, { approved: true, answers: {} }, identity),
    /manual review requires/
  );
});

test("manual review accepts explicit answers for every named field", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-server-test-"));
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  let attempts = 0;
  const adapter = { name: "test-worker", async submit(payload) {
    attempts += 1;
    if (attempts === 1) {
      throw new NeedsReviewError("Location: matching location option was not found", [{
        kind: "unsupported_control", action: "manual_review", fields: ["location"]
      }]);
    }
    assert.equal(payload.application.answers.location, "Sofia, Bulgaria");
    return { submittedAt: new Date().toISOString(), finalUrl: "https://example.test/complete" };
  } };
  const service = new ApplicationService({ store, config, adapter });
  const job = await opportunity(service);
  const application = await service.requestApplication(job.id, {}, identity);
  await service.waitForIdle();
  const confirmation = service.list("confirmations", identity.profileId)[0];
  const queued = await service.resolveConfirmation(confirmation.id, {
    approved: true, answers: { location: "Sofia, Bulgaria" }
  }, identity);
  assert.equal(queued.status, "queued");
  await service.waitForIdle();
  assert.equal(service.list("applications", identity.profileId)[0].status, "submitted");
});

test("a browser failure before the final action retries automatically", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-server-test-"));
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  let attempts = 0;
  const adapter = { name: "test-worker", async submit() {
    attempts += 1;
    if (attempts === 1) throw new RetryableExecutionError("navigation connection closed");
    return { submittedAt: new Date().toISOString(), finalUrl: "https://example.test/complete" };
  } };
  const service = new ApplicationService({ store, config, adapter });
  const job = await opportunity(service);
  await service.requestApplication(job.id, {}, identity);
  await service.waitForIdle();
  assert.equal(attempts, 2);
  assert.equal(service.list("applications", identity.profileId)[0].status, "submitted");
  assert.equal(store.snapshot().attempts.some((entry) => entry.status === "transient_retry"), true);
});

test("execution receives only the authenticated profile", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-server-test-"));
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  const expectedProfile = { id: "person-one", contact: { email: "owner@example.test" } };
  const profiles = {
    async status() { return { readyToApply: true, missingForApplications: [] }; },
    async get(profileId) { return profileId === "person-one" ? expectedProfile : undefined; }
  };
  let received;
  const adapter = {
    name: "capture",
    async submit(payload) {
      received = payload.profile;
      return { submittedAt: new Date().toISOString(), finalUrl: "https://example.test/confirmation" };
    }
  };
  const service = new ApplicationService({ store, config, adapter, profiles });
  const job = await opportunity(service);
  await service.requestApplication(job.id, {}, identity);
  await service.waitForIdle();
  assert.deepEqual(received, expectedProfile);
});

test("concurrent application admission creates exactly one active application", async () => {
  const service = await fixture();
  const job = await opportunity(service);
  const results = await Promise.allSettled([
    service.requestApplication(job.id, {}, identity),
    service.requestApplication(job.id, {}, identity)
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.find((result) => result.status === "rejected").reason.status, 409);
  assert.equal(service.list("applications", identity.profileId).length, 1);
  await service.waitForIdle();
});

test("concurrent admission cannot exceed the daily cap", async () => {
  const service = await fixture();
  service.config.modes.full_time.dailyApplicationCap = 1;
  const first = await opportunity(service, { applyUrl: "https://example.test/one" });
  const second = await opportunity(service, { applyUrl: "https://example.test/two" });
  const applications = await Promise.all([
    service.requestApplication(first.id, {}, identity),
    service.requestApplication(second.id, {}, identity)
  ]);
  assert.equal(applications.filter((item) => item.status === "queued").length, 1);
  assert.equal(applications.filter((item) => item.status === "skipped").length, 1);
  await service.waitForIdle();
});

test("an authenticated profile can raise its own application cap for an approved batch", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-server-test-"));
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  const profiles = {
    async status() { return { readyToApply: true, missingForApplications: [] }; },
    async get() {
      return {
        preferences: {
          maxApplicationsPerDay: 2,
          fullTime: { dailyApplicationCap: 2 }
        }
      };
    }
  };
  const localConfig = structuredClone(config);
  localConfig.execution = { maxApplicationsPerDay: 1 };
  localConfig.modes.full_time.dailyApplicationCap = 1;
  const service = new ApplicationService({
    store,
    config: localConfig,
    profiles,
    adapter: new SimulationAdapter()
  });
  const first = await opportunity(service, { applyUrl: "https://example.test/batch-one" });
  const second = await opportunity(service, { applyUrl: "https://example.test/batch-two" });
  const admitted = await Promise.all([
    service.requestApplication(first.id, {}, identity),
    service.requestApplication(second.id, {}, identity)
  ]);
  assert.equal(admitted.filter((item) => item.status === "queued").length, 2);
  await service.waitForIdle();
});

test("an authenticated profile can disable daily application caps", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-server-test-"));
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  const profiles = {
    async status() { return { readyToApply: true, missingForApplications: [] }; },
    async get() {
      return {
        preferences: {
          maxApplicationsPerDay: 0,
          fullTime: { dailyApplicationCap: 0 }
        }
      };
    }
  };
  const localConfig = structuredClone(config);
  localConfig.execution = { maxApplicationsPerDay: 1 };
  localConfig.modes.full_time.dailyApplicationCap = 1;
  const service = new ApplicationService({
    store,
    config: localConfig,
    profiles,
    adapter: new SimulationAdapter()
  });
  const jobs = await Promise.all(Array.from({ length: 3 }, (_, index) =>
    opportunity(service, { applyUrl: `https://example.test/unlimited-${index}` })
  ));
  const admitted = await Promise.all(
    jobs.map((job) => service.requestApplication(job.id, {}, identity))
  );
  assert.equal(admitted.filter((item) => item.status === "queued").length, 3);
  await service.waitForIdle();
});

test("recovery resumes queued work and sends uncertain submissions to review", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-server-test-"));
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  let attempts = 0;
  const adapter = { name: "capture", async submit() {
    attempts += 1;
    return { submittedAt: new Date().toISOString(), finalUrl: "https://example.test/done" };
  } };
  await store.mutate(async (state) => {
    state.opportunities.push(
      { id: "op-queued", profileId: "person-one", applyUrl: "https://example.test/a" },
      { id: "op-uncertain", profileId: "person-one", applyUrl: "https://example.test/b" }
    );
    state.applications.push(
      { id: "app-queued", opportunityId: "op-queued", profileId: "person-one", status: "queued", createdAt: new Date().toISOString() },
      { id: "app-uncertain", opportunityId: "op-uncertain", profileId: "person-one", status: "submitting",
        claim: { attemptId: "attempt-uncertain", executionStartedAt: new Date().toISOString() },
        createdAt: new Date().toISOString() }
    );
    state.attempts.push({ id: "attempt-uncertain", applicationId: "app-uncertain", profileId: "person-one",
      status: "submitting" });
  });
  const service = new ApplicationService({ store, config, adapter });
  await service.recover();
  await service.waitForIdle();
  assert.equal(attempts, 1);
  assert.equal(service.list("applications", identity.profileId).find((item) => item.id === "app-queued").status, "submitted");
  assert.equal(service.list("applications", identity.profileId).find((item) => item.id === "app-uncertain").status, "waiting_confirmation");
  assert.equal(store.snapshot().attempts.find((item) => item.id === "attempt-uncertain").status, "uncertain");
  assert.equal(service.list("confirmations", identity.profileId).filter((item) => item.kind === "submission_recovery").length, 1);
});

test("duplicate queue delivery claims an application only once", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-server-test-"));
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  let attempts = 0;
  const service = new ApplicationService({ store, config, adapter: { name: "capture", async submit() {
    attempts += 1;
    return { submittedAt: new Date().toISOString(), finalUrl: "https://example.test/done" };
  } } });
  const job = await opportunity(service);
  const application = await service.requestApplication(job.id, {}, identity);
  service.enqueue(application.id);
  await service.waitForIdle();
  assert.equal(attempts, 1);
});

test("a verified receipt survives a transient persistence failure without resubmission", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-server-test-"));
  const inner = await new JsonStore(path.join(directory, "state.json")).init();
  let failReceiptOnce = true;
  const store = {
    snapshot: () => inner.snapshot(),
    mutate: (fn) => inner.mutate(async (state) => {
      const result = await fn(state);
      if (failReceiptOnce && state.applications.some((item) => item.status === "submitted")) {
        failReceiptOnce = false;
        throw new Error("transient receipt persistence failure");
      }
      return result;
    })
  };
  let submissions = 0;
  const service = new ApplicationService({ store, config, adapter: { name: "capture", async submit() {
    submissions += 1;
    return { submittedAt: new Date().toISOString(), finalUrl: "https://example.test/done" };
  } } });
  const job = await opportunity(service);
  await service.requestApplication(job.id, {}, identity);
  await service.waitForIdle();
  assert.equal(submissions, 1);
  assert.equal(service.list("applications", identity.profileId)[0].status, "submitted");
});

test("a direct HTTPS link creates one deduplicated durable application", async () => {
  const service = await fixture();
  const first = await service.directApplication({ url: "https://careers.example.test/apply?utm_source=chat" }, identity);
  const second = await service.directApplication({ url: "https://careers.example.test/apply?utm_source=again" }, identity);
  assert.equal(first.application.status, "queued");
  assert.equal(first.opportunity.userRequested, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.application.id, first.application.id);
  assert.equal(service.list("opportunities", identity.profileId).length, 1);
  await service.waitForIdle();
});

test("final approval persists only the reviewed preview fingerprint", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-server-test-"));
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  const localConfig = structuredClone(config);
  localConfig.modes.full_time.submissionApproval = "always";
  let attempts = 0;
  const adapter = { name: "preview-worker", async submit({ application }) {
    attempts += 1;
    if (!application.finalSubmissionApproval) {
      throw new NeedsInputError("review", [{
        kind: "final_submission_approval", message: "Ready for approval",
        previewFingerprint: "preview-one",
        preview: { destination: "https://example.test/apply", filled: [{ label: "Email", value: "owner@example.test", source: "profile" }], unfilled: [] }
      }]);
    }
    assert.equal(application.finalSubmissionApproval.previewFingerprint, "preview-one");
    return { submittedAt: new Date().toISOString(), finalUrl: "https://example.test/done" };
  } };
  const service = new ApplicationService({ store, config: localConfig, adapter });
  const job = await opportunity(service);
  await service.requestApplication(job.id, {}, identity);
  await service.waitForIdle();
  const confirmation = service.list("confirmations", identity.profileId)[0];
  assert.equal(confirmation.kind, "final_submission_approval");
  assert.match(confirmation.presentation.blocks[0].text, /Email: owner@example.test/);
  assert.equal(confirmation.presentation.blocks[1].buttons[0].value, `jobapp:${confirmation.id}:approve`);
  await service.resolveConfirmation(confirmation.id, { approved: true }, identity);
  await service.waitForIdle();
  assert.equal(service.list("applications", identity.profileId)[0].status, "submitted");
  assert.equal(attempts, 2);
});

test("existing site password moves to the profile vault and never enters durable state", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-server-test-"));
  const stateFile = path.join(directory, "state.json");
  const store = await new JsonStore(stateFile).init();
  let storedCredential;
  const credentialVault = {
    async set(profileId, origin, credential) { storedCredential = { profileId, origin, ...credential }; },
    async get() { return storedCredential ? { ...storedCredential } : null; },
    async ensureGenerated() { throw new Error("not expected"); }
  };
  const profiles = {
    async status() { return { readyToApply: true, missingForApplications: [] }; },
    async get() { return { id: "person-one", contact: { email: "owner@example.test" } }; }
  };
  let attempts = 0;
  const adapter = { name: "account-worker", async submit({ profile }) {
    attempts += 1;
    if (attempts === 1) throw new NeedsInputError("account required", [{
      kind: "account_credentials", message: "Login required", fields: ["siteAccountAction"],
      origin: "https://accounts.example.test", options: [], recommendation: "custom"
    }]);
    assert.equal(profile.siteCredential.password, "one-time-secret");
    return { submittedAt: new Date().toISOString(), finalUrl: "https://example.test/done" };
  } };
  const service = new ApplicationService({ store, config, adapter, profiles, credentialVault });
  const job = await opportunity(service);
  await service.requestApplication(job.id, {}, identity);
  await service.waitForIdle();
  const confirmation = service.list("confirmations", identity.profileId)[0];
  await service.resolveConfirmation(confirmation.id, { approved: true, answers: {
    site_username: "owner@example.test", site_password: "one-time-secret"
  } }, identity);
  await service.waitForIdle();
  assert.equal(storedCredential.password, "one-time-secret");
  assert.doesNotMatch(await readFile(stateFile, "utf8"), /one-time-secret/);
  assert.equal(service.list("applications", identity.profileId)[0].status, "submitted");
});

test("rejected account credentials are discarded instead of entering durable state", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-server-test-"));
  const stateFile = path.join(directory, "state.json");
  const store = await new JsonStore(stateFile).init();
  const adapter = { name: "account-worker", async submit() {
    throw new NeedsInputError("account required", [{
      kind: "account_credentials", message: "Login required", fields: ["siteAccountAction"],
      origin: "https://accounts.example.test", options: [], recommendation: "custom"
    }]);
  } };
  const service = new ApplicationService({ store, config, adapter });
  const job = await opportunity(service);
  await service.requestApplication(job.id, {}, identity);
  await service.waitForIdle();
  const confirmation = service.list("confirmations", identity.profileId)[0];
  await service.resolveConfirmation(confirmation.id, { approved: false, answers: {
    site_username: "owner@example.test", site_password: "discard-me"
  } }, identity);
  assert.doesNotMatch(await readFile(stateFile, "utf8"), /discard-me/);
  assert.deepEqual(service.list("confirmations", identity.profileId)[0].response, {});
});

test("rejecting one application confirmation supersedes its remaining pending questions", async () => {
  const service = await fixture();
  service.adapter.submit = async () => {
    throw new NeedsInputError("answers required", [
      { kind: "missing_answer", message: "First", fields: ["first"] },
      { kind: "missing_answer", message: "Second", fields: ["second"] }
    ]);
  };
  const job = await opportunity(service);
  await service.requestApplication(job.id, {}, identity);
  await service.waitForIdle();
  const confirmations = service.list("confirmations", identity.profileId);
  await service.resolveConfirmation(confirmations[0].id, { approved: false }, identity);
  assert.deepEqual(service.list("confirmations", identity.profileId).map((item) => item.status).sort(),
    ["rejected", "superseded"]);
  assert.equal(service.list("applications", identity.profileId)[0].status, "rejected");
});

test("manual retry controls are not persisted as application answers", async () => {
  const service = await fixture();
  service.adapter.submit = async () => { throw new NeedsInputError("manual", [{
    kind: "unsupported_form", action: "manual_review", message: "Inspect"
  }]); };
  const job = await opportunity(service);
  await service.requestApplication(job.id, {}, identity);
  await service.waitForIdle();
  const confirmation = service.list("confirmations", identity.profileId)[0];
  const application = await service.resolveConfirmation(confirmation.id,
    { approved: true, answers: { retry: true } }, identity);
  assert.deepEqual(application.answers, {});
});

test("ordinary application answers reject credential-like fields", async () => {
  const service = await fixture();
  const job = await opportunity(service);
  await assert.rejects(
    service.requestApplication(job.id, { answers: { account_password: "do-not-store" } }, identity),
    /must not contain credential field/
  );
});

test("application log joins job details and records safe question answers", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-server-test-"));
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  const adapter = { name: "question-worker", async submit({ application }) {
    if (!application.answers.kotlin_years) {
      throw new NeedsInputError("How many years of Kotlin experience do you have?", [{
        kind: "missing_answer",
        message: "How many years of Kotlin experience do you have?",
        fields: ["kotlin_years", "site_password"]
      }]);
    }
    return {
      submittedAt: "2026-09-12T12:30:00.000Z",
      finalUrl: "https://example.test/application/complete",
      externalId: "application-123"
    };
  } };
  const service = new ApplicationService({ store, config, adapter });
  const job = await opportunity(service, {
    company: "Example GmbH",
    listingUrl: "https://example.test/jobs/123",
    source: "company_site"
  });
  await service.requestApplication(job.id, {}, identity);
  await service.waitForIdle();
  const confirmation = service.list("confirmations", identity.profileId)[0];
  await assert.rejects(
    service.resolveConfirmation(confirmation.id, { approved: true, answers: {
      kotlin_years: 3,
      site_password: "must-not-appear"
    } }, identity),
    /must not contain credential field/
  );
  await service.resolveConfirmation(confirmation.id, { approved: true, answers: { kotlin_years: 3 } }, identity);
  await service.waitForIdle();

  const [entry] = service.applicationLog(identity.profileId);
  const resolvedConfirmation = service.list("confirmations", identity.profileId)[0];
  assert.equal(entry.company, "Example GmbH");
  assert.equal(entry.title, "Senior Engineer");
  assert.equal(entry.url, "https://example.test/apply");
  assert.equal(entry.listingUrl, "https://example.test/jobs/123");
  assert.equal(entry.status, "submitted");
  assert.equal(entry.submittedAt, "2026-09-12T12:30:00.000Z");
  assert.deepEqual(entry.questionsAndAnswers, [{
    field: "kotlin_years",
    question: "How many years of Kotlin experience do you have?",
    answer: 3,
    answeredAt: resolvedConfirmation.resolvedAt
  }]);
  assert.equal(service.applicationLog("person-two").length, 0);
  assert.doesNotMatch(JSON.stringify(entry), /must-not-appear/);
});

test("a verified browser submission updates a skipped application and stores safe form answers", async () => {
  const service = await fixture();
  const job = await opportunity(service, { score: 40, company: "Manual Example" });
  const application = await service.requestApplication(job.id, {}, identity);
  assert.equal(application.status, "skipped");

  const logged = await service.recordManualSubmission(application.id, {
    manuallyVerified: true,
    finalUrl: "https://example.test/application/complete",
    externalId: "manual-456",
    company: "Correct Company",
    title: "Correct Role",
    questionsAndAnswers: [{
      field: "work_authorization",
      question: "Are you authorized to work in Canada?",
      answer: "Yes"
    }, {
      field: "account_password",
      question: "Account password",
      answer: "must-not-be-stored"
    }]
  }, identity);

  assert.equal(logged.status, "submitted");
  assert.equal(logged.receipt.manuallyVerified, true);
  assert.equal(logged.receipt.externalId, "manual-456");
  assert.equal(logged.company, "Correct Company");
  assert.equal(logged.title, "Correct Role");
  assert.deepEqual(logged.questionsAndAnswers.map((item) => item.answer), ["Yes", "[redacted]"]);
  assert.doesNotMatch(JSON.stringify(service.store.snapshot()), /must-not-be-stored/);
  await assert.rejects(
    service.recordManualSubmission(application.id, {
      manuallyVerified: true,
      finalUrl: "https://example.test/application/complete"
    }, { actorId: "bot-two", profileId: "person-two" }),
    /application not found/
  );
});
