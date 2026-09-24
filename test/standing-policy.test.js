import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProfileStore } from "../src/profile-store.js";
import { JsonStore } from "../src/store.js";
import { ApplicationService } from "../src/service.js";
import { SimulationAdapter } from "../src/adapters/simulation.js";
import { createHttpServer } from "../src/http.js";
import { DiscoveryService } from "../src/discovery/service.js";
import { officialAtsDestination } from "../src/discovery/official-ats.js";

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

async function prepared(service, extra = {}, requestInput = {}) {
  const role = await service.addOpportunity({ title: "Engineer", company: "Example",
    applyUrl: "https://example.test/apply", score: 100,
    applicationDestinationVerified: true, ...extra }, agent, { serverVerifiedDiscovery: true });
  const application = await service.requestApplication(role.id, requestInput, agent);
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

test("ambiguous same-title opening stays reviewable and cannot receive an automatic final permit", async () => {
  const { profiles, service } = await fixture();
  await profiles.setStandingSubmissionPolicy("person", { ...policy, dailyCap: 2, campaignCap: 2 }, owner);
  const first = await service.addOpportunity({ title: "Engineer", company: "Example",
    applyUrl: "https://example.test/jobs/one", score: 100,
    applicationDestinationVerified: true }, agent, { serverVerifiedDiscovery: true });
  await service.requestApplication(first.id, {}, agent);
  const second = await service.addOpportunity({ title: "Engineer", company: "Example",
    applyUrl: "https://example.test/jobs/two", score: 100,
    applicationDestinationVerified: true }, agent, { serverVerifiedDiscovery: true });
  const application = await service.requestApplication(second.id, {}, agent);
  assert.equal(application.status, "waiting_confirmation");
  assert.equal(application.finalApprovalRequired, true);
  assert.ok(application.decision.confirmations.some((item) => item.kind === "possible_duplicate"));
  await service.store.mutate((state) => {
    const current = state.applications.find((item) => item.id === application.id);
    current.status = "submitting";
    current.claim = { attemptId: "attempt-one" };
  });
  const result = await service.prepareFinalSubmission(decisionInput(application, {
    preview: { ...decisionInput(application).preview, destination: "https://example.test/jobs/two" }
  }));
  assert.equal(result.decision, "hold");
  assert.ok(result.reasonCodes.includes("possible_duplicate_identity_unresolved"));
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
    applyUrl: "https://example.test/apply/two", score: 100,
    applicationDestinationVerified: true }, agent, { serverVerifiedDiscovery: true });
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

test("a target above 50 requires explicit owner daily and campaign authority", async () => {
  const { profiles, service } = await fixture();
  const create = (target) => service.createCampaign({ id: randomUUID(), target, reserve: 10,
    mode: "full_time" }, agent);
  await assert.rejects(create(51), /active owner standing policy/);
  await profiles.setStandingSubmissionPolicy("person", { ...policy, dailyCap: 100,
    campaignCap: 99 }, owner);
  await assert.rejects(create(100), /matching daily and campaign caps/);
  await profiles.setStandingSubmissionPolicy("person", { ...policy, dailyCap: 100,
    campaignCap: 100 }, owner);
  assert.equal((await create(100)).target, 100);
  await assert.rejects(create(101), /target from 1 to 100/);
  await profiles.setStandingSubmissionPolicy("person", { ...policy, mode: "always",
    dailyCap: 100, campaignCap: 100 }, owner);
  await assert.rejects(create(51), /active owner standing policy/);
});

test("owner final-action cap spans campaign waves and counts consumed attempts", async () => {
  const { profiles, service } = await fixture();
  await profiles.setStandingSubmissionPolicy("person", { ...policy, dailyCap: 2,
    campaignCap: 1 }, owner);
  const campaigns = await Promise.all(Array.from({ length: 3 }, () => service.createCampaign({
    id: randomUUID(), target: 1, reserve: 0, mode: "full_time" }, agent)));
  for (let index = 0; index < 3; index += 1) {
    const url = `https://example.test/apply/${index}`;
    const title = `Engineer ${index}`;
    const application = await prepared(service, { title, applyUrl: url },
      { campaignId: campaigns[index].campaignId });
    const input = decisionInput(application, { preview: { ...decisionInput(application).preview,
      title, destination: url } });
    const decision = await service.prepareFinalSubmission(input);
    if (index < 2) {
      assert.equal(decision.decision, "permit");
      await service.commitFinalSubmission({ applicationId: application.id, attemptId: "attempt-one",
        previewFingerprint: input.previewFingerprint, permit: decision.permit });
    } else assert.ok(decision.reasonCodes.includes("daily_cap_reached"));
  }
});

test("a crash after server commit but before browser phase marker cannot mint another permit", async () => {
  const { profiles, service } = await fixture();
  await profiles.setStandingSubmissionPolicy("person", { ...policy, dailyCap: 2,
    campaignCap: 2 }, owner);
  const application = await prepared(service);
  const input = decisionInput(application);
  const decision = await service.prepareFinalSubmission(input);
  assert.equal(decision.decision, "permit");
  await service.commitFinalSubmission({ applicationId: application.id,
    attemptId: "attempt-one", previewFingerprint: input.previewFingerprint,
    permit: decision.permit });
  const replay = await service.prepareFinalSubmission(input);
  assert.deepEqual(replay, { decision: "hold", reasonCodes: ["prior_final_action_uncertain"] });
  await assert.rejects(service.commitFinalSubmission({ applicationId: application.id,
    attemptId: "attempt-one", previewFingerprint: input.previewFingerprint,
    permit: decision.permit }), /invalid or revoked/);
});

test("a covered reservation cannot raise the ordinary manual approval ceiling", async () => {
  const { profiles, service } = await fixture();
  service.config.execution.maxApplicationsPerDay = 1;
  service.config.modes.full_time.dailyApplicationCap = 1;
  await profiles.setStandingSubmissionPolicy("person", { ...policy, dailyCap: 100,
    campaignCap: 100 }, owner);
  const manualRole = await service.addOpportunity({ title: "Manual Engineer", company: "Example",
    applyUrl: "https://other.test/manual", score: 100 }, agent);
  const manual = await service.requestApplication(manualRole.id, {}, agent);
  const fingerprint = "b".repeat(64);
  await service.store.mutate((state) => {
    const item = state.applications.find((entry) => entry.id === manual.id);
    item.createdAt = new Date(Date.now() - 86_400_000).toISOString();
    for (const confirmation of state.confirmations.filter((entry) => entry.applicationId === manual.id)) {
      confirmation.status = "superseded";
    }
    state.confirmations.push({ id: randomUUID(), profileId: "person", applicationId: manual.id,
      kind: "final_submission_approval", status: "pending", previewFingerprint: fingerprint,
      createdAt: new Date().toISOString() });
  });
  const covered = await prepared(service);
  assert.equal((await service.prepareFinalSubmission(decisionInput(covered))).decision, "permit");
  await assert.rejects(service.approvePreparedBatch([{ applicationId: manual.id,
    previewFingerprint: fingerprint }], agent), /global daily application cap/);
  assert.equal(service.list("applications", "person").find((item) => item.id === manual.id).status,
    "waiting_confirmation");
});

test("an exact manual approval consumes the owner final-action daily cap", async () => {
  const { profiles, service } = await fixture();
  await profiles.setStandingSubmissionPolicy("person", policy, owner);
  const manualRole = await service.addOpportunity({ title: "Manual Engineer", company: "Example",
    applyUrl: "https://other.test/manual", score: 100 }, agent);
  const manual = await service.requestApplication(manualRole.id, {}, agent);
  await service.store.mutate((state) => {
    const item = state.applications.find((entry) => entry.id === manual.id);
    item.finalSubmissionApproval = { approvedAt: new Date().toISOString(),
      previewFingerprint: "b".repeat(64) };
    item.status = "queued";
  });
  const covered = await prepared(service);
  const decision = await service.prepareFinalSubmission(decisionInput(covered));
  assert.ok(decision.reasonCodes.includes("daily_cap_reached"));
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
    assert.deepEqual((await profiles.get("person")).standingPolicyHistory.map((entry) => entry.version), [1]);
    const other = await fetch(`${base}/v1/standing-submission-policy`, {
      headers: { authorization: "Bearer other-owner" } });
    assert.equal((await other.json()).policy, null);
    const callback = await fetch(`${base}/v1/internal/final-decision`, { method: "POST",
      headers: { authorization: "Bearer agent-secret", "content-type": "application/json" },
      body: "{}" });
    assert.equal(callback.status, 403);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("forged source, score, user intent, and direct URL cannot obtain standing authority", async () => {
  const { profiles, service } = await fixture();
  await profiles.setStandingSubmissionPolicy("person", policy, owner);
  const forged = await service.addOpportunity({ title: "Engineer", company: "Example",
    applyUrl: "https://example.test/forged", source: "agent", score: 100,
    userRequested: true, applicationDestinationVerified: true,
    discoveryVerification: { sourceId: "agent", verifiedAt: new Date().toISOString(), score: 100 } }, agent);
  assert.equal(forged.discoveryVerification, undefined);
  const application = await service.requestApplication(forged.id, {}, agent);
  assert.equal(application.finalApprovalRequired, true);
  assert.equal(application.status, "waiting_confirmation");
  const direct = await service.directApplication({ url: "https://example.test/direct" }, agent);
  assert.equal(direct.application.finalApprovalRequired, true);
});

test("stale or closed verified discovery cannot receive a final permit", async () => {
  const { profiles, service } = await fixture();
  await profiles.setStandingSubmissionPolicy("person", policy, owner);
  const application = await prepared(service);
  await service.store.mutate((state) => {
    const opportunity = state.opportunities.find((item) => item.id === application.opportunityId);
    opportunity.discoveryVerification.verifiedAt = new Date(Date.now() - 11 * 60_000).toISOString();
  });
  const stale = await service.prepareFinalSubmission(decisionInput(application));
  assert.ok(stale.reasonCodes.includes("discovery_unverified_or_stale"));
  await service.store.mutate((state) => {
    const opportunity = state.opportunities.find((item) => item.id === application.opportunityId);
    opportunity.discoveryVerification.verifiedAt = new Date().toISOString();
    opportunity.validThrough = new Date(Date.now() - 60_000).toISOString();
  });
  const closed = await service.prepareFinalSubmission(decisionInput(application));
  assert.ok(closed.reasonCodes.includes("discovery_unverified_or_stale"));
});

test("work authorization and sponsorship wording holds automatic final action", async () => {
  const { profiles, service } = await fixture();
  await profiles.setStandingSubmissionPolicy("person", policy, owner);
  const application = await prepared(service);
  for (const label of ["Are you authorized to work in Germany?", "Will you require sponsorship?",
    "Do you have a valid visa?", "Do you have the right to work in the EU?"]) {
    const result = await service.prepareFinalSubmission(decisionInput(application, {
      preview: { ...decisionInput(application).preview,
        filled: [{ key: "legal_question", label, value: "Yes", source: "verified profile fact" }] }
    }));
    assert.ok(result.reasonCodes.includes("legal_answer_unconfirmed"), label);
  }
});

test("an official Ashby campaign result reaches the standing final permit", async () => {
  const { profiles, service } = await fixture();
  await profiles.patch("person", { skills: ["TypeScript"], preferences: { locations: ["Remote"],
    fullTime: { jobTitles: ["Engineer"], automatedDiscoverySources: ["ashby"] } } });
  service.config.discovery = { limitPerSource: 10, sourceOptions: { ashby: {
    boards: [{ slug: "example", company: "Example" }] } } };
  service.config.modes.full_time.sources = ["ashby"];
  await profiles.setStandingSubmissionPolicy("person", { ...policy, sources: ["ashby"],
    destinationHosts: ["jobs.ashbyhq.com"] }, owner);
  const id = "11111111-1111-4111-8111-111111111111";
  const applyUrl = `https://jobs.ashbyhq.com/example/${id}/application`;
  const job = { id, title: "Engineer", jobUrl: `https://jobs.ashbyhq.com/example/${id}`,
    applyUrl, descriptionPlain: "TypeScript", location: "Remote", isRemote: true,
    isListed: true, publishedAt: new Date().toISOString() };
  const discovery = new DiscoveryService({ applicationService: service, profiles,
    config: service.config, fetchImpl: async () => new Response(JSON.stringify({ jobs: [job] })) });
  const campaign = await discovery.startCampaign({ target: 1, reserve: 0,
    sources: ["ashby"], fallbackSources: [] }, agent);
  assert.equal(campaign.applications.length, 1);
  const application = service.list("applications", "person")[0];
  const role = service.list("opportunities", "person")[0];
  assert.equal(role.applicationDestinationVerified, true);
  assert.equal(application.finalApprovalRequired, false);
  const report = service.campaignWorkflowReport(campaign.campaignId, "person");
  assert.equal(report.sourceYield[0].sourceId, "ashby");
  assert.equal(report.sourceYield[0].selected, 1);
  assert.ok(report.stages.discovery.measuredMs !== null);
  await service.store.mutate((state) => {
    const item = state.applications.find((entry) => entry.id === application.id);
    item.status = "submitting";
    item.claim = { attemptId: "attempt-one" };
  });
  const result = await service.prepareFinalSubmission(decisionInput(application, {
    preview: { ...decisionInput(application).preview, destination: applyUrl,
      title: "Engineer", company: "Example" }
  }));
  assert.equal(result.decision, "permit", result.reasonCodes?.join(", "));
});

test("official ATS destination requires matching host, board, and role ID", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const role = { source: "ashby", externalId: `example:${id}`,
    applyUrl: `https://jobs.ashbyhq.com/example/${id}/application` };
  assert.equal(officialAtsDestination(role), true);
  assert.equal(officialAtsDestination({ ...role, applyUrl: `https://evil.example/example/${id}` }), false);
  assert.equal(officialAtsDestination({ ...role, applyUrl: `https://jobs.ashbyhq.com/other/${id}` }), false);
});

test("a stale official ATS role is revalidated once before final permit", async () => {
  const { profiles, service } = await fixture();
  await profiles.setStandingSubmissionPolicy("person", { ...policy, sources: ["ashby"],
    destinationHosts: ["jobs.ashbyhq.com"] }, owner);
  const id = "11111111-1111-4111-8111-111111111111";
  const applyUrl = `https://jobs.ashbyhq.com/example/${id}/application`;
  const role = await service.addOpportunity({ title: "Engineer", company: "Example", source: "ashby",
    externalId: `example:${id}`, applyUrl, score: 100, mode: "full_time",
    applicationDestinationVerified: true }, agent, { serverVerifiedDiscovery: true });
  let fetches = 0;
  service.fetchImpl = async () => { fetches += 1; return new Response(JSON.stringify({ jobs: [{
    id, title: "Engineer", applyUrl, isListed: true }] })); };
  await service.store.mutate((state) => {
    state.opportunities[0].discoveryVerification.verifiedAt =
      new Date(Date.now() - 20 * 60_000).toISOString();
  });
  const application = await service.requestApplication(role.id, {}, agent);
  assert.equal(application.finalApprovalRequired, false);
  assert.equal(fetches, 1);
  await service.store.mutate((state) => {
    state.applications[0].status = "submitting";
    state.applications[0].claim = { attemptId: "attempt-one" };
  });
  const result = await service.prepareFinalSubmission(decisionInput(application, {
    preview: { ...decisionInput(application).preview, destination: applyUrl }
  }));
  assert.equal(result.decision, "permit", result.reasonCodes?.join(", "));
  assert.equal(fetches, 1);
});

test("a closed official ATS role cannot refresh standing authorization", async () => {
  const { profiles, service } = await fixture();
  await profiles.setStandingSubmissionPolicy("person", { ...policy, sources: ["ashby"],
    destinationHosts: ["jobs.ashbyhq.com"] }, owner);
  const id = "11111111-1111-4111-8111-111111111111";
  const role = await service.addOpportunity({ title: "Engineer", company: "Example", source: "ashby",
    externalId: `example:${id}`, applyUrl: `https://jobs.ashbyhq.com/example/${id}/application`,
    score: 100, mode: "full_time", applicationDestinationVerified: true },
  agent, { serverVerifiedDiscovery: true });
  await service.store.mutate((state) => {
    state.opportunities[0].discoveryVerification.verifiedAt =
      new Date(Date.now() - 20 * 60_000).toISOString();
  });
  service.fetchImpl = async () => new Response(JSON.stringify({ jobs: [] }));
  const application = await service.requestApplication(role.id, {}, agent);
  assert.equal(application.finalApprovalRequired, true);
  assert.equal(application.status, "waiting_confirmation");
});
