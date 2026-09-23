import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NeedsInputError } from "../src/adapters/errors.js";
import { DiscoveryService } from "../src/discovery/service.js";
import { ProfileStore } from "../src/profile-store.js";
import { ApplicationService } from "../src/service.js";
import { JsonStore } from "../src/store.js";

const identity = { actorId: "campaign-owner", profileId: "campaign-owner" };

test("campaign scans once, prepares a reserve sequentially, and submits only the exact approved target", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-campaign-"));
  const profiles = await new ProfileStore(path.join(directory, "profiles.json"), { allowMissing: true }).init();
  await profiles.patch(identity.profileId, {
    contact: { firstName: "Applicant", lastName: "Example", email: "applicant@example.test",
      phone: "+10000000000", location: "Remote" },
    documents: { resume: "/secure/resume.pdf" },
    skills: ["TypeScript", "Node.js"],
    preferences: { locations: ["Remote"], fullTime: {
      jobTitles: ["Senior Engineer"], automatedDiscoverySources: ["remoteok"], submissionApproval: "automatic"
    } }
  });
  const config = { defaultMode: "full_time", execution: { concurrency: 4 },
    discovery: { limitPerSource: 10 }, modes: { full_time: {
      minimumScore: 0, autoApply: true, autoApplyDiscovered: false, dailyApplicationCap: 20,
      submissionApproval: "automatic", sources: ["remoteok"], requireConfirmationFor: []
    } } };
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  let active = 0; let maximumActive = 0;
  const adapter = { name: "campaign-test", async submit({ application }) {
    active += 1; maximumActive = Math.max(maximumActive, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const fingerprint = application.id.replaceAll("-", "").padEnd(64, "a").slice(0, 64);
      if (application.finalSubmissionApproval?.previewFingerprint !== fingerprint) {
        throw new NeedsInputError("Review", [{ kind: "final_submission_approval", previewFingerprint: fingerprint,
          preview: { filled: [{ label: "Email", value: "applicant@example.test", source: "profile" }],
            unfilled: [] } }]);
      }
      return { submittedAt: new Date().toISOString(), finalUrl: "https://employer.example.test/success" };
    } finally { active -= 1; }
  } };
  const service = new ApplicationService({ store, config, adapter, profiles });
  let fetches = 0;
  const discovery = new DiscoveryService({ applicationService: service, profiles, config,
    fetchImpl: async () => {
      fetches += 1;
      return new Response(JSON.stringify([{ legal: "metadata" }, ...["one", "two", "three"].map((id) => ({
        id, position: `Senior Engineer ${id}`, company: `Company ${id}`,
        description: "TypeScript Node.js", tags: ["TypeScript", "Node.js"], location: "Worldwide",
        date: new Date().toISOString(), url: `https://remoteok.com/jobs/${id}`,
        apply_url: `https://${id}.employer.example.test/apply`
      }))]));
    } });

  const started = await discovery.startCampaign({ target: 2, reserve: 1 }, identity);
  assert.equal(started.target, 2);
  assert.equal(started.applications.length, 3);
  assert.equal(fetches, 1);
  await service.waitForIdle();

  const prepared = service.campaignStatus(started.campaignId, identity.profileId);
  assert.equal(prepared.status, "awaiting_batch_review", JSON.stringify(prepared));
  assert.equal(prepared.readyForReview, 3);
  assert.equal(prepared.reviewEntries[0].company.startsWith("Company "), true);
  assert.match(prepared.reviewEntries[0].destination, /^https:\/\//);
  assert.equal(prepared.timing.workerAttempts, 3);
  assert.ok(prepared.timing.workerActiveMs >= 0);
  assert.ok(prepared.timing.scanMs >= 0);
  assert.ok(prepared.timing.preparationMs >= 0);
  assert.equal(maximumActive, 1);
  await service.approveCampaign(started.campaignId, prepared.reviewEntries.slice(0, 2), identity);
  await service.waitForIdle();

  const complete = service.campaignStatus(started.campaignId, identity.profileId);
  assert.equal(complete.status, "complete");
  assert.equal(complete.submitted, 2);
  assert.equal(complete.counts.waiting_confirmation, 1);
  assert.ok(complete.completedAt);
  assert.ok(complete.timing.submissionMs >= 0);
  assert.equal(service.listCampaigns(identity.profileId)[0].campaignId, started.campaignId);
});

