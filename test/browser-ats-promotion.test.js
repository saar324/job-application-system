import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DiscoveryService } from "../src/discovery/service.js";
import { fetchVerifiedOfficialAtsRole } from "../src/discovery/official-ats.js";
import { ProfileStore } from "../src/profile-store.js";
import { ApplicationService } from "../src/service.js";
import { JsonStore } from "../src/store.js";
import { SimulationAdapter } from "../src/adapters/simulation.js";

const identity = { actorId: "agent", profileId: "person", roles: ["agent"] };
const owner = { actorId: "owner", profileId: "person", roles: ["owner"] };
const roleId = "11111111-1111-4111-8111-111111111111";
const applyUrl = `https://jobs.ashbyhq.com/example/${roleId}/application`;
const job = { id: roleId, title: "Senior Engineer", applyUrl,
  jobUrl: `https://jobs.ashbyhq.com/example/${roleId}`, descriptionPlain: "TypeScript Node.js",
  location: "Remote", isRemote: true, isListed: true, employmentType: "Full-Time" };
const browserCandidate = { title: "Senior Engineer", company: "Forged Company",
  description: "Forged excellent TypeScript Node.js fit", score: 999,
  source: "ashby", externalId: `other:${roleId}`, userRequested: true,
  location: "Remote", remote: true, applyUrl, listingUrl: "https://board.example.test/role",
  applicationDestinationVerified: true };

async function fixture(fetchImpl) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "browser-ats-promotion-"));
  const profiles = await new ProfileStore(path.join(directory, "profiles.json"), { allowMissing: true }).init();
  await profiles.patch("person", { contact: { firstName: "Ada", lastName: "Lovelace",
    email: "ada@example.test", phone: "+10000000000", location: "Remote" },
  documents: { resume: "/private/resume.pdf" }, skills: ["TypeScript", "Node.js"],
  preferences: { locations: ["Remote"], fullTime: { jobTitles: ["Senior Engineer"], remoteOnly: true,
    automatedDiscoverySources: [] } } });
  await profiles.setStandingSubmissionPolicy("person", { mode: "automatic", modes: ["full_time"],
    sources: ["ashby"], destinationHosts: ["jobs.ashbyhq.com"],
    answerClasses: ["profile_fact", "resume", "link", "grounded_prose"],
    dailyCap: 10, campaignCap: 10 }, owner);
  const config = { defaultMode: "full_time", execution: { maxApplicationsPerDay: 10 },
    discovery: { sourceOptions: { ashby: { boards: [{ slug: "example", company: "Example" }] } } },
    modes: { full_time: { minimumScore: 0, autoApply: false, dailyApplicationCap: 8,
      sources: [], requireConfirmationFor: [] } } };
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  const service = new ApplicationService({ store, profiles, config, adapter: new SimulationAdapter() });
  service.enqueue = () => {};
  const discovery = new DiscoveryService({ applicationService: service, profiles, config, fetchImpl });
  const campaign = await discovery.startCampaign({ target: 1, reserve: 0, sources: [],
    fallbackSources: ["board_one", "board_two"] }, identity);
  return { service, discovery, campaign };
}

test("official lookup rejects closed, mismatched, and non-remote ATS rows", async () => {
  const sourceOptions = { ashby: { boards: [{ slug: "example", company: "Example" }] } };
  for (const rows of [[], [{ ...job, id: "22222222-2222-4222-8222-222222222222" }],
    [{ ...job, isListed: false }], [{ ...job, isRemote: false, location: "Office" }],
    [{ ...job, applyUrl: `https://jobs.ashbyhq.com/other/${roleId}/application` }]]) {
    const role = await fetchVerifiedOfficialAtsRole(applyUrl, sourceOptions,
      async () => new Response(JSON.stringify({ jobs: rows })));
    assert.equal(role, null);
  }
});

test("Greenhouse and Lever roles require matching official identity and destination", async () => {
  const greenhouseUrl = "https://job-boards.greenhouse.io/example/jobs/12345";
  const greenhouse = await fetchVerifiedOfficialAtsRole(greenhouseUrl, {}, async () =>
    new Response(JSON.stringify({ id: 12345, title: "Senior Engineer", absolute_url: greenhouseUrl,
      location: { name: "Remote" }, content: "TypeScript" })));
  assert.equal(greenhouse?.source, "greenhouse");
  assert.equal(greenhouse?.externalId, "example:12345");
  const badGreenhouse = await fetchVerifiedOfficialAtsRole(greenhouseUrl, {}, async () =>
    new Response(JSON.stringify({ id: 12345, title: "Senior Engineer",
      absolute_url: "https://job-boards.greenhouse.io/other/jobs/12345",
      location: { name: "Remote" } })));
  assert.equal(badGreenhouse, null);
  const leverUrl = `https://jobs.lever.co/example/${roleId}/apply`;
  const lever = await fetchVerifiedOfficialAtsRole(leverUrl, {}, async () =>
    new Response(JSON.stringify({ id: roleId, text: "Senior Engineer", applyUrl: leverUrl,
      hostedUrl: `https://jobs.lever.co/example/${roleId}`, workplaceType: "remote",
      categories: { location: "Remote" }, descriptionPlain: "TypeScript" })));
  assert.equal(lever?.source, "lever");
  assert.equal(lever?.externalId, `example:${roleId}`);
  const badLever = await fetchVerifiedOfficialAtsRole(leverUrl, {}, async () =>
    new Response(JSON.stringify({ id: roleId, text: "Senior Engineer", applyUrl: "https://evil.example/apply",
      hostedUrl: `https://jobs.lever.co/example/${roleId}`, workplaceType: "remote" })));
  assert.equal(badLever, null);
});

