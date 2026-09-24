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

const identity = { actorId: "agent", profileId: "person" };
const roleId = "11111111-1111-4111-8111-111111111111";
const ashbyUrl = `https://jobs.ashbyhq.com/example/${roleId}/application`;
const greenhouseUrl = "https://job-boards.greenhouse.io/example/jobs/12345";
const leverUrl = `https://jobs.lever.co/example/${roleId}/apply`;
const officialAshby = { id: roleId, title: "Software Engineer", applyUrl: ashbyUrl,
  jobUrl: `https://jobs.ashbyhq.com/example/${roleId}`,
  descriptionPlain: "TypeScript Node.js", location: "Bulgaria", isRemote: true,
  isListed: true, employmentType: "Full-Time", publishedAt: new Date().toISOString() };

async function fixture(fetchImpl, officialRequestPaceMs = 0) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aggregator-ats-"));
  const profiles = await new ProfileStore(path.join(directory, "profiles.json"), { allowMissing: true }).init();
  await profiles.patch("person", {
    contact: { firstName: "Applicant", lastName: "Example", email: "person@example.test",
      phone: "+10000000000", location: "Bulgaria" },
    documents: { resume: "/private/resume.pdf" }, skills: ["TypeScript", "Node.js"],
    preferences: { locations: ["Bulgaria", "Worldwide"], fullTime: {
      jobTitles: ["Software Engineer"], allowedLocations: ["Bulgaria", "Worldwide"],
      remoteOnly: true, automatedDiscoverySources: ["jobicy", "himalayas"]
    } }
  });
  const config = { defaultMode: "full_time", discovery: { limitPerSource: 10 },
    modes: { full_time: { minimumScore: 75, autoApply: true,
      autoApplyDiscovered: true, sources: ["jobicy", "himalayas"],
      requireConfirmationFor: [], dailyApplicationCap: 10 } } };
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  const service = new ApplicationService({ store, config, profiles,
    adapter: new SimulationAdapter() });
  service.enqueue = () => {};
  const discovery = new DiscoveryService({ applicationService: service, profiles, config, fetchImpl,
    officialRequestPaceMs });
  return { service, discovery, store, config };
}

const jobicyRow = (url) => ({ id: 1, jobTitle: "Software Engineer",
  companyName: "Aggregator Label", url, jobDescription: "TypeScript Node.js",
  jobGeo: "Worldwide", jobType: ["Full Time"], pubDate: new Date().toISOString() });
const himalayasRow = (url) => ({ guid: "h-1", title: "Software Engineer",
  companyName: "Aggregator Label", applicationLink: url,
  description: "TypeScript Node.js", locationRestrictions: ["Worldwide"],
  employmentType: "Full Time", pubDate: new Date().toISOString() });

test("concurrent official board fetches keep the same-origin request pace", async () => {
  const started = [];
  const { discovery, config } = await fixture(async (url) => {
    assert.match(String(url), /api\.ashbyhq\.com/);
    started.push(Date.now());
    return new Response(JSON.stringify({ jobs: [] }));
  }, 20);
  config.discovery.sourceOptions = { ashby: { boards: [
    { slug: "sample-one" }, { slug: "sample-two" }, { slug: "sample-three" }
  ] } };
  const result = await discovery.scan({ sources: ["ashby"], prepareApplications: false }, identity);
  assert.equal(result.requestsMade, 3);
  assert.equal(started.length, 3);
  assert.ok(started[1] - started[0] >= 15, String(started));
  assert.ok(started[2] - started[1] >= 15, String(started));
});

test("an official board rate limit cancels later queued requests on its origin", async () => {
  const requested = [];
  const { discovery, config, store } = await fixture(async (url) => {
    requested.push(String(url));
    return new Response("rate limited", { status: 429 });
  }, 1);
  config.discovery.sourceOptions = { ashby: { boards: [
    { slug: "sample-one" }, { slug: "sample-two" }, { slug: "sample-three" }
  ] } };
  const result = await discovery.scan({ sources: ["ashby"], prepareApplications: false }, identity);
  assert.equal(requested.length, 1);
  assert.equal(result.requestsMade, 1);
  assert.equal(result.sourceYield[0].rateLimited, true);
  assert.ok(store.snapshot().audit.some((item) => item.action === "discovery.ats_backoff"
    && item.subjectId === "ashby:sample-one"));
  await discovery.scan({ sources: ["ashby"], prepareApplications: false }, identity);
  assert.equal(requested.length, 2);
  assert.match(requested[1], /sample-two$/);
});