test("campaign rechecks handled ATS identity after a public-board redirect", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-campaign-redirect-"));
  const profiles = await new ProfileStore(path.join(directory, "profiles.json"), { allowMissing: true }).init();
  await profiles.patch(identity.profileId, {
    contact: { firstName: "Applicant", lastName: "Example", email: "applicant@example.test",
      phone: "+10000000000", location: "Remote" },
    documents: { resume: "/secure/resume.pdf" }, skills: ["TypeScript", "Node.js"],
    preferences: { locations: ["Remote"], fullTime: {
      jobTitles: ["Senior Engineer"], automatedDiscoverySources: ["arbeitnow"], submissionApproval: "always"
    } }
  });
  const config = { defaultMode: "full_time", execution: { concurrency: 1 }, discovery: { limitPerSource: 10 },
    modes: { full_time: { minimumScore: 0, autoApply: false, autoApplyDiscovered: false,
      dailyApplicationCap: 20, submissionApproval: "always", sources: ["arbeitnow"], requireConfirmationFor: [] } } };
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  const service = new ApplicationService({ store, config, adapter: { name: "unused", async submit() {} }, profiles });
  const existing = await service.addOpportunity({ source: "ashby", externalId: "constructor:role-1",
    company: "Constructor", title: "Senior Engineer", score: 100, mode: "full_time", remote: true,
    applyUrl: "https://jobs.ashbyhq.com/constructor/11111111-1111-4111-8111-111111111111/application" }, identity);
  const submitted = await service.requestApplication(existing.id, {}, identity);
  await service.recordManualSubmission(submitted.id, { manuallyVerified: true,
    finalUrl: "https://jobs.ashbyhq.com/constructor/11111111-1111-4111-8111-111111111111/application/submitted" }, identity);
  const discovery = new DiscoveryService({ applicationService: service, profiles, config,
    fetchImpl: async (url) => String(url).endsWith("/apply")
      ? new Response(null, { status: 302, headers: { location: existing.applyUrl } })
      : new Response(JSON.stringify({ data: [{ slug: "aggregated-role", title: "Senior Engineer",
        company_name: "Constructor", description: "TypeScript Node.js", tags: ["TypeScript"],
        job_types: ["full_time"], location: "Remote", remote: true,
        url: "https://www.arbeitnow.com/jobs/companies/constructor/aggregated-role" }] })) });

  const result = await discovery.startCampaign({ target: 1, reserve: 0 }, identity);
  assert.equal(result.status, "insufficient_candidates");
  assert.equal(result.scan.handledFiltered, 1);
  assert.equal(result.applications.length, 0);
  assert.equal(result.endedAt, result.scanCompletedAt);
  const elapsed = result.elapsedMs;
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(service.campaignStatus(result.campaignId, identity.profileId).elapsedMs, elapsed);
});

