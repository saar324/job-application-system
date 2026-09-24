import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DiscoveryService } from "../src/discovery/service.js";
import { ProfileStore } from "../src/profile-store.js";
import { ApplicationService } from "../src/service.js";
import { JsonStore } from "../src/store.js";
import { SimulationAdapter } from "../src/adapters/simulation.js";

const identity = { actorId: "agent", profileId: "person", roles: ["agent"] };
const owner = { actorId: "owner", profileId: "person", roles: ["owner"] };
const id = (digit) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const job = (digit, title) => ({ id: id(digit), title, isRemote: true,
  location: "Worldwide", descriptionPlain: "TypeScript Node.js platform",
  employmentType: "Full-Time", isListed: true,
  applyUrl: `https://jobs.ashbyhq.com/example/${id(digit)}/application`,
  jobUrl: `https://jobs.ashbyhq.com/example/${id(digit)}` });

test("source rollout keeps baseline automatic and broadened roles in advisory review", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "staged-discovery-"));
  const profiles = await new ProfileStore(path.join(directory, "profiles.json"),
    { allowMissing: true }).init();
  await profiles.patch("person", { contact: { firstName: "Ada", lastName: "Lovelace",
    email: "ada@example.test", phone: "+10000000000", location: "Remote" },
  documents: { resume: "/private/resume.pdf" }, skills: ["TypeScript", "Node.js"],
  preferences: { locations: ["Worldwide"], fullTime: {
    jobTitles: ["Software Engineer Alpha"], automatedDiscoverySources: ["ashby"] } } });
  await profiles.setStandingSubmissionPolicy("person", { mode: "automatic", modes: ["full_time"],
    sources: ["ashby"], destinationHosts: ["jobs.ashbyhq.com"],
    answerClasses: ["profile_fact", "resume", "link"], dailyCap: 10, campaignCap: 10 }, owner);
  const config = { defaultMode: "full_time", execution: { maxApplicationsPerDay: 10 },
    discovery: { broadenedSources: {}, sourceOptions: { ashby: {
      boards: [{ slug: "example", company: "Example" }] } } },
    modes: { full_time: { minimumScore: 0, autoApply: true, autoApplyDiscovered: true,
      dailyApplicationCap: 10, sources: ["ashby"], requireConfirmationFor: [] } } };
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  const service = new ApplicationService({ store, profiles, config, adapter: new SimulationAdapter() });
  service.enqueue = () => {};
  const jobs = [
    job("1", "Software Engineer Alpha"), job("2", "Software Developer Alpha")
  ];
  const fetchImpl = async () => new Response(JSON.stringify({ jobs }));
  const discovery = new DiscoveryService({ applicationService: service, profiles, config, fetchImpl });

  const baseline = await discovery.scan({}, identity);
  assert.equal(baseline.items.length, 1);
  assert.equal(baseline.items[0].application.status, "queued");
  assert.equal(baseline.items[0].opportunity.discoveryRelease, undefined);
  config.discovery.broadenedSources.ashby = true;
  const expanded = await discovery.scan({}, identity);
  const advisory = expanded.items.find((entry) => entry.opportunity.title === "Software Developer Alpha");
  assert.equal(advisory.opportunity.discoveryRelease.stage, "advisory");
  assert.equal(advisory.opportunity.discoveryRelease.reason, "broadened_source");
  assert.equal(advisory.application, undefined);
  assert.equal(advisory.applicationBlockedBySource, "advisory_fit_review_required");
  jobs.push(job("3", "Software Engineer Alpha"));
  const lateExact = (await discovery.scan({}, identity)).items
    .find((entry) => entry.opportunity.externalId === `example:${id("3")}`);
  assert.equal(lateExact.opportunity.discoveryRelease.stage, "advisory");
  assert.equal(lateExact.application, undefined);
  const campaign = await discovery.startCampaign({ id: randomUUID(), target: 1, reserve: 0,
    sources: ["ashby"], fallbackSources: [] }, identity);
  assert.equal(campaign.status, "insufficient_candidates");
  assert.equal(service.list("applications", "person").length, 1);

  const manual = await service.requestApplication(advisory.opportunity.id, {}, identity);
  assert.equal(manual.status, "waiting_confirmation");
  assert.equal(manual.standingPolicyVersion, undefined);
  assert.equal(manual.finalApprovalRequired, true);
  assert.ok(manual.decision.confirmations.some((item) => item.kind === "discovery_fit_review"));
  await store.mutate((state) => {
    const current = state.applications.find((item) => item.id === manual.id);
    current.status = "submitting";
    current.claim = { attemptId: "attempt-one" };
  });
  const decision = await service.prepareFinalSubmission({ applicationId: manual.id,
    attemptId: "attempt-one", previewFingerprint: "a".repeat(64), preview: {
      destination: advisory.opportunity.applyUrl, company: "Example",
      title: "Software Developer Alpha", filled: [], unfilled: [] } });
  assert.equal(decision.decision, "hold");
  assert.ok(decision.reasonCodes.includes("advisory_discovery_review_required"));

  config.discovery.broadenedSources.ashby = false;
  const rescan = await discovery.scan({}, identity);
  assert.ok(!rescan.items.some((entry) => entry.opportunity.id === advisory.opportunity.id));
  assert.equal(service.list("opportunities", "person")
    .find((entry) => entry.id === advisory.opportunity.id).discoveryRelease.stage, "advisory");
});

test("caller cannot forge or erase server-owned advisory provenance", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "staged-provenance-"));
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  const config = { defaultMode: "full_time", modes: { full_time: { minimumScore: 0 } } };
  const service = new ApplicationService({ store, config, adapter: new SimulationAdapter() });
  const role = { title: "Engineer", company: "Example", applyUrl: "https://example.test/role",
    discoveryRelease: { stage: "advisory", sourceId: "ashby", reason: "broadened_title" } };
  const forged = await service.addOpportunity(role, identity);
  assert.equal(forged.discoveryRelease, undefined);
  const verified = await service.addOpportunity({ ...role,
    applyUrl: "https://example.test/second" }, identity,
  { serverVerifiedDiscovery: true, advisoryDiscovery: role.discoveryRelease });
  assert.equal(verified.discoveryRelease.stage, "advisory");
  const repeated = await service.addOpportunity({ ...role, applyUrl: verified.applyUrl,
    discoveryRelease: null }, identity);
  assert.equal(repeated.discoveryRelease.stage, "advisory");
});
