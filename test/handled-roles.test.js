import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SimulationAdapter } from "../src/adapters/simulation.js";
import { DiscoveryService } from "../src/discovery/service.js";
import { handledRoleIndex, isHandledRole, knownRoleIndex, roleKeys } from "../src/discovery/handled-roles.js";
import { ProfileStore } from "../src/profile-store.js";
import { ApplicationService } from "../src/service.js";
import { JsonStore } from "../src/store.js";

test("ATS role identities match direct application and feed URLs without tracking parameters", () => {
  const greenhouse = { source: "greenhouse", externalId: "example:12345",
    applyUrl: "https://job-boards.eu.greenhouse.io/example/jobs/12345?gh_src=campaign" };
  assert.ok(roleKeys(greenhouse).has("greenhouse:example:12345"));
  assert.ok(isHandledRole({ applyUrl: "https://job-boards.greenhouse.io/example/jobs/12345" },
    roleKeys(greenhouse)));
  assert.ok(isHandledRole({ applyUrl: "https://jobs.ashbyhq.com/example/11111111-1111-4111-8111-111111111111/application" },
    roleKeys({ source: "ashby", externalId: "example:11111111-1111-4111-8111-111111111111" })));
  assert.ok(isHandledRole({ applyUrl: "https://jobs.lever.co/example/22222222-2222-4222-8222-222222222222/apply" },
    roleKeys({ source: "lever", externalId: "example:22222222-2222-4222-8222-222222222222" })));
  assert.equal(isHandledRole({ applyUrl: "https://jobs.ashbyhq.com/other/11111111-1111-4111-8111-111111111111" },
    roleKeys({ source: "ashby", externalId: "example:11111111-1111-4111-8111-111111111111" })), false);
  assert.ok(isHandledRole({ applyUrl: "https://careers.example.test/roles/engineer/apply?utm_source=board" },
    roleKeys({ applyUrl: "https://careers.example.test/roles/engineer" })));
  assert.ok(isHandledRole({ company: "Lemon.io", title: "Senior React Full-stack Developer",
    applyUrl: "https://board-two.example.test/jobs/44" }, roleKeys({ company: "Lemon.io",
    title: "Senior React Full-stack Developer", applyUrl: "https://board-one.example.test/jobs/22" })));
  assert.equal(isHandledRole({ company: "Lemon.io", title: "Senior AI Engineer" },
    roleKeys({ company: "Lemon.io", title: "Senior React Full-stack Developer" })), false);
});

test("only applications for the current profile enter the handled index", () => {
  const state = { opportunities: [
    { id: "one", profileId: "a", applyUrl: "https://careers.example.test/roles/one" },
    { id: "two", profileId: "b", applyUrl: "https://careers.example.test/roles/two" },
    { id: "discovered", profileId: "a", applyUrl: "https://careers.example.test/roles/new" }
  ], applications: [
    { profileId: "a", opportunityId: "one", status: "submitted" },
    { profileId: "b", opportunityId: "two", status: "waiting_confirmation" }
  ] };
  const keys = handledRoleIndex(state, "a");
  assert.equal(isHandledRole(state.opportunities[0], keys), true);
  assert.equal(isHandledRole(state.opportunities[1], keys), false);
  assert.equal(isHandledRole(state.opportunities[2], keys), false);
});

test("a receipt filters an employer role found through another source", () => {
  const state = { opportunities: [{ id: "old", profileId: "a",
    applyUrl: "https://himalayas.app/companies/example/jobs/ai-engineer" }],
  applications: [{ profileId: "a", opportunityId: "old", status: "submitted",
    receipt: { finalUrl: "https://job-boards.greenhouse.io/example/jobs/5238049007/confirmation" } }] };
  const employerRole = { applyUrl: "https://job-boards.greenhouse.io/example/jobs/5238049007" };
  assert.equal(isHandledRole(employerRole, handledRoleIndex(state, "a")), true);
  assert.equal(isHandledRole(employerRole, knownRoleIndex(state, "a")), true);
  assert.equal(isHandledRole(employerRole, knownRoleIndex(state, "b")), false);
});

test("official board search excludes handled and previously seen roles before applying the result limit", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-handled-discovery-"));
  const profiles = await new ProfileStore(path.join(directory, "profiles.json"), { allowMissing: true }).init();
  await profiles.patch("owner", { skills: ["TypeScript"],
    preferences: { locations: ["Europe", "Bulgaria"], fullTime: { jobTitles: ["Engineer"] } } });
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  await store.mutate((state) => {
    state.opportunities.push({ id: "old", profileId: "owner", source: "direct",
      applyUrl: "https://jobs.ashbyhq.com/example/11111111-1111-4111-8111-111111111111/application" });
    state.applications.push({ id: "old-application", profileId: "owner", opportunityId: "old", status: "submitted" });
  });
  const config = { defaultMode: "full_time", discovery: { sourceOptions: { ashby: {
    boards: [{ slug: "example", company: "Example" }] } } }, modes: { full_time: {
    minimumScore: 0, sources: ["ashby"], autoApplyDiscovered: false
  } } };
  const applicationService = new ApplicationService({ store, config, adapter: new SimulationAdapter() });
  const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  const fetchImpl = async () => new Response(JSON.stringify({ jobs: ids.map((id, index) => ({
    id, title: `Engineer ${index + 1}`, isRemote: true, location: "Europe, Remote",
    applyUrl: `https://jobs.ashbyhq.com/example/${id}/application`,
    jobUrl: `https://jobs.ashbyhq.com/example/${id}`,
    descriptionPlain: "TypeScript engineering", publishedAt: `2026-09-${20 - index}`
  })) }));
  const discovery = new DiscoveryService({ applicationService, profiles, config, fetchImpl });
  const result = await discovery.scan({ limitPerSource: 1 }, { actorId: "owner", profileId: "owner" });
  assert.equal(result.handledFiltered, 1, JSON.stringify(result));
  assert.equal(result.found, 1);
  assert.equal(result.items.length, 1, JSON.stringify(result));
  assert.equal(result.items[0].opportunity.externalId, `example:${ids[1]}`);
  const repeat = await discovery.scan({ limitPerSource: 1 }, { actorId: "owner", profileId: "owner" });
  assert.equal(repeat.items.length, 0, "a previously seen role must not re-enter a later candidate pool");
  assert.equal(repeat.handledFiltered, 2);
});
