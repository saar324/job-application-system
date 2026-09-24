import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DiscoveryService } from "../src/discovery/service.js";
import { ProfileStore } from "../src/profile-store.js";
import { ApplicationService } from "../src/service.js";
import { JsonStore } from "../src/store.js";

const identity = { actorId: "owner", profileId: "owner", roles: ["owner"] };
const roleId = "11111111-1111-4111-8111-111111111111";
const applyUrl = `https://jobs.ashbyhq.com/example/${roleId}/application`;

async function fixture(source, fetchImpl) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "candidate-state-"));
  const profiles = await new ProfileStore(path.join(directory, "profiles.json"),
    { allowMissing: true }).init();
  await profiles.patch("owner", { contact: { firstName: "Ada", lastName: "Example",
    email: "ada@example.test", phone: "+10000000000", location: "Remote" },
  documents: { resume: "/private/resume.pdf" }, skills: ["TypeScript", "Node.js"],
  preferences: { locations: ["Remote", "Worldwide"], fullTime: {
    jobTitles: ["Senior Engineer"], automatedDiscoverySources: [source] } } });
  const config = { defaultMode: "full_time", discovery: { limitPerSource: 1,
    sourceOptions: { ashby: { boards: [{ slug: "example", company: "Example" }] } } },
  modes: { full_time: { minimumScore: 0, autoApplyDiscovered: false,
    sources: [source], requireConfirmationFor: [] } } };
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  const service = new ApplicationService({ store, profiles, config,
    adapter: { name: "unused", async submit() {} } });
  const discovery = new DiscoveryService({ applicationService: service, profiles, config,
    fetchImpl, officialRequestPaceMs: 0 });
  return { store, service, discovery };
}

test("pending destination retries are delayed, bounded, and expire across campaigns", async () => {
  const { store, discovery } = await fixture("remoteok", async () =>
    new Response(JSON.stringify([{ legal: "metadata" }, { id: "pending", position: "Senior Engineer",
      company: "Example", description: "TypeScript Node.js", location: "Worldwide",
      url: "https://remoteok.com/jobs/pending",
      apply_url: "https://employer.example.test/jobs/pending" }])));
  const run = () => discovery.startCampaign({ target: 1, reserve: 0,
    sources: ["remoteok"], reserveOnly: true }, identity);
  const first = await run();
  assert.equal(first.scan.sourceYield[0].destinationPending, 1);
  assert.equal(store.snapshot().opportunities[0].discoveryState, "pending_destination");
  assert.equal(store.snapshot().opportunities[0].destinationRetryCount, 1);
  const second = await run();
  assert.equal(second.scan.sourceYield[0].retryDeferred, 1);
  assert.equal(second.scan.handledFiltered, 0);
  assert.equal(store.snapshot().opportunities[0].destinationRetryCount, 1);
  await store.mutate((state) => { state.opportunities[0].destinationRetryAfter =
    new Date(Date.now() - 1_000).toISOString(); });
  const third = await run();
  assert.equal(third.scan.sourceYield[0].destinationPending, 1);
  assert.equal(store.snapshot().opportunities[0].destinationRetryCount, 2);
  await store.mutate((state) => {
    state.opportunities[0].destinationFirstObservedAt = new Date(Date.now()
      - 8 * 24 * 60 * 60_000).toISOString();
    state.opportunities[0].destinationRetryAfter = new Date(Date.now() - 1_000).toISOString();
  });
  const fourth = await run();
  assert.equal(fourth.scan.sourceYield[0].retryDeferred, 1);
  assert.equal(store.snapshot().opportunities[0].discoveryState, "expired");
  assert.equal(store.snapshot().opportunities.length, 1);
  assert.equal(store.snapshot().applications.length, 0);
});

