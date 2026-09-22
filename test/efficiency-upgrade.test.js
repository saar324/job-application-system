import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { chromium } from "playwright";
import { automateApplication } from "../worker/automation.js";
import { NeedsInputError, NeedsResearchError, NeedsReviewError } from "../src/adapters/errors.js";
import { ApplicationService } from "../src/service.js";
import { DiscoveryService } from "../src/discovery/service.js";
import { ProfileStore } from "../src/profile-store.js";
import { JsonStore } from "../src/store.js";
import { WebhookAdapter } from "../src/adapters/webhook.js";

const identity = { actorId: "owner", profileId: "owner" };
const profile = { id: "owner", contact: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.test" },
  links: {}, documents: {} };
const htmlUrl = (html) => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

async function browserRun(browser, html, application = {}, draftProvider, evidencePacket, profileOverride = profile) {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    return await automateApplication({ page, profile: profileOverride,
      opportunity: { applyUrl: htmlUrl(html), company: "Example", title: "Engineer" },
      application: { id: "test-application", answers: {}, ...application }, draftProvider, evidencePacket,
      artifactsDirectory: await mkdtemp(path.join(os.tmpdir(), "job-efficiency-browser-")) });
  } finally { await context.close(); }
}

test("complete review preserves long answers and repeated fields on separate steps", async () => {
  const browser = await chromium.launch();
  try {
    const prose = "A".repeat(4100) + "END";
    const html = `<form id="one">
      <label>Note <input name="note"></label>
      <button type="button" onclick="document.querySelector('#one').hidden=true;document.querySelector('#two').hidden=false">Next</button>
      <button type="submit">Submit Application</button></form>
      <form id="two" hidden onsubmit="event.preventDefault();document.body.textContent='Application submitted'">
      <label>Note <input name="note"></label><label>Story <textarea name="story"></textarea></label>
      <button type="submit">Submit Application</button></form>`;
    const result = await browserRun(browser, html,
      { answers: { note: "same", story: prose }, finalApprovalRequired: true });
    assert.equal(result.status, "needs_input");
    const preview = result.requirements[0].preview;
    assert.equal(preview.filled.filter((field) => field.key === "note").length, 2);
    assert.equal(preview.filled.find((field) => field.key === "story").value, prose);
    assert.equal(result.checkpoint.version, 1);
    assert.equal(result.phase, "before_final_action");
    const changed = await browserRun(browser, html,
      { answers: { note: "same", story: `${prose.slice(0, -3)}NEW` }, finalApprovalRequired: true });
    assert.notEqual(changed.requirements[0].previewFingerprint, result.requirements[0].previewFingerprint);
  } finally { await browser.close(); }
});

test("draft provider receives only unresolved prose and replay uses the saved draft", async () => {
  const browser = await chromium.launch();
  const html = `<form onsubmit="event.preventDefault();document.body.textContent='Application submitted'">
    <label>Email <input name="email" type="email" required></label>
    <label>Why this role? <textarea name="motivation" required></textarea></label>
    <button type="submit">Submit Application</button></form>`;
  let requests = 0;
  const provider = { async draft(input) {
    requests += 1;
    assert.deepEqual(input.questions.map((item) => item.fieldId), ["motivation"]);
    assert.equal(input.evidencePacket.listing, "Build reliable software");
    assert.doesNotMatch(JSON.stringify(input), /ada@example\.test/);
    return [{ fieldId: "motivation", text: "I want to build reliable software.", evidenceIds: ["listing"] }];
  } };
  try {
    const first = await browserRun(browser, html, {}, provider, { listing: "Build reliable software" });
    assert.equal(first.status, "needs_input");
    assert.equal(first.requirements[0].kind, "final_submission_approval");
    assert.equal(first.preparedAnswers.motivation, "I want to build reliable software.");
    assert.equal(requests, 1);
    const second = await browserRun(browser, html, {
      preparedAnswers: first.preparedAnswers,
      finalSubmissionApproval: { previewFingerprint: first.requirements[0].previewFingerprint }
    });
    assert.equal(second.status, "submitted");
  } finally { await browser.close(); }
});

test("missing company evidence pauses for research before model drafting", async () => {
  const browser = await chromium.launch();
  try {
    const result = await browserRun(browser, `<form><label>Why this company?
      <textarea name="motivation" required></textarea></label><button type="submit">Submit Application</button></form>`,
    {}, { async draft() { throw new Error("should not be called"); } }, { listing: "", research: [] });
    assert.equal(result.status, "needs_research");
    assert.equal(result.questions[0].fieldId, "motivation");
  } finally { await browser.close(); }
});