test("forged browser metadata cannot promote an unsuitable official role", async () => {
  const { service, discovery, campaign } = await fixture(async () =>
    new Response(JSON.stringify({ jobs: [{ ...job, title: "Office Manager", isRemote: false,
      location: "Office" }] })));
  const first = await discovery.addCampaignSourceResults(campaign.campaignId, {
    sourceId: "board_one", items: [browserCandidate], completed: false
  }, identity);
  assert.equal(first.sourceCoverage.scans[0].selected, 0);
  assert.deepEqual(first.sourceCoverage.scans[0].exclusionReasons,
    [{ reason: "official_ats_ineligible_or_mismatched_destination", count: 1 }]);
  assert.equal(service.list("opportunities", "person").length, 0);
});

test("transient official transport failure retries once and reports a bounded failure", async () => {
  let calls = 0;
  const recovered = await fetchVerifiedOfficialAtsRole(applyUrl, {}, async () => {
    calls += 1;
    if (calls === 1) throw new Error("transient network failure");
    return new Response(JSON.stringify({ jobs: [job] }));
  });
  assert.equal(recovered?.externalId, `example:${roleId}`);
  assert.equal(calls, 2);
  const reasons = [];
  calls = 0;
  const failed = await fetchVerifiedOfficialAtsRole(applyUrl, {}, async () => {
    calls += 1;
    throw new Error("transient network failure");
  }, (reason) => reasons.push(reason));
  assert.equal(failed, null);
  assert.equal(calls, 2);
  assert.deepEqual(reasons, ["network_or_timeout"]);
});

test("a browser listing for another ATS role cannot be promoted", async () => {
  let fetches = 0;
  const { service, discovery, campaign } = await fixture(async () => {
    fetches += 1;
    return new Response(JSON.stringify({ jobs: [job] }));
  });
  const result = await discovery.addCampaignSourceResults(campaign.campaignId, {
    sourceId: "board_one", completed: false, items: [{ ...browserCandidate,
      listingUrl: "https://jobs.ashbyhq.com/example/22222222-2222-4222-8222-222222222222" }]
  }, identity);
  assert.equal(result.sourceCoverage.scans[0].selected, 0);
  assert.deepEqual(result.sourceCoverage.scans[0].exclusionReasons,
    [{ reason: "official_ats_identity_mismatch", count: 1 }]);
  assert.equal(fetches, 0);
  assert.equal(service.list("opportunities", "person").length, 0);
});

test("an observed non-ATS employer link stays pending until its current role is verified", async () => {
  const { service, discovery, campaign } = await fixture(async () => {
    throw new Error("non-ATS links must not receive an automatic official lookup");
  });
  const candidate = { title: "Senior Engineer", company: "Example", remote: true,
    description: "TypeScript Node.js", location: "Remote", employmentType: "full_time",
    listingUrl: "https://aggregator.example.test/jobs/42",
    applyUrl: "https://example.jobs.personio.de/job/42",
    applicationDestinationVerified: true };
  const first = await discovery.addCampaignSourceResults(campaign.campaignId, {
    sourceId: "board_one", completed: true, items: [candidate]
  }, identity);
  assert.equal(first.sourceCoverage.scans[0].selected, 0);
  assert.equal(first.sourceCoverage.scans[0].destinationPending, 1);
  assert.equal(first.sourceCoverage.scans[0].pendingOpportunityIds.length, 1);
  const pending = service.list("opportunities", "person")[0];
  assert.equal(pending.applicationDestinationPending, true);
  assert.equal(pending.applicationDestinationVerified, false);
  const retry = await discovery.addCampaignSourceResults(campaign.campaignId, {
    sourceId: "board_two", completed: true, items: [candidate]
  }, identity);
  assert.equal(retry.sourceCoverage.scans[1].handledFiltered, 0);
  assert.equal(retry.sourceCoverage.scans[1].selected, 0);
  assert.equal(service.list("opportunities", "person").length, 1);
  assert.equal(service.list("applications", "person").length, 0);
});