test("two aggregator sources resolve one Ashby role, re-score official evidence, and queue once", async () => {
  let officialFetches = 0;
  const { service, discovery } = await fixture(async (url) => {
    const value = String(url);
    if (value.includes("jobicy.com/api/")) return new Response(JSON.stringify({ jobs: [jobicyRow(ashbyUrl)] }));
    if (value.includes("himalayas.app/jobs/api/")) return new Response(JSON.stringify({ jobs: [himalayasRow(ashbyUrl)] }));
    if (value.includes("api.ashbyhq.com/")) {
      officialFetches += 1;
      return new Response(JSON.stringify({ jobs: [officialAshby] }));
    }
    throw new Error(`unexpected fetch ${value}`);
  });
  const campaign = await discovery.startCampaign({ target: 1, reserve: 0,
    sources: ["jobicy", "himalayas"] }, identity);
  assert.equal(officialFetches, 1);
  assert.equal(campaign.applications.length, 1);
  assert.equal(campaign.applications[0].status, "queued");
  const opportunities = service.list("opportunities", "person");
  assert.equal(opportunities.length, 1);
  assert.equal(opportunities[0].source, "ashby");
  assert.equal(opportunities[0].externalId, `example:${roleId}`);
  assert.equal(opportunities[0].company, "example");
  assert.equal(opportunities[0].location, "Bulgaria");
  assert.equal(opportunities[0].applicationDestinationVerified, true);
  assert.equal(opportunities[0].discoverySource, "jobicy");
  assert.equal(campaign.scan.sourceYield
    .reduce((sum, row) => sum + row.selected, 0), 1);
});

test("bounded board redirect to Ashby is verified; non-ATS redirect stays pending", async () => {
  const boardUrl = "https://jobicy.com/jobs/one";
  let headCalls = 0;
  const { discovery } = await fixture(async (url, options = {}) => {
    const value = String(url);
    if (value.includes("jobicy.com/api/")) return new Response(JSON.stringify({ jobs: [jobicyRow(boardUrl)] }));
    if (value === boardUrl && options.method === "HEAD") {
      headCalls += 1;
      return new Response(null, { status: 302, headers: { location: ashbyUrl } });
    }
    if (value.includes("api.ashbyhq.com/")) return new Response(JSON.stringify({ jobs: [officialAshby] }));
    throw new Error(`unexpected fetch ${value}`);
  });
  const result = await discovery.scan({ sources: ["jobicy"], prepareApplications: false }, identity);
  assert.equal(headCalls, 1);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].opportunity.source, "ashby");

  const { discovery: nonAts } = await fixture(async (url, options = {}) => {
    const value = String(url);
    if (value.includes("jobicy.com/api/")) return new Response(JSON.stringify({ jobs: [jobicyRow(boardUrl)] }));
    if (value === boardUrl && options.method === "HEAD") return new Response(null, {
      status: 302, headers: { location: "https://employer.example.test/apply" } });
    throw new Error(`unexpected fetch ${value}`);
  });
  const pending = await nonAts.scan({ sources: ["jobicy"], prepareApplications: false }, identity);
  assert.equal(pending.items.length, 1);
  assert.equal(pending.items[0].opportunity.applicationDestinationPending, true);
  assert.equal(pending.items[0].opportunity.applicationDestinationVerified, false);
});

test("Himalayas explicit description link promotes only the matching current employer role", async () => {
  const boardUrl = "https://himalayas.app/companies/example/jobs/software-engineer";
  const requested = [];
  const { discovery, service } = await fixture(async (url) => {
    const value = String(url);
    requested.push(value);
    if (value.includes("himalayas.app/jobs/api/")) return new Response(JSON.stringify({ jobs: [
      { ...himalayasRow(boardUrl), companyName: "Example",
        description: `<p>TypeScript Node.js</p><p>Apply here: ${ashbyUrl}</p>` }
    ] }));
    if (value.includes("api.ashbyhq.com/")) return new Response(JSON.stringify({ jobs: [officialAshby] }));
    throw new Error(`unexpected fetch ${value}`);
  });
  const result = await discovery.scan({ sources: ["himalayas"], prepareApplications: true }, identity);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].opportunity.source, "ashby");
  assert.equal(result.items[0].opportunity.applicationDestinationVerified, true);
  assert.equal(service.list("applications", "person").length, 1);
  assert.equal(requested.filter((url) => url.includes("api.ashbyhq.com/")).length, 1);
  assert.ok(requested.every((url) => url.includes("himalayas.app/jobs/api/")
    || url.includes("api.ashbyhq.com/")), "the board page and arbitrary employer sites are not fetched");
});