test("application form inside a visible frame is filled and reviewed", async () => {
  const browser = await chromium.launch();
  try {
    const inner = `<form onsubmit="event.preventDefault();document.body.textContent='Application submitted'">
      <label>Email <input name="email" type="email" required></label>
      <button type="submit">Submit Application</button></form>`;
    const html = `<iframe title="Application" srcdoc="${inner.replaceAll('"', '&quot;')}"></iframe>`;
    const result = await browserRun(browser, html, { finalApprovalRequired: true });
    assert.equal(result.status, "needs_input");
    assert.equal(result.requirements[0].preview.filled[0].value, "ada@example.test");
  } finally { await browser.close(); }
});

test("generic name and email attributes do not fill company and referral fields", async () => {
  const browser = await chromium.launch();
  try {
    const result = await browserRun(browser, `<form>
      <label>Company name <input name="name" required></label>
      <label>Referral email <input name="email" type="email" required></label>
      <button type="submit">Submit Application</button></form>`);
    assert.equal(result.status, "needs_input");
    assert.deepEqual(result.requirements.flatMap((item) => item.fields), ["name", "email"]);
    assert.equal(result.checkpoint.fields.filter((field) => field.status === "filled").length, 0);
  } finally { await browser.close(); }
});

test("scoped approved answers apply only to their employer", async () => {
  const browser = await chromium.launch();
  const question = "Why this company?";
  const approved = { ...profile, approvedAnswers: [{ id: "motivation-one", question,
    value: "I like this company's work.", approvedAt: "2026-09-01T00:00:00Z",
    scope: { employer: "Example" } }] };
  try {
    const html = `<form><label>${question}<textarea name="motivation" required></textarea></label>
      <button type="submit">Submit Application</button></form>`;
    const matched = await browserRun(browser, html, { finalApprovalRequired: true }, undefined, undefined, approved);
    assert.equal(matched.requirements[0].kind, "final_submission_approval");
    assert.equal(matched.requirements[0].preview.filled[0].source, "approved answer:motivation-one");
    const other = await browserRun(browser, html, { finalApprovalRequired: true }, undefined, undefined,
      { ...approved, approvedAnswers: [{ ...approved.approvedAnswers[0], scope: { employer: "Other" } }] });
    assert.equal(other.requirements[0].kind, "missing_answer");
  } finally { await browser.close(); }
});

test("unsupported custom controls stop before final submission", async () => {
  const browser = await chromium.launch();
  try {
    const result = await browserRun(browser, `<form><div role="combobox" tabindex="0">Choose</div>
      <button type="submit">Submit Application</button></form>`);
    assert.equal(result.status, "needs_human");
    assert.equal(result.requirements[0].kind, "unsupported_control");
  } finally { await browser.close(); }
});

async function serviceFixture(adapter) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-efficiency-service-"));
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  const config = { defaultMode: "full_time", modes: { full_time: {
    minimumScore: 0, autoApply: true, dailyApplicationCap: 20,
    requireConfirmationFor: [], submissionApproval: "automatic", sources: []
  } } };
  return new ApplicationService({ store, config, adapter });
}

test("research pause is durable and official evidence requeues the same application", async () => {
  let runs = 0;
  const service = await serviceFixture({ name: "research-test", async submit() {
    runs += 1;
    if (runs === 1) throw new NeedsResearchError("Research needed", [{ fieldId: "motivation",
      question: "Why this company?" }], { checkpoint: { version: 1, applicationId: "wrong" } });
    return { submittedAt: new Date().toISOString(), finalUrl: "https://example.test/done" };
  } });
  const job = await service.addOpportunity({ title: "Engineer", company: "Example",
    applyUrl: "https://example.test/apply", score: 90 }, identity);
  const requested = await service.requestApplication(job.id, {}, identity);
  await service.waitForIdle();
  assert.equal(service.list("applications", identity.profileId)[0].status, "waiting_research");
  await service.attachResearch(requested.id, {
    url: "https://example.test/about", excerpt: "We build reliable software.", officialSourceConfirmed: true
  }, identity);
  await service.waitForIdle();
  assert.equal(service.list("applications", identity.profileId)[0].status, "submitted");
});

