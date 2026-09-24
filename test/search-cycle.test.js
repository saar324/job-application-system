import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DiscoveryService } from "../src/discovery/service.js";
import { ApplicationService } from "../src/service.js";
import { JsonStore } from "../src/store.js";

test("completed source cycles rotate per profile and reach the browser campaign", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "search-cycle-"));
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  const profile = { id: "person", skills: ["TypeScript"], preferences: { fullTime: {
    jobTitles: ["Platform Engineer"], secondaryJobTitles: ["Product Engineer"] } } };
  const profiles = { async get(id) { return { ...profile, id }; }, async status() {
    return { readyToSearch: true, readyToApply: true, missingForApplications: [] };
  } };
  const config = { defaultMode: "full_time", discovery: { limitPerSource: 1 },
    modes: { full_time: { minimumScore: 0, autoApplyDiscovered: false,
      sources: ["remoteok"], requireConfirmationFor: [] } } };
  const applicationService = new ApplicationService({ store, profiles, config,
    adapter: { name: "unused", async submit() {} } });
  const identity = { actorId: "owner", profileId: "person" };
  const earlier = "11111111-1111-4111-8111-111111111111";
  await applicationService.createCampaign({ id: earlier, target: 1, reserve: 0,
    mode: "full_time", sources: ["remoteok"], fallbackSources: ["jobgether"],
    reserveOnly: true }, identity);
  await applicationService.recordCampaignScan(earlier, { found: 0, qualifying: 0,
    excluded: 0, handledFiltered: 0, selectedOpportunityIds: [], applicationIds: [] }, identity);
  await applicationService.recordCampaignSourceScan(earlier, { sourceId: "jobgether",
    found: 0, qualifying: 0, excluded: 0, selected: 0, completed: true,
    exhausted: false }, identity);
  const discovery = new DiscoveryService({ applicationService, profiles, config,
    fetchImpl: async () => new Response(JSON.stringify([{ legal: "metadata" }])) });
  const campaign = await discovery.startCampaign({ target: 1, reserve: 0,
    reserveOnly: true, sources: ["remoteok"], fallbackSources: ["jobgether"] }, identity);
  assert.equal(campaign.sourceCycles.remoteok, 1);
  assert.equal(campaign.sourceCycles.jobgether, 1);
  assert.deepEqual(campaign.searchPlanSeed.profile.preferences.fullTime.jobTitles,
    ["Platform Engineer"]);
  assert.equal(JSON.stringify(campaign.searchPlanSeed).includes("TypeScript"), false);
  const other = await discovery.startCampaign({ target: 1, reserve: 0,
    reserveOnly: true, sources: ["remoteok"], fallbackSources: ["jobgether"] },
  { actorId: "other", profileId: "other" });
  assert.equal(other.sourceCycles.remoteok, 0);
  assert.equal(other.sourceCycles.jobgether, 0);
});
