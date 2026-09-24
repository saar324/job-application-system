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

test("campaign retains a suitable unverified lead behind twenty rejected rows without treating it as ready", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "search-coverage-"));
  const identity = { actorId: "owner", profileId: "owner" };
  const profiles = await new ProfileStore(path.join(directory, "profiles.json"), { allowMissing: true }).init();
  await profiles.patch(identity.profileId, {
    contact: { firstName: "Applicant", lastName: "Example", email: "owner@example.test",
      phone: "+10000000000", location: "Canada" },
    documents: { resume: "/secure/resume.pdf" },
    skills: ["TypeScript", "Node.js"],
    preferences: { locations: ["Canada", "Worldwide"], fullTime: {
      jobTitles: ["Widget Runtime Engineer"], allowedLocations: ["Canada", "Worldwide"],
      remoteOnly: true, automatedDiscoverySources: ["remoteok"]
    } }
  });
  const config = { defaultMode: "full_time", discovery: { limitPerSource: 10 },
    modes: { full_time: { minimumScore: 0, autoApplyDiscovered: false,
      sources: ["remoteok"], requireConfirmationFor: [] } } };
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  const applicationService = new ApplicationService({ store, config,
    adapter: { name: "unused", async submit() {} }, profiles });
  const rows = [{ legal: "metadata" }, ...Array.from({ length: 22 }, (_, index) => ({
    id: `role-${index}`, position: "Widget Runtime Engineer", company: "Example",
    description: "TypeScript Node.js", tags: ["TypeScript", "Node.js"],
    location: index === 21 ? "Worldwide" : "United States",
    date: new Date().toISOString(), url: `https://remoteok.com/jobs/role-${index}`,
    apply_url: `https://employer.example.test/apply/${index}`
  }))];
  const discovery = new DiscoveryService({ applicationService, profiles, config,
    fetchImpl: async () => new Response(JSON.stringify(rows)) });
  const campaign = await discovery.startCampaign({ target: 1, reserve: 0,
    limitPerSource: 10 }, identity);
  assert.equal(campaign.scan.found, 22);
  assert.equal(campaign.scan.qualifying, 1);
  assert.equal(campaign.scan.selectedOpportunityIds.length, 0);
  assert.equal(campaign.scan.sourceYield[0].destinationPending, 1);
  assert.equal(store.snapshot().opportunities.find((item) =>
    item.externalId === "role-21")?.applicationDestinationPending, true);
  assert.equal(store.snapshot().applications.length, 0);
});

test("a pending destination cannot consume the actionable per-source slot", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pending-source-slot-"));
  const identity = { actorId: "owner", profileId: "owner" };
  const profiles = await new ProfileStore(path.join(directory, "profiles.json"),
    { allowMissing: true }).init();
  await profiles.patch(identity.profileId, {
    contact: { firstName: "Applicant", lastName: "Example", email: "owner@example.test",
      phone: "+10000000000", location: "Canada" },
    documents: { resume: "/secure/resume.pdf" }, skills: ["TypeScript", "Node.js"],
    preferences: { locations: ["Canada", "Worldwide"], fullTime: {
      jobTitles: ["Widget Runtime Engineer"], allowedLocations: ["Canada", "Worldwide"],
      remoteOnly: true, automatedDiscoverySources: ["ashby"] } }
  });
  const readyId = "11111111-1111-4111-8111-111111111111";
  const config = { defaultMode: "full_time", discovery: { limitPerSource: 1,
    sourceOptions: { ashby: { boards: [{ slug: "sample", company: "Example" }] } } },
    modes: { full_time: { minimumScore: 0, autoApplyDiscovered: false,
      sources: ["ashby"], requireConfirmationFor: [] } } };
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  const applicationService = new ApplicationService({ store, config,
    adapter: { name: "unused", async submit() {} }, profiles });
  const discovery = new DiscoveryService({ applicationService, profiles, config,
    fetchImpl: async () => new Response(JSON.stringify({ jobs: [
      { id: "pending", title: "Widget Runtime Engineer", descriptionPlain: "TypeScript Node.js",
        location: "Worldwide", isRemote: true,
        applyUrl: "https://employer.example.test/apply/pending",
        jobUrl: "https://employer.example.test/jobs/pending" },
      { id: readyId, title: "Widget Runtime Engineer", descriptionPlain: "TypeScript Node.js",
        location: "Worldwide", isRemote: true,
        applyUrl: `https://jobs.ashbyhq.com/sample/${readyId}/application`,
        jobUrl: `https://jobs.ashbyhq.com/sample/${readyId}` }
    ] })) });
  const campaign = await discovery.startCampaign({ target: 1, reserve: 0,
    sources: ["ashby"], limitPerSource: 1 }, identity);
  assert.deepEqual(campaign.scan.selectedOpportunityIds.map((id) =>
    store.snapshot().opportunities.find((item) => item.id === id)?.externalId),
  [`sample:${readyId}`]);
  assert.equal(campaign.scan.sourceYield[0].destinationPending, 1);
  assert.equal(campaign.scan.sourceYield[0].selected, 1);
});

