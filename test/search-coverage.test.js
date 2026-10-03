import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { searchTitleQueries } from "../src/discovery/search-title-queries.js";
import { configuredTitlePriority } from "../src/discovery/title-preferences.js";
import { nextQueryPage } from "../src/discovery/query-pagination.js";
import { remoteok } from "../src/discovery/sources/remoteok.js";
import { himalayas } from "../src/discovery/sources/himalayas.js";
import { ashby } from "../src/discovery/sources/ashby.js";
import { DiscoveryService } from "../src/discovery/service.js";
import { ProfileStore } from "../src/profile-store.js";
import { ApplicationService } from "../src/service.js";
import { JsonStore } from "../src/store.js";

test("search includes verified submitted title variants without changing title ranking", () => {
  const profile = { preferences: { fullTime: { jobTitles: ["Widget Runtime Engineer"] } } };
  const titles = searchTitleQueries(profile,
    ["Senior Quantum Pipeline Engineer", "Senior Quantum Pipeline Engineer",
      "Widget Runtime Developer", "Direct application"]);
  assert.deepEqual(titles.slice(0, 3),
    ["Widget Runtime Engineer", "Quantum Pipeline Engineer", "Widget Runtime Developer"]);
  assert.ok(titles.includes("Quantum Pipeline Developer"));
  assert.ok(!titles.includes("Direct application"));
});

test("close software title spellings match without promoting unrelated engineering", () => {
  const profile = { preferences: { fullTime: { jobTitles: [
    "Widget Runtime Engineer", "Quantum Pipeline Engineer"] } } };
  assert.equal(configuredTitlePriority("Senior Widget Runtime Developer", profile), "primary");
  assert.equal(configuredTitlePriority("Quantum Pipeline Developer", profile), "primary");
  assert.equal(configuredTitlePriority("Sales Engineer", profile), undefined);
  assert.equal(configuredTitlePriority("Marketing Engineer", profile), undefined);
});

test("bounded multi-query paging revisits live cursors after the first page", () => {
  const cursors = [
    { query: "engineer", page: 2, hasMore: true },
    { query: "developer", page: 1, hasMore: true }
  ];
  assert.deepEqual(nextQueryPage(cursors, 0), { index: 1, query: "developer", page: 1 });
  cursors[1].hasMore = false;
  assert.deepEqual(nextQueryPage(cursors, 1), { index: 0, query: "engineer", page: 2 });
  cursors[0].hasMore = false;
  assert.equal(nextQueryPage(cursors, 0), null);
});

test("public feeds discard handled rows before the raw result cap", async () => {
  const rows = [{ legal: "metadata" }, ...Array.from({ length: 11 }, (_, index) => ({
    id: `role-${index}`, position: "Widget Runtime Engineer", company: "Example",
    url: `https://remoteok.com/jobs/role-${index}`,
    apply_url: `https://employer.example.test/apply/${index}`
  }))];
  const result = await remoteok.search({ limit: 1,
    isHandled: (role) => role.externalId !== "role-10",
    fetchImpl: async () => new Response(JSON.stringify(rows)) });
  assert.equal(result.length, 1);
  assert.equal(result[0].externalId, "role-10");

  const himalayasRows = Array.from({ length: 11 }, (_, index) => ({
    guid: `h-${index}`, title: "Widget Runtime Engineer", companyName: "Example",
    applicationLink: `https://himalayas.app/jobs/h-${index}`
  }));
  const himalayasResult = await himalayas.search({ limit: 1,
    profile: { contact: { location: "Canada" },
      preferences: { fullTime: { jobTitles: ["Widget Runtime Engineer"] } } },
    isHandled: (role) => role.externalId !== "h-10",
    fetchImpl: async () => new Response(JSON.stringify({ jobs: himalayasRows })) });
  assert.equal(himalayasResult.length, 1);
  assert.equal(himalayasResult[0].externalId, "h-10");
});

test("official ATS discovery sends adjacent titles to the scorer", async () => {
  const result = await ashby.search({ limit: 10,
    profile: { preferences: { fullTime: { jobTitles: ["Widget Runtime Engineer"] } } },
    sourceConfig: { boards: [{ slug: "example", company: "Example" }] },
    fetchImpl: async () => new Response(JSON.stringify({ jobs: [{
      id: "developer-one", title: "Widget Runtime Developer", isRemote: true,
      applyUrl: "https://jobs.ashbyhq.com/example/developer-one/application",
      jobUrl: "https://jobs.ashbyhq.com/example/developer-one",
      descriptionPlain: "Node.js and PostgreSQL", location: "Remote"
    }] })) });
  assert.equal(result.length, 1);
  assert.equal(result[0].title, "Widget Runtime Developer");
});

test("official ATS scoring reaches a suitable role after 250 unrelated openings", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "official-coverage-"));
  const identity = { actorId: "owner", profileId: "owner" };
  const profiles = await new ProfileStore(path.join(directory, "profiles.json"),
    { allowMissing: true }).init();
  await profiles.patch(identity.profileId, {
    contact: { firstName: "Applicant", lastName: "Example",
      email: "owner@example.test", phone: "+10000000000", location: "Canada" },
    documents: { resume: "/secure/resume.pdf" }, skills: ["TypeScript", "Node.js"],
    preferences: { locations: ["Canada", "Worldwide"], fullTime: {
      jobTitles: ["Widget Runtime Engineer"], allowedLocations: ["Canada", "Worldwide"],
      remoteOnly: true, automatedDiscoverySources: ["ashby"] } }
  });
  const config = { defaultMode: "full_time",
    discovery: { sourceOptions: { ashby: { boards: [{ slug: "sample", company: "Example" }] } } },
    modes: { full_time: { minimumScore: 0, sources: ["ashby"],
      autoApplyDiscovered: false, requireConfirmationFor: [] } } };
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  const applicationService = new ApplicationService({ store, config, profiles,
    adapter: { name: "unused", async submit() {} } });
  const jobs = Array.from({ length: 250 }, (_, index) => ({
    id: `unrelated-${index}`, title: "Sales Coordinator", isRemote: true,
    applyUrl: `https://jobs.ashbyhq.com/sample/unrelated-${index}/application`,
    jobUrl: `https://jobs.ashbyhq.com/sample/unrelated-${index}`,
    location: "Worldwide", publishedAt: new Date().toISOString()
  }));
  jobs.push({ id: "suitable", title: "Widget Runtime Engineer", isRemote: true,
    applyUrl: "https://jobs.ashbyhq.com/sample/suitable/application",
    jobUrl: "https://jobs.ashbyhq.com/sample/suitable", location: "Worldwide",
    descriptionPlain: "TypeScript Node.js", publishedAt: new Date().toISOString() });
  const discovery = new DiscoveryService({ applicationService, profiles, config,
    fetchImpl: async () => new Response(JSON.stringify({ jobs })), officialRequestPaceMs: 0 });
  const result = await discovery.scan({ sources: ["ashby"], prepareApplications: false }, identity);
  assert.equal(result.found, 251);
  assert.ok(result.items.some((item) => item.opportunity.externalId === "sample:suitable"));
  assert.equal(result.sourceYield[0].partialReasons.includes("partial_response_cap"), false);
});