test("Himalayas description links with ambiguous or mismatched role identity never promote", async () => {
  const boardUrl = "https://himalayas.app/companies/example/jobs/software-engineer";
  for (const variant of [
    { description: `TypeScript Node.js. Apply here: ${ashbyUrl} Also: https://jobs.ashbyhq.com/example/22222222-2222-4222-8222-222222222222` },
    { title: "Software Engineer, Platform", description: `TypeScript Node.js. Apply here: ${ashbyUrl}` },
    { companyName: "Other Employer", description: `TypeScript Node.js. Apply here: ${ashbyUrl}` }
  ]) {
    let officialFetches = 0;
    const { discovery, service } = await fixture(async (url, options = {}) => {
      const value = String(url);
      if (value.includes("himalayas.app/jobs/api/")) return new Response(JSON.stringify({ jobs: [
        { ...himalayasRow(boardUrl), companyName: "Example", ...variant }
      ] }));
      if (value === boardUrl && options.method === "HEAD") return new Response(null, { status: 200 });
      if (value.includes("api.ashbyhq.com/")) {
        officialFetches += 1;
        return new Response(JSON.stringify({ jobs: [officialAshby] }));
      }
      throw new Error(`unexpected fetch ${value}`);
    });
    const result = await discovery.scan({ sources: ["himalayas"], prepareApplications: true }, identity);
    assert.ok(result.items.every((item) => item.opportunity.applicationDestinationPending),
      JSON.stringify(variant));
    assert.equal(service.list("applications", "person").length, 0);
    assert.ok(officialFetches <= 1);
  }
});

test("Himalayas inline official 429 stops promotion and later lookup retry", async () => {
  const boardUrl = "https://himalayas.app/companies/example/jobs/software-engineer";
  let officialFetches = 0;
  const { discovery, store } = await fixture(async (url) => {
    const value = String(url);
    if (value.includes("himalayas.app/jobs/api/")) return new Response(JSON.stringify({ jobs: [
      { ...himalayasRow(boardUrl), companyName: "Example",
        description: `TypeScript Node.js. Apply here: ${ashbyUrl}` }
    ] }));
    if (value.includes("api.ashbyhq.com/")) {
      officialFetches += 1;
      return new Response("limited", { status: 429 });
    }
    throw new Error(`unexpected fetch ${value}`);
  });
  const first = await discovery.scan({ sources: ["himalayas"], prepareApplications: true }, identity);
  assert.equal(first.items[0].opportunity.applicationDestinationPending, true);
  assert.equal(first.sourceYield[0].rateLimited, true);
  await discovery.scan({ sources: ["himalayas"], prepareApplications: true }, identity);
  assert.equal(officialFetches, 1);
  assert.ok(store.snapshot().audit.some((item) => item.action === "discovery.ats_backoff"
    && item.subjectId === "ashby:example"));
});

test("Jobicy description links do not bypass its canonical listing destination", async () => {
  const boardUrl = "https://jobicy.com/jobs/software-engineer";
  let officialFetches = 0;
  const { discovery, service } = await fixture(async (url, options = {}) => {
    const value = String(url);
    if (value.includes("jobicy.com/api/")) return new Response(JSON.stringify({ jobs: [
      { ...jobicyRow(boardUrl), jobDescription: `TypeScript Node.js. Apply here: ${ashbyUrl}` }
    ] }));
    if (value === boardUrl && options.method === "HEAD") return new Response(null, { status: 200 });
    if (value.includes("api.ashbyhq.com/")) {
      officialFetches += 1;
      return new Response(JSON.stringify({ jobs: [officialAshby] }));
    }
    throw new Error(`unexpected fetch ${value}`);
  });
  const result = await discovery.scan({ sources: ["jobicy"], prepareApplications: true }, identity);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].opportunity.applicationDestinationPending, true);
  assert.equal(service.list("applications", "person").length, 0);
  assert.equal(officialFetches, 0);
});

