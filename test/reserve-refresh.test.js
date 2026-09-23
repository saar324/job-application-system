import assert from "node:assert/strict";
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
const roleId = "11111111-1111-4111-8111-111111111111";
const applyUrl = `https://jobs.ashbyhq.com/example/${roleId}/application`;
const job = { id: roleId, title: "Senior Engineer", applyUrl,
  jobUrl: `https://jobs.ashbyhq.com/example/${roleId}`, descriptionPlain: "TypeScript Node.js",
  location: "Remote", isRemote: true, isListed: true, employmentType: "Full-Time" };

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-reserve-"));
  const profiles = await new ProfileStore(path.join(directory, "profiles.json"), { allowMissing: true }).init();
  await profiles.patch("person", { contact: { firstName: "Ada", lastName: "Lovelace",
    email: "ada@example.test", phone: "+10000000000", location: "Remote" },
  documents: { resume: "/private/resume.pdf" }, skills: ["TypeScript", "Node.js"],
  preferences: { locations: ["Remote"], fullTime: { jobTitles: ["Senior Engineer"],
    automatedDiscoverySources: ["ashby"] } } });
  const config = { defaultMode: "full_time", execution: { concurrency: 1 },
    discovery: { sourceOptions: { ashby: { boards: [{ slug: "example", company: "Example" }] } } },
    modes: { full_time: { minimumScore: 0, autoApply: false, sources: ["ashby"],
      dailyApplicationCap: 10, requireConfirmationFor: [] } } };
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  const service = new ApplicationService({ store, profiles, config, adapter: new SimulationAdapter() });
  service.enqueue = () => {};
  let fetches = 0;
  const discovery = new DiscoveryService({ applicationService: service, profiles, config,
    fetchImpl: async () => { fetches += 1; return new Response(JSON.stringify({ jobs: [job] })); } });
  return { directory, profiles, config, store, service, discovery, fetches: () => fetches };
}

test("scheduled official refresh is durable, bounded, and consumed only once", async () => {
  const { directory, profiles, config, service, discovery, fetches } = await fixture();
  const first = await discovery.refreshReserve({}, identity);
  assert.equal(first.results[0].status, "complete");
  assert.equal(first.results[0].eligible, 1);
  assert.equal(first.results[0].requestsMade, 1);
  assert.equal(first.renewed.checked, 0);
  const opportunity = service.list("opportunities", "person")[0];
  assert.ok(opportunity.reserveExpiresAt);
  const second = await discovery.refreshReserve({}, identity);
  assert.equal(second.results[0].status, "cooldown_or_running");
  assert.equal(fetches(), 1);
  const reopened = await new JsonStore(path.join(directory, "state.json")).init();
  const restartedService = new ApplicationService({ store: reopened, profiles, config,
    adapter: new SimulationAdapter() });
  restartedService.enqueue = () => {};
  const restarted = new DiscoveryService({ applicationService: restartedService, profiles, config,
    fetchImpl: async () => new Response(JSON.stringify({ jobs: [job] })) });
  assert.equal((await restarted.refreshReserve({}, identity)).results[0].status, "cooldown_or_running");
  const campaign = await restarted.startCampaign({ target: 1, reserve: 0, sources: [] }, identity);
  assert.equal(campaign.applications.length, 1);
  assert.equal(campaign.scan.selectedOpportunityIds[0], opportunity.id);
  await restartedService.store.mutate((state) => { state.applications[0].status = "skipped"; });
  const next = await restarted.startCampaign({ target: 1, reserve: 0, sources: [] }, identity);
  assert.equal(next.applications.length, 0);
  assert.equal(next.scan.selectedOpportunityIds.length, 0);
});

test("browser reserve-only campaign records verified roles without queueing an application", async () => {
  const { service, discovery } = await fixture();
  const campaign = await discovery.startCampaign({ target: 1, reserve: 0, sources: [],
    fallbackSources: ["board_one"], reserveOnly: true }, identity);
  const completed = await discovery.addCampaignSourceResults(campaign.campaignId, {
    sourceId: "board_one", completed: true, items: [{ title: "Forged title", company: "Forged company",
      location: "Remote", remote: true, applyUrl,
      listingUrl: "https://board.example.test/role", applicationDestinationVerified: true }]
  }, identity);
  assert.equal(completed.status, "reserve_ready");
  assert.equal(service.list("applications", "person").length, 0);
  const role = service.list("opportunities", "person")[0];
  assert.equal(role.title, "Senior Engineer");
  assert.ok(Date.parse(role.reserveExpiresAt) > Date.now() + 23 * 60 * 60_000);
  const normal = await discovery.startCampaign({ target: 1, reserve: 0, sources: [] }, identity);
  assert.equal(normal.applications.length, 1);
  assert.equal(normal.scan.selectedOpportunityIds[0], role.id);
});

test("official refresh backs off after rate limiting and does not retry during cooldown", async () => {
  const { discovery } = await fixture();
  let calls = 0;
  discovery.fetchImpl = async () => { calls += 1; return new Response("limited", { status: 429 }); };
  const first = await discovery.refreshReserve({}, identity);
  assert.equal(first.results[0].status, "backoff");
  assert.equal(first.results[0].requestsMade, 1);
  assert.ok(Date.parse(first.results[0].nextAt) > Date.now() + 5 * 60 * 60_000);
  assert.equal((await discovery.refreshReserve({}, identity)).results[0].status, "cooldown_or_running");
  assert.equal(calls, 1);
});

test("official refresh enforces a per-source request budget", async () => {
  const { config, discovery } = await fixture();
  config.discovery.sourceOptions.ashby.boards = Array.from({ length: 25 }, (_, index) => ({
    slug: `board${index}`, company: `Board ${index}` }));
  let calls = 0;
  discovery.fetchImpl = async () => { calls += 1; return new Response(JSON.stringify({ jobs: [] })); };
  const result = await discovery.refreshReserve({}, identity);
  assert.equal(result.results[0].requestsMade, 20);
  assert.equal(calls, 20);
  await assert.rejects(discovery.scan({ sources: ["ashby"],
    maxRequestsPerSource: "unlimited" }, identity), /budgets are invalid/);
});

test("a reserved role that closes before preparation expires without an application", async () => {
  const { service, discovery } = await fixture();
  await discovery.refreshReserve({}, identity);
  let fetches = 0;
  discovery.fetchImpl = async () => { fetches += 1; return new Response(JSON.stringify({ jobs: [] })); };
  const first = await discovery.startCampaign({ target: 1, reserve: 0, sources: [] }, identity);
  assert.equal(first.applications.length, 0);
  assert.ok(Date.parse(service.list("opportunities", "person")[0].reserveExpiresAt) <= Date.now());
  await discovery.startCampaign({ target: 1, reserve: 0, sources: [] }, identity);
  assert.equal(fetches, 1);
});