test("exact batch approval is atomic and resumes only named previews", async () => {
  const service = await serviceFixture({ name: "batch-test", async submit({ application }) {
    if (!application.finalSubmissionApproval) throw new NeedsInputError("Review", [{
      kind: "final_submission_approval", previewFingerprint: application.id.padEnd(64, "a").slice(0, 64),
      preview: { filled: [], unfilled: [] }
    }]);
    return { submittedAt: new Date().toISOString(), finalUrl: "https://example.test/done" };
  } });
  const jobs = await Promise.all(["One", "Two"].map((name) => service.addOpportunity({
    title: "Engineer", company: name, applyUrl: `https://${name.toLowerCase()}.example.test/apply`, score: 90
  }, identity)));
  for (const job of jobs) await service.requestApplication(job.id, {}, identity);
  await service.waitForIdle();
  const entries = service.list("confirmations", identity.profileId).map((item) => ({
    applicationId: item.applicationId, previewFingerprint: item.previewFingerprint
  }));
  await assert.rejects(service.approvePreparedBatch([
    entries[0], { ...entries[1], previewFingerprint: "bad" }
  ], identity), { status: 409 });
  assert.equal(service.list("confirmations", identity.profileId).filter((item) => item.status === "pending").length, 2);
  await service.approvePreparedBatch(entries, identity);
  await service.waitForIdle();
  assert.equal(service.list("applications", identity.profileId).filter((item) => item.status === "submitted").length, 2);
});

test("an active timed-out worker blocks manual retry", async () => {
  const service = await serviceFixture({ name: "uncertain-test",
    async submit() { throw new NeedsReviewError("lost", [{ kind: "submission_unverified", action: "manual_review" }]); },
    async attemptStatus() { return { status: "active" }; }
  });
  const job = await service.addOpportunity({ title: "Engineer", company: "Example",
    applyUrl: "https://example.test/apply", score: 90 }, identity);
  await service.requestApplication(job.id, {}, identity);
  await service.waitForIdle();
  const confirmation = service.list("confirmations", identity.profileId)[0];
  await assert.rejects(service.resolveConfirmation(confirmation.id,
    { approved: true, answers: { retry: true } }, identity), { status: 409 });
});

test("a worker with a durable final-action marker blocks retry", async () => {
  const service = await serviceFixture({ name: "final-action-uncertain-test",
    async submit() { throw new NeedsReviewError("lost", [{ kind: "submission_unverified", action: "manual_review" }]); },
    async attemptStatus() { return { status: "final_action_started" }; }
  });
  const job = await service.addOpportunity({ title: "Engineer", company: "Example",
    applyUrl: "https://example.test/apply", score: 90 }, identity);
  await service.requestApplication(job.id, {}, identity);
  await service.waitForIdle();
  const confirmation = service.list("confirmations", identity.profileId)[0];
  await assert.rejects(service.resolveConfirmation(confirmation.id,
    { approved: true, answers: { retry: true } }, identity), { status: 409 });
});

test("an older automatic application adopts current final-review policy on a safe retry", async () => {
  let runs = 0;
  let retriedApplication;
  const service = await serviceFixture({ name: "approval-upgrade-test",
    async submit(payload) {
      runs += 1;
      if (runs === 1) throw new NeedsReviewError("lost", [{ kind: "submission_unverified", action: "manual_review" }]);
      retriedApplication = payload.application;
      throw new NeedsInputError("Final review", [{ kind: "final_submission_approval" }]);
    },
    async attemptStatus() { return { status: "before_final_action" }; }
  });
  const job = await service.addOpportunity({ title: "Engineer", company: "Example",
    applyUrl: "https://example.test/apply", score: 90 }, identity);
  await service.requestApplication(job.id, {}, identity);
  await service.waitForIdle();
  assert.equal(service.list("applications", identity.profileId)[0].finalApprovalRequired, false);
  service.config.modes.full_time.submissionApproval = "always";
  const confirmation = service.list("confirmations", identity.profileId)[0];
  await service.resolveConfirmation(confirmation.id, { approved: true, answers: { retry: true } }, identity);
  await service.waitForIdle();
  assert.equal(retriedApplication.finalApprovalRequired, true);
  assert.equal(retriedApplication.submissionApproval, "always");
});

test("a late worker receipt is reconciled without a second browser submission", async () => {
  let submissions = 0;
  const service = await serviceFixture({ name: "late-receipt-test",
    async submit() { submissions += 1;
      throw new NeedsReviewError("lost", [{ kind: "submission_unverified", action: "manual_review" }]);
    },
    async attemptStatus() { return { status: "submitted", receipt: {
      submittedAt: new Date().toISOString(), finalUrl: "https://example.test/done"
    } }; }
  });
  const job = await service.addOpportunity({ title: "Engineer", company: "Example",
    applyUrl: "https://example.test/apply", score: 90 }, identity);
  await service.requestApplication(job.id, {}, identity);
  await service.waitForIdle();
  const confirmation = service.list("confirmations", identity.profileId)[0];
  const result = await service.resolveConfirmation(confirmation.id,
    { approved: true, answers: { retry: true } }, identity);
  assert.equal(result.status, "submitted");
  assert.equal(submissions, 1);
});