test("strong uncertain roles stay visible for fit review without automatic application", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fit-review-"));
  const identity = { actorId: "owner", profileId: "owner" };
  const profiles = await new ProfileStore(path.join(directory, "profiles.json"), { allowMissing: true }).init();
  await profiles.patch(identity.profileId, {
    contact: { firstName: "Applicant", lastName: "Example", email: "owner@example.test",
      phone: "+10000000000", location: "Canada" },
    documents: { resume: "/secure/resume.pdf" },
    skills: ["TypeScript", "Node.js", "PostgreSQL", "AWS", "Docker", "Python"],
    preferences: { locations: ["Canada", "Worldwide"], fullTime: {
      jobTitles: ["Widget Runtime Engineer"], allowedLocations: ["Canada", "Worldwide"],
      remoteOnly: true, opportunisticRoles: { enabled: true, minimumMatchedSkills: 5,
        minimumScore: 65 }, automatedDiscoverySources: ["remoteok"]
    } }
  });
  const config = { defaultMode: "full_time", discovery: { limitPerSource: 10 },
    modes: { full_time: { minimumScore: 75, autoApplyDiscovered: true,
      sources: ["remoteok"], requireConfirmationFor: [] } } };
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  const applicationService = new ApplicationService({ store, config,
    adapter: { name: "unused", async submit() {} }, profiles });
  const discovery = new DiscoveryService({ applicationService, profiles, config,
    fetchImpl: async () => new Response(JSON.stringify([{ legal: "metadata" }, {
      id: "uncertain", position: "Widget Operations Developer", company: "Example",
      description: "TypeScript Node.js PostgreSQL AWS Docker Python",
      tags: [], location: "Worldwide", date: new Date().toISOString(),
      url: "https://remoteok.com/jobs/uncertain",
      apply_url: "https://employer.example.test/apply/uncertain"
    }])) });
  const campaign = await discovery.startCampaign({ target: 1, reserve: 0 }, identity);
  assert.equal(campaign.scan.qualifying, 0);
  assert.equal(campaign.applications.length, 0);
  assert.equal(campaign.scan.fitReviewCandidates.length, 1);
  assert.equal(campaign.scan.fitReviewCandidates[0].reason, "opportunistic_requirements");
  assert.equal(campaign.scan.fitReviewCandidates[0].title, "Widget Operations Developer");
});

test("an unverified title skill is held for fit review instead of disappearing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fit-review-skill-"));
  const identity = { actorId: "owner", profileId: "owner" };
  const profiles = await new ProfileStore(path.join(directory, "profiles.json"), { allowMissing: true }).init();
  await profiles.patch(identity.profileId, {
    contact: { firstName: "Applicant", lastName: "Example", email: "owner@example.test",
      phone: "+10000000000", location: "Canada" },
    documents: { resume: "/secure/resume.pdf" },
    skills: ["TypeScript", "Node.js"],
    preferences: { locations: ["Canada", "Worldwide"], fullTime: {
      jobTitles: ["Runtime Engineer"], allowedLocations: ["Canada", "Worldwide"],
      remoteOnly: true, automatedDiscoverySources: ["remoteok"]
    } }
  });
  const config = { defaultMode: "full_time", discovery: { limitPerSource: 10 },
    modes: { full_time: { minimumScore: 75, autoApplyDiscovered: true,
      sources: ["remoteok"], requireConfirmationFor: [] } } };
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  const applicationService = new ApplicationService({ store, config,
    adapter: { name: "unused", async submit() {} }, profiles });
  const discovery = new DiscoveryService({ applicationService, profiles, config,
    fetchImpl: async () => new Response(JSON.stringify([{ legal: "metadata" }, {
      id: "unknown-skill", position: "Java Runtime Engineer", company: "Example",
      description: "TypeScript Node.js platform", location: "Worldwide",
      date: new Date().toISOString(), url: "https://remoteok.com/jobs/unknown-skill",
      apply_url: "https://employer.example.test/apply/unknown-skill"
    }])) });
  const campaign = await discovery.startCampaign({ target: 1, reserve: 0 }, identity);
  assert.equal(campaign.scan.qualifying, 0);
  assert.equal(campaign.applications.length, 0);
  assert.equal(campaign.scan.fitReviewCandidates.length, 1);
  assert.equal(campaign.scan.fitReviewCandidates[0].reason, "unverified_required_skill");
});

