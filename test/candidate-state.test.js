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
