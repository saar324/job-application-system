import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DiscoveryService } from "../src/discovery/service.js";
import { ashby } from "../src/discovery/sources/ashby.js";
import { greenhouse } from "../src/discovery/sources/greenhouse.js";
import { lever } from "../src/discovery/sources/lever.js";
import { remoteok } from "../src/discovery/sources/remoteok.js";
import { arbeitnow } from "../src/discovery/sources/arbeitnow.js";
import { normalizeOpportunity } from "../src/discovery/normalization.js";
import { postingFingerprint } from "../src/discovery/fit-assessment.js";
import { ProfileStore } from "../src/profile-store.js";
import { ApplicationService } from "../src/service.js";
import { JsonStore } from "../src/store.js";

const adapters = { ashby, greenhouse, lever, remoteok, arbeitnow };
const identity = { actorId: "review-agent", profileId: "person", roles: ["agent"] };
const ids = [1, 2, 3].map(n => `${n}1111111-1111-4111-8111-111111111111`);

function feed(source, changed = false) {
  const rows = ids.map((id, index) => {
    const description = `Python role ${index + 1}${changed && index === 0 ? " changed mandatory requirement" : ""}`;
    if (source === "remoteok") return { id, position: `Engineer ${index+1}`, company:"Fixture", description,
      apply_url: `https://example.test/jobs/${id}`, url: `https://remoteok.com/remote-jobs/${id}`, location:"Remote worldwide" };
    if (source === "arbeitnow") return { slug:id,title:`Engineer ${index+1}`,company_name:"Fixture",description,
      url:`https://example.test/jobs/${id}`,location:"Remote worldwide",remote:true };
    if (source === "ashby") return { id, title: `Engineer ${index + 1}`, descriptionPlain: description, applyUrl: `https://jobs.ashbyhq.com/fixture/${id}/application`,
      jobUrl: `https://jobs.ashbyhq.com/fixture/${id}`, location: "Remote worldwide", isRemote: true, isListed: true };
    if (source === "greenhouse") return { id: index + 1, title: `Engineer ${index + 1}`, content: `<p>${description}</p>`, location: { name: "Remote worldwide" },
      absolute_url: `https://job-boards.greenhouse.io/fixture/jobs/${index + 1}` };
    return { id, text: `Engineer ${index + 1}`, descriptionPlain: description, applyUrl: `https://jobs.lever.co/fixture/${id}/apply`,
      hostedUrl: `https://jobs.lever.co/fixture/${id}`, workplaceType: "remote", categories: { location: "Remote worldwide" } };
  });
  return source === "arbeitnow" ? {data:rows,links:{next:null}} : source === "lever" || source === "remoteok" ? rows : { jobs: rows };
}

async function fixture(t, source, { changed = false, seedProfile = "person", applicationStatus } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "review-continuation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const profiles = await new ProfileStore(path.join(directory, "profiles.json"), { allowMissing: true }).init();
  await profiles.patch("person", { contact: { location: "Remote" }, skills: ["Python"], preferences: { locations: ["Remote"], fullTime: { jobTitles: ["Engineer"], remoteOnly: true } } });
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  const sourceConfig = source === "lever" ? { sites: [{ slug: "fixture", company: "Fixture" }] }
    : { boards: [{ [source === "greenhouse" ? "token" : "slug"]: "fixture", company: "Fixture" }] };
  const config = { defaultMode: "full_time", discovery: { sourceOptions: { [source]: sourceConfig } },
    modes: { full_time: { minimumScore: 0, autoApply: false, dailyApplicationCap: 10, sources: [source], requireConfirmationFor: [] } } };
  const service = new ApplicationService({ store, profiles, config, adapter: { name: "chrome_session" } });
  service.enqueue = () => {};
  const oldRows = await adapters[source].search({ sourceConfig, fetchImpl: async () => new Response(JSON.stringify(feed(source))) });
  for (const raw of oldRows.slice(0, 2)) {
    const role = normalizeOpportunity(raw, { source });
    const saved = await service.addOpportunity({ ...role, fitAssessment: { decision: "irrelevant", reason: "Synthetic prior full review", fingerprint: postingFingerprint(role) } },
      { ...identity, profileId: seedProfile }, { reviewedDiscovery: true });
    if (applicationStatus) await store.mutate(state => state.applications.push({ id: `application-${saved.id}`, profileId: seedProfile,
      opportunityId: saved.id, status: applicationStatus,
      ...(applicationStatus === "submitted" ? { receipt: { submittedAt: new Date().toISOString(), finalUrl: raw.applyUrl } }
        : { checkpoint: { phase: "final_action_started" } }) }));
  }
  let requests = 0;
  const discovery = new DiscoveryService({ applicationService: service, profiles, config, fetchImpl: async () => {
    requests += 1; return new Response(JSON.stringify(feed(source, changed)));
  } });
  const result = await discovery.scan({ sources: [source], reviewOnly: true, queryPlan: [{ limit: 2, filters: {} }], limitPerSource: 2 }, identity);
  return { result, requests, oldRows, service };
}

for (const source of Object.keys(adapters)) {
  test(`${source}: unchanged irrelevant postings are filtered before a bounded query cap`, async t => {
    const { result, requests } = await fixture(t, source);
    assert.deepEqual(result.candidates.map(role => role.title), ["Engineer 3"]);
    assert.equal(result.handledFiltered, 2);
    assert.equal(result.requestsMade, 1);
    assert.equal(requests, 1);
    assert.equal(result.sourceYield[0].rawRowsObserved, 3);
    assert.equal(result.sourceYield[0].selected, 1);
    assert.equal(result.sourceYield[0].exhausted, false, "one feed response is not global source exhaustion");
  });
  test(`${source}: a changed posting resurfaces and keeps the remaining unseen role`, async t => {
    const { result, requests } = await fixture(t, source, { changed: true });
    assert.deepEqual(result.candidates.map(role => role.title), ["Engineer 1", "Engineer 3"]);
    assert.match(result.candidates[0].description, /changed mandatory requirement/);
    assert.equal(requests, 1);
  });
  test(`${source}: another profile's exclusions do not suppress this profile's bounded candidates`, async t => {
    const { result } = await fixture(t, source, { seedProfile: "other" });
    assert.deepEqual(result.candidates.map(role => role.title), ["Engineer 1", "Engineer 2"]);
  });
  for (const applicationStatus of ["submitted", "waiting_confirmation"]) {
    test(`${source}: ${applicationStatus} stays handled even when the posting changes`, async t => {
      const { result } = await fixture(t, source, { changed: true, applicationStatus });
      assert.deepEqual(result.candidates.map(role => role.title), ["Engineer 3"]);
      assert.equal(result.handledFiltered, 2);
    });
  }
}