test("Himalayas inline role link cannot override official geography", async () => {
  const boardUrl = "https://himalayas.app/companies/example/jobs/software-engineer";
  const { discovery, service } = await fixture(async (url) => {
    const value = String(url);
    if (value.includes("himalayas.app/jobs/api/")) return new Response(JSON.stringify({ jobs: [
      { ...himalayasRow(boardUrl), companyName: "Example",
        description: `TypeScript Node.js. Apply here: ${ashbyUrl}` }
    ] }));
    if (value.includes("api.ashbyhq.com/")) return new Response(JSON.stringify({ jobs: [
      { ...officialAshby, location: "United States" }
    ] }));
    throw new Error(`unexpected fetch ${value}`);
  });
  const result = await discovery.scan({ sources: ["himalayas"], prepareApplications: true }, identity);
  assert.equal(result.items.length, 0);
  assert.equal(result.excluded, 1);
  assert.equal(service.list("applications", "person").length, 0);
});

test("official employer geography and closed or mismatched role override aggregator claims", async () => {
  for (const officialRows of [[{ ...officialAshby, location: "United States" }],
    [], [{ ...officialAshby, id: "22222222-2222-4222-8222-222222222222" }],
    [{ ...officialAshby, isListed: false }]]) {
    const { service, discovery } = await fixture(async (url) => {
      const value = String(url);
      if (value.includes("jobicy.com/api/")) return new Response(JSON.stringify({ jobs: [jobicyRow(ashbyUrl)] }));
      if (value.includes("api.ashbyhq.com/")) return new Response(JSON.stringify({ jobs: officialRows }));
      throw new Error(`unexpected fetch ${value}`);
    });
    const result = await discovery.scan({ sources: ["jobicy"], prepareApplications: true }, identity);
    assert.equal(result.items.length, 0);
    assert.equal(result.excluded, 1);
    assert.equal(service.list("applications", "person").length, 0);
  }
});

test("Greenhouse and Lever direct URLs receive current official role evidence", async () => {
  for (const [url, endpoint, payload, source] of [
    [greenhouseUrl, "boards-api.greenhouse.io", { id: 12345, title: "Software Engineer",
      absolute_url: greenhouseUrl, location: { name: "Remote, Bulgaria" },
      content: "TypeScript Node.js" }, "greenhouse"],
    [leverUrl, "api.lever.co", { id: roleId, text: "Software Engineer",
      applyUrl: leverUrl, hostedUrl: `https://jobs.lever.co/example/${roleId}`,
      workplaceType: "remote", categories: { location: "Bulgaria", commitment: "Full-Time" },
      descriptionPlain: "TypeScript Node.js" }, "lever"]
  ]) {
    const { discovery } = await fixture(async (requestUrl) => {
      const value = String(requestUrl);
      if (value.includes("jobicy.com/api/")) return new Response(JSON.stringify({ jobs: [jobicyRow(url)] }));
      if (value.includes(endpoint)) return new Response(JSON.stringify(payload));
      throw new Error(`unexpected fetch ${value}`);
    });
    const result = await discovery.scan({ sources: ["jobicy"], prepareApplications: false }, identity);
    assert.equal(result.items.length, 1, source);
    assert.equal(result.items[0].opportunity.source, source);
    assert.equal(result.items[0].opportunity.applicationDestinationVerified, true);
  }
});

test("official ATS 429 holds the aggregator role and activates profile board cooldown", async () => {
  let officialFetches = 0;
  const { service, discovery, store } = await fixture(async (url) => {
    const value = String(url);
    if (value.includes("jobicy.com/api/")) return new Response(JSON.stringify({ jobs: [jobicyRow(ashbyUrl)] }));
    if (value.includes("api.ashbyhq.com/")) {
      officialFetches += 1;
      return new Response("limited", { status: 429 });
    }
    throw new Error(`unexpected fetch ${value}`);
  });
  const first = await discovery.scan({ sources: ["jobicy"], prepareApplications: true }, identity);
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].opportunity.applicationDestinationPending, true);
  assert.equal(first.sourceYield[0].rateLimited, true);
  assert.equal(service.list("applications", "person").length, 0);
  assert.equal(store.snapshot().audit.filter((item) => item.action === "discovery.ats_backoff"
    && item.subjectId === "ashby:example").length, 1);
  const second = await discovery.scan({ sources: ["jobicy"], prepareApplications: true }, identity);
  assert.equal(second.items.length, 0);
  assert.equal(second.sourceYield[0].retryDeferred, 1);
  assert.equal(officialFetches, 1);
});