test("closed role waits for retry and reopens only after a fresh matching ATS role", async () => {
  const job = { id: roleId, title: "Senior Engineer", isRemote: true,
    location: "Worldwide", descriptionPlain: "TypeScript Node.js", applyUrl,
    jobUrl: `https://jobs.ashbyhq.com/example/${roleId}` };
  const { store, service, discovery } = await fixture("ashby", async () =>
    new Response(JSON.stringify({ jobs: [job] })));
  const stored = await service.addOpportunity({ source: "ashby", externalId: `example:${roleId}`,
    title: job.title, company: "Example", location: "Worldwide", remote: true,
    applyUrl, listingUrl: job.jobUrl, applicationDestinationVerified: true,
    applicationDestinationPending: false }, identity, { serverVerifiedDiscovery: true });
  await store.mutate((state) => {
    state.opportunities[0].discoveryState = "closed";
    state.opportunities[0].closedOrigin = "posting_unavailable";
    state.opportunities[0].closedRetryAfter = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    state.applications.push({ id: "prior-skipped", profileId: "owner",
      opportunityId: stored.id, status: "skipped", createdAt: new Date().toISOString() });
  });
  const run = () => discovery.startCampaign({ target: 1, reserve: 0,
    sources: ["ashby"], reserveOnly: true }, identity);
  const first = await run();
  assert.equal(first.scan.sourceYield[0].retryDeferred, 1);
  assert.equal(first.scan.handledFiltered, 0);
  assert.equal(first.candidatePoolSize, 0);
  await store.mutate((state) => { state.opportunities[0].closedRetryAfter =
    new Date(Date.now() - 1_000).toISOString(); });
  const second = await run();
  assert.equal(second.scan.selectedOpportunityIds.length, 1);
  assert.equal(second.scan.selectedOpportunityIds[0], stored.id);
  assert.equal(store.snapshot().opportunities[0].discoveryState, "ready");
  assert.equal(store.snapshot().applications.length, 1, "discovery must not issue a second final action");
  const third = await run();
  assert.equal(third.scan.handledFiltered, 1);
  assert.equal(third.scan.selectedOpportunityIds.length, 0);
});

test("a matching official role resolves a pending lead from another source during backoff", async () => {
  const job = { id: roleId, title: "Senior Engineer", isRemote: true,
    location: "Worldwide", descriptionPlain: "TypeScript Node.js", applyUrl,
    jobUrl: `https://jobs.ashbyhq.com/example/${roleId}` };
  const { store, service, discovery } = await fixture("ashby", async () =>
    new Response(JSON.stringify({ jobs: [job] })));
  const pending = await service.addOpportunity({ source: "remoteok", externalId: "raw-1",
    title: job.title, company: "Example", location: "Worldwide", remote: true,
    applyUrl, listingUrl: "https://remoteok.com/jobs/raw-1",
    applicationDestinationPending: true, applicationDestinationVerified: false }, identity,
  { serverVerifiedDiscovery: true });
  assert.ok(Date.parse(pending.destinationRetryAfter) > Date.now());
  const campaign = await discovery.startCampaign({ target: 1, reserve: 0,
    sources: ["ashby"], reserveOnly: true }, identity);
  assert.deepEqual(campaign.scan.selectedOpportunityIds, [pending.id]);
  const stored = store.snapshot().opportunities[0];
  assert.equal(stored.source, "ashby");
  assert.equal(stored.discoveryState, "ready");
  assert.equal(stored.applicationDestinationPending, false);
  assert.equal(store.snapshot().opportunities.length, 1);
  assert.equal(store.snapshot().applications.length, 0);
});

test("an uncertain prior final action prevents a closed role from reentering discovery", async () => {
  const state = { opportunities: [{ id: "role", profileId: "owner", source: "ashby",
    externalId: `example:${roleId}`, applyUrl, applicationDestinationVerified: true,
    discoveryState: "closed", closedOrigin: "posting_unavailable",
    closedRetryAfter: new Date(Date.now() - 1_000).toISOString() }],
  applications: [{ profileId: "owner", opportunityId: "role", status: "skipped",
    finalSubmissionDecision: { status: "consumed" } }] };
  const { knownRoleIndex, isHandledRole } = await import("../src/discovery/handled-roles.js");
  assert.equal(isHandledRole(state.opportunities[0], knownRoleIndex(state, "owner")), true);
});

test("a client cannot forge a closed posting or reopen an unrelated skipped lead", async () => {
  const { service, store } = await fixture("ashby", async () =>
    new Response(JSON.stringify({ jobs: [] })));
  const stored = await service.addOpportunity({ source: "ashby", externalId: `example:${roleId}`,
    title: "Senior Engineer", company: "Example", applyUrl,
    discoveryState: "closed", closedOrigin: "posting_unavailable",
    closedRetryAfter: new Date(Date.now() - 1_000).toISOString(),
    applicationDestinationVerified: true }, identity);
  assert.equal(stored.discoveryState, undefined);
  assert.equal(stored.closedOrigin, undefined);
  await store.mutate((state) => {
    state.opportunities[0].discoveryState = "closed";
    state.applications.push({ id: "unrelated-skip", profileId: "owner",
      opportunityId: stored.id, status: "skipped" });
  });
  const fresh = await service.addOpportunity({ source: "ashby", externalId: `example:${roleId}`,
    title: "Senior Engineer", company: "Example", applyUrl,
    applicationDestinationPending: false, applicationDestinationVerified: true }, identity,
  { serverVerifiedDiscovery: true });
  assert.equal(fresh.id, stored.id);
  assert.equal(fresh.discoveryState, "closed");
  const { knownRoleIndex, isHandledRole } = await import("../src/discovery/handled-roles.js");
  assert.equal(isHandledRole(fresh, knownRoleIndex(store.snapshot(), "owner")), true);
});