test("source query coalesces board fetches and rejects an unconfigured board", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-efficiency-discovery-"));
  const profiles = await new ProfileStore(path.join(directory, "profiles.json"), { allowMissing: true }).init();
  await profiles.patch("owner", { skills: ["Node.js"], preferences: {
    locations: ["Remote"], fullTime: { jobTitles: ["Engineer"], automatedDiscoverySources: ["ashby"] }
  } });
  const service = await serviceFixture({ name: "unused", async submit() { throw new Error("unused"); } });
  const config = { defaultMode: "full_time", discovery: { sourceOptions: {
    ashby: { boards: [{ slug: "example", company: "Example" }] }
  } }, modes: { full_time: { minimumScore: 0, autoApply: false, sources: ["ashby"] } } };
  let requests = 0;
  const discovery = new DiscoveryService({ applicationService: service, profiles, config,
    fetchImpl: async () => {
      requests += 1;
      return new Response(JSON.stringify({ jobs: ["Service Engineer", "Data Engineer"].map((title, index) => ({
        id: String(index), title, applyUrl: `https://jobs.ashbyhq.com/example/${index}/application`,
        jobUrl: `https://jobs.ashbyhq.com/example/${index}`, descriptionPlain: "Node.js",
        location: "Remote", isRemote: true, isListed: true, publishedAt: "2026-09-01"
      })) }));
    } });
  const input = { source: "ashby", scanCycleId: "cycle-one", idempotencyKey: "query-one",
    queries: [{ filters: { title: "Service" }, limit: 10 }, { filters: { title: "Data" }, limit: 10 }] };
  const result = await discovery.query(input, identity);
  assert.equal(result.found, 2);
  assert.equal(requests, 1);
  await discovery.query(input, identity);
  assert.equal(requests, 1);
  await assert.rejects(discovery.query({ ...input, idempotencyKey: "query-two",
    queries: [{ filters: { board: "other" } }] }, identity), { status: 400 });
});

test("service, webhook, and browser worker replay an exact approved preview", async () => {
  const browser = await chromium.launch();
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-efficiency-e2e-"));
  const html = `<form onsubmit="event.preventDefault();document.body.textContent='Application submitted'">
    <label>First name <input name="first_name" required></label>
    <label>Email <input name="email" type="email" required></label>
    <button type="submit">Submit Application</button></form>`;
  const worker = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const context = await browser.newContext();
    try {
      const result = await automateApplication({ page: await context.newPage(),
        profile: payload.profile, opportunity: payload.opportunity, application: payload.application,
        evidencePacket: payload.evidencePacket, artifactsDirectory: directory });
      response.writeHead(result.status === "submitted" ? 200 : 409,
        { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } finally { await context.close(); }
  });
  await new Promise((resolve) => worker.listen(0, "127.0.0.1", resolve));
  try {
    const store = await new JsonStore(path.join(directory, "state.json")).init();
    const config = { defaultMode: "full_time", modes: { full_time: {
      minimumScore: 0, autoApply: true, dailyApplicationCap: 10,
      requireConfirmationFor: [], submissionApproval: "always", sources: []
    } } };
    const profiles = { async get() { return profile; }, async status() {
      return { readyToApply: true, missingForApplications: [] };
    } };
    const adapter = new WebhookAdapter({ url: `http://127.0.0.1:${worker.address().port}/v1/submit` });
    const service = new ApplicationService({ store, config, adapter, profiles });
    const job = await service.addOpportunity({ title: "Engineer", company: "Example",
      applyUrl: htmlUrl(html), score: 90 }, identity);
    await service.requestApplication(job.id, {}, identity);
    await service.waitForIdle();
    const pending = service.list("confirmations", identity.profileId)[0];
    assert.equal(pending.kind, "final_submission_approval");
    assert.equal(pending.preview.filled.find((item) => item.key === "email").value, "ada@example.test");
    assert.equal(service.list("applications", identity.profileId)[0].checkpoint.version, 1);
    await service.approvePreparedBatch([{ applicationId: pending.applicationId,
      previewFingerprint: pending.previewFingerprint }], identity);
    await service.waitForIdle();
    const submitted = service.list("applications", identity.profileId)[0];
    assert.equal(submitted.status, "submitted");
    assert.equal(submitted.receipt.simulated, false);
  } finally {
    await new Promise((resolve) => worker.close(resolve));
    await browser.close();
  }
});