test("a high-scoring specialist role stays in review instead of entering the application queue", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fit-review-specialist-"));
  const identity = { actorId: "owner", profileId: "owner" };
  const profiles = await new ProfileStore(path.join(directory, "profiles.json"), { allowMissing: true }).init();
  await profiles.patch(identity.profileId, {
    contact: { firstName: "Applicant", lastName: "Example", email: "owner@example.test",
      phone: "+10000000000", location: "Canada" },
    documents: { resume: "/secure/resume.pdf" },
    skills: ["TypeScript", "Node.js", "PostgreSQL", "AWS", "Docker", "Python"],
    preferences: { locations: ["Canada", "Worldwide"], fullTime: {
      jobTitles: ["Senior Software Engineer"], allowedLocations: ["Canada", "Worldwide"],
      remoteOnly: true, automatedDiscoverySources: ["remoteok"]
    } }
  });
  const config = { defaultMode: "full_time", discovery: { limitPerSource: 10 },
    modes: { full_time: { minimumScore: 75, autoApplyDiscovered: true,
      sources: ["remoteok"], requireConfirmationFor: [] } } };
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  const applicationService = new ApplicationService({ store, config,
    adapter: { name: "unused", async submit() {} }, profiles });
  const discovery = new DiscoveryService({ applicationService, profiles, config,
    fetchImpl: async () => new Response(JSON.stringify([{ legal: "metadata" }, {
      id: "specialist", position: "Senior Security Engineer", company: "Example",
      description: "Build TypeScript Node.js PostgreSQL AWS Docker Python systems",
      location: "Worldwide", date: new Date().toISOString(),
      url: "https://remoteok.com/jobs/specialist",
      apply_url: "https://employer.example.test/apply/specialist"
    }])) });
  const campaign = await discovery.startCampaign({ target: 1, reserve: 0 }, identity);
  assert.equal(campaign.scan.qualifying, 0);
  assert.equal(campaign.applications.length, 0);
  assert.equal(campaign.scan.fitReviewCandidates.length, 1);
  assert.ok(campaign.scan.fitReviewCandidates[0].score >= 75);
  assert.equal(campaign.scan.fitReviewCandidates[0].reason, "unverified_specialization");
  assert.equal(campaign.scan.fitReviewCandidates[0].reviewRequirement, "security engineering");
  assert.equal(campaign.scan.sourceYield[0].exclusionCounts.fitReview, 1);
});

test("low-score software role reaches fit review while unrelated title stays excluded", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fit-review-low-"));
  const identity = { actorId: "owner", profileId: "owner" };
  const profiles = await new ProfileStore(path.join(directory, "profiles.json"), { allowMissing: true }).init();
  await profiles.patch(identity.profileId, {
    contact: { firstName: "Applicant", lastName: "Example", email: "owner@example.test",
      phone: "+10000000000", location: "Canada" },
    documents: { resume: "/secure/resume.pdf" },
    skills: ["TypeScript", "Node.js", "PostgreSQL", "AWS", "Docker", "Python"],
    preferences: { locations: ["Canada", "Worldwide"], fullTime: {
      jobTitles: ["Software Engineer"], allowedLocations: ["Canada", "Worldwide"],
      remoteOnly: true, automatedDiscoverySources: ["remoteok"]
    } }
  });
  const config = { defaultMode: "full_time", discovery: { limitPerSource: 10 },
    modes: { full_time: { minimumScore: 75, autoApplyDiscovered: true,
      sources: ["remoteok"], requireConfirmationFor: [] } } };
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  const applicationService = new ApplicationService({ store, config,
    adapter: { name: "unused", async submit() {} }, profiles });
  const rows = [
    { id: "low-suitable", position: "Software Developer", company: "Example",
      description: "Build TypeScript services", location: "Worldwide",
      date: new Date().toISOString(), url: "https://remoteok.com/jobs/low-suitable",
      apply_url: "https://employer.example.test/apply/low-suitable" },
    { id: "unrelated", position: "Sales Engineer", company: "Example",
      description: "Our sales team uses TypeScript Node.js PostgreSQL AWS Docker Python",
      location: "Worldwide", date: new Date().toISOString(),
      url: "https://remoteok.com/jobs/unrelated",
      apply_url: "https://employer.example.test/apply/unrelated" }
  ];
  const discovery = new DiscoveryService({ applicationService, profiles, config,
    fetchImpl: async () => new Response(JSON.stringify([{ legal: "metadata" }, ...rows])) });
  const campaign = await discovery.startCampaign({ target: 1, reserve: 0 }, identity);
  assert.equal(campaign.scan.qualifying, 0);
  assert.equal(campaign.applications.length, 0);
  assert.deepEqual(campaign.scan.fitReviewCandidates.map((item) => item.externalId),
    ["low-suitable"]);
  assert.ok(campaign.scan.fitReviewCandidates[0].score < 60);
  assert.equal(campaign.scan.sourceYield[0].exclusionCounts.hardExclusion, 1);
});