test("campaign searches every fallback source, caps each pool at ten, then ranks globally", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-campaign-all-sources-"));
  const profiles = await new ProfileStore(path.join(directory, "profiles.json"), { allowMissing: true }).init();
  await profiles.patch(identity.profileId, {
    contact: { firstName: "Applicant", lastName: "Example", email: "applicant@example.test",
      phone: "+10000000000", location: "Remote" },
    documents: { resume: "/secure/resume.pdf" }, skills: ["TypeScript", "Node.js", "PostgreSQL"],
    preferences: { locations: ["Remote", "Europe"], fullTime: {
      jobTitles: ["Senior Engineer"], remoteOnly: true,
      automatedDiscoverySources: ["remoteok"], submissionApproval: "always"
    } }
  });
  const config = { defaultMode: "full_time", execution: { concurrency: 1 }, discovery: { limitPerSource: 50 },
    modes: { full_time: { minimumScore: 0, autoApply: true, autoApplyDiscovered: false,
      dailyApplicationCap: 20, submissionApproval: "always", sources: ["remoteok"], requireConfirmationFor: [] } } };
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  const adapter = { name: "fallback-test", async submit({ application }) {
    const fingerprint = application.id.replaceAll("-", "").padEnd(64, "b").slice(0, 64);
    throw new NeedsInputError("Review", [{ kind: "final_submission_approval", previewFingerprint: fingerprint,
      preview: { filled: [{ label: "Email", value: "applicant@example.test", source: "profile" }], unfilled: [] } }]);
  } };
  const service = new ApplicationService({ store, config, adapter, profiles });
  const discovery = new DiscoveryService({ applicationService: service, profiles, config,
    fetchImpl: async () => new Response(JSON.stringify([{ legal: "metadata" }])) });
  const previouslySeen = await service.addOpportunity({ source: "old", title: "Senior Engineer Seen",
    company: "Seen Co", applyUrl: "https://seen.example.test/jobs/1", location: "Worldwide", remote: true }, identity);

  const started = await discovery.startCampaign({ target: 2, reserve: 0,
    fallbackSources: ["board_one", "board_two"] }, identity);
  assert.equal(started.status, "searching_more_sources");
  assert.deepEqual(started.sourceCoverage.primary, ["remoteok"]);
  assert.equal(started.sourceCoverage.plannedCount, 3);
  const make = (index, board = "one") => ({ title: `Senior Engineer ${board}-${index}`,
    company: `Board ${board} ${index}`, description: board === "two" ? "TypeScript Node.js PostgreSQL" : "engineering",
    location: "Worldwide", remote: true, employmentType: "full_time",
    postedAt: new Date(Date.now() - index * 1000).toISOString(),
    applyUrl: `https://${board}.example.test/jobs/${index}` });
  const first = await discovery.addCampaignSourceResults(started.campaignId, {
    sourceId: "board_one", completed: false, pagesVisited: 1, requestsMade: 7,
    items: [{ ...make(99), applyUrl: previouslySeen.applyUrl },
      { ...make(98), applyUrl: "https://one.example.test/jobs/office", remote: false, location: "Office" },
      ...Array.from({ length: 6 }, (_, index) => make(index))]
  }, identity);
  assert.equal(first.status, "searching_more_sources");
  assert.equal(first.sourceCoverage.scans[0].selected, 6);
  assert.equal(first.sourceCoverage.scans[0].handledFiltered, 1);
  assert.deepEqual(first.sourceCoverage.scans[0].exclusionReasons,
    [{ reason: "profile requires a remote role", count: 1 }]);
  const second = await discovery.addCampaignSourceResults(started.campaignId, {
    sourceId: "board_one", completed: true, exhausted: true, pagesVisited: 2, requestsMade: 6,
    items: Array.from({ length: 6 }, (_, index) => make(index + 6))
  }, identity);
  assert.equal(second.sourceCoverage.scans[1].selected, 4);
  assert.equal(second.candidatePoolSize, 10);
  assert.deepEqual(second.sourceCoverage.fallbackRemaining, ["board_two"]);
  await discovery.addCampaignSourceResults(started.campaignId, {
    sourceId: "board_two", completed: true, exhausted: true, pagesVisited: 3, requestsMade: 4,
    items: [make(1, "two"), make(2, "two")]
  }, identity);
  await service.waitForIdle();
  const prepared = service.campaignStatus(started.campaignId, identity.profileId);
  assert.equal(prepared.status, "awaiting_batch_review");
  assert.equal(prepared.candidatePoolSize, 12);
  assert.equal(prepared.applications.length, 2);
  assert.equal(prepared.applications.every((item) => item.company.startsWith("Board two")), true);
  assert.equal(prepared.sourceCoverage.coveredCount, 3);
  assert.deepEqual(prepared.sourceCoverage.fallbackRemaining, []);
});