test("a matching official ATS identity upgrades a pending cross-source role", async () => {
  const { service } = await fixture(async () => new Response(JSON.stringify({ jobs: [job] })));
  const pending = await service.addOpportunity({ title: job.title, company: "Example",
    source: "browser_board", externalId: "browser-42",
    applyUrl: "https://board.example.test/apply/42", listingUrl: job.jobUrl,
    applicationDestinationPending: true }, identity);
  const verified = await service.addOpportunity({ title: job.title, company: "Example",
    source: "ashby", externalId: `example:${roleId}`, applyUrl,
    listingUrl: job.jobUrl, applicationDestinationPending: false,
    applicationDestinationVerified: true }, identity, { serverVerifiedDiscovery: true });
  assert.equal(verified.id, pending.id);
  assert.equal(verified.applicationDestinationPending, false);
  assert.equal(verified.source, "ashby");
  assert.equal(verified.applyUrl, applyUrl);
  assert.ok(verified.discoveryVerification);
  assert.equal(service.list("opportunities", "person").length, 1);
});

test("a live exact ATS role is rescored, deduplicated across browser sources, and policy permitted", async () => {
  let fetches = 0;
  const { service, discovery, campaign } = await fixture(async () => {
    fetches += 1;
    return new Response(JSON.stringify({ jobs: [job] }));
  });
  const first = await discovery.addCampaignSourceResults(campaign.campaignId, {
    sourceId: "board_one", items: [browserCandidate], completed: true
  }, identity);
  assert.equal(first.sourceCoverage.scans[0].selected, 1);
  const second = await discovery.addCampaignSourceResults(campaign.campaignId, {
    sourceId: "board_two", items: [{ ...browserCandidate,
      title: "Completely different", company: "Another forged name",
      listingUrl: "https://another-board.example.test/role" }], completed: true
  }, identity);
  assert.equal(second.sourceCoverage.scans[1].handledFiltered, 1);
  assert.equal(fetches, 2);
  const opportunities = service.list("opportunities", "person");
  assert.equal(opportunities.length, 1);
  assert.equal(opportunities[0].source, "ashby");
  assert.equal(opportunities[0].title, "Senior Engineer");
  assert.equal(opportunities[0].company, "Example");
  assert.equal(opportunities[0].userRequested, undefined);
  assert.equal(opportunities[0].provenance.browserSourceId, "board_one");
  assert.ok(opportunities[0].discoveryVerification);
  const application = service.list("applications", "person")[0];
  assert.equal(application.finalApprovalRequired, false);
  await service.store.mutate((state) => {
    state.applications[0].status = "submitting";
    state.applications[0].claim = { attemptId: "attempt-one" };
  });
  const decision = await service.prepareFinalSubmission({ applicationId: application.id,
    attemptId: "attempt-one", previewFingerprint: "a".repeat(64),
    preview: { destination: applyUrl, company: "Example", title: "Senior Engineer",
      filled: [{ label: "Email", value: "ada@example.test", source: "profile" }], unfilled: [] } });
  assert.equal(decision.decision, "permit", decision.reasonCodes?.join(", "));
});

test("one browser import reuses a bounded Ashby board lookup for multiple roles", async () => {
  const secondId = "22222222-2222-4222-8222-222222222222";
  let fetches = 0;
  const { discovery, campaign } = await fixture(async () => {
    fetches += 1;
    return new Response(JSON.stringify({ jobs: [job, { ...job, id: secondId, title: "Senior Engineer II",
      applyUrl: `https://jobs.ashbyhq.com/example/${secondId}/application`,
      jobUrl: `https://jobs.ashbyhq.com/example/${secondId}` }] }));
  });
  const result = await discovery.addCampaignSourceResults(campaign.campaignId, {
    sourceId: "board_one", completed: false,
    items: [browserCandidate, { ...browserCandidate,
      applyUrl: `https://jobs.ashbyhq.com/example/${secondId}/application` }]
  }, identity);
  assert.equal(result.sourceCoverage.scans[0].selected, 2);
  assert.equal(fetches, 1);
});

test("official ATS 429 creates a durable board cooldown during browser import", async () => {
  let fetches = 0;
  const { discovery, campaign } = await fixture(async () => {
    fetches += 1;
    return new Response("limited", { status: 429 });
  });
  const first = await discovery.addCampaignSourceResults(campaign.campaignId, {
    sourceId: "board_one", completed: false, items: [browserCandidate]
  }, identity);
  assert.deepEqual(first.sourceCoverage.scans[0].exclusionReasons,
    [{ reason: "official_ats_http_429", count: 1 }]);
  const second = await discovery.addCampaignSourceResults(campaign.campaignId, {
    sourceId: "board_one", completed: false, items: [{ ...browserCandidate,
      applyUrl: "https://jobs.ashbyhq.com/example/22222222-2222-4222-8222-222222222222/application" }]
  }, identity);
  assert.deepEqual(second.sourceCoverage.scans[1].exclusionReasons,
    [{ reason: "official_ats_backoff", count: 1 }]);
  assert.equal(fetches, 1);
});