test("aggregator redirect 429 activates a source cooldown without following more links", async () => {
  const boardUrl = "https://jobicy.com/jobs/one";
  let headCalls = 0;
  const { discovery, store } = await fixture(async (url, options = {}) => {
    const value = String(url);
    if (value.includes("jobicy.com/api/")) return new Response(JSON.stringify({ jobs: [jobicyRow(boardUrl)] }));
    if (value === boardUrl && options.method === "HEAD") {
      headCalls += 1;
      return new Response("limited", { status: 429 });
    }
    throw new Error(`unexpected fetch ${value}`);
  });
  const first = await discovery.scan({ sources: ["jobicy"], prepareApplications: false }, identity);
  assert.equal(first.items[0].opportunity.applicationDestinationPending, true);
  assert.equal(first.sourceYield[0].rateLimited, true);
  assert.equal(store.snapshot().audit.filter((item) => item.action === "discovery.aggregator_backoff"
    && item.subjectId === "jobicy").length, 1);
  const second = await discovery.scan({ sources: ["jobicy"], prepareApplications: false }, identity);
  assert.equal(second.items.length, 0);
  assert.equal(second.sourceYield[0].retryDeferred, 1);
  assert.equal(headCalls, 1);
});

test("official resolution obeys the source request budget", async () => {
  let total = 0;
  let officialFetches = 0;
  const { discovery, service } = await fixture(async (url) => {
    total += 1;
    const value = String(url);
    if (value.includes("jobicy.com/api/")) return new Response(JSON.stringify({ jobs: [jobicyRow(ashbyUrl)] }));
    if (value.includes("api.ashbyhq.com/")) {
      officialFetches += 1;
      return new Response(JSON.stringify({ jobs: [officialAshby] }));
    }
    throw new Error(`unexpected fetch ${value}`);
  });
  const result = await discovery.scan({ sources: ["jobicy"], prepareApplications: true,
    maxRequestsPerSource: 1, maxRequests: 1 }, identity);
  assert.equal(total, 1);
  assert.equal(officialFetches, 0);
  assert.equal(result.sourceYield[0].requestsMade, 1);
  assert.ok(result.sourceYield[0].partialReasons.includes("partial_official_verification_budget"));
  assert.equal(result.items[0].opportunity.applicationDestinationPending, true);
  assert.equal(service.list("applications", "person").length, 0);
});

test("new same-origin official lookups are paced", async () => {
  const headStarts = [];
  const boardUrls = ["https://jobicy.com/jobs/one", "https://jobicy.com/jobs/two"];
  const { discovery } = await fixture(async (url, options = {}) => {
    const value = String(url);
    if (value.includes("jobicy.com/api/")) return new Response(JSON.stringify({ jobs:
      boardUrls.map((boardUrl, index) => ({ ...jobicyRow(boardUrl), id: index + 1 })) }));
    if (boardUrls.includes(value) && options.method === "HEAD") {
      headStarts.push(Date.now());
      return new Response(null, { status: 302,
        headers: { location: "https://employer.example.test/apply" } });
    }
    throw new Error(`unexpected fetch ${value}`);
  }, 30);
  await discovery.scan({ sources: ["jobicy"], prepareApplications: false }, identity);
  assert.equal(headStarts.length, 2);
  assert.ok(headStarts[1] - headStarts[0] >= 25);
});

test("invalid candidate-cap configuration cannot make verification unbounded", async () => {
  const ids = Array.from({ length: 11 }, (_, index) =>
    `11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`);
  const rows = ids.map((id, index) => ({ ...jobicyRow(
    `https://jobs.ashbyhq.com/example/${id}/application`), id: index + 1 }));
  const officialRows = ids.map((id) => ({ ...officialAshby, id,
    applyUrl: `https://jobs.ashbyhq.com/example/${id}/application`,
    jobUrl: `https://jobs.ashbyhq.com/example/${id}` }));
  const { discovery, config } = await fixture(async (url) => {
    const value = String(url);
    if (value.includes("jobicy.com/api/")) return new Response(JSON.stringify({ jobs: rows }));
    if (value.includes("api.ashbyhq.com/")) return new Response(JSON.stringify({ jobs: officialRows }));
    throw new Error(`unexpected fetch ${value}`);
  });
  config.discovery.officialVerificationMaxCandidatesPerSource = Number.NaN;
  const result = await discovery.scan({ sources: ["jobicy"], prepareApplications: false }, identity);
  assert.equal(result.items.filter((item) => item.opportunity.applicationDestinationPending).length, 1);
  assert.ok(result.sourceYield[0].partialReasons.includes("partial_official_verification_budget"));
});
