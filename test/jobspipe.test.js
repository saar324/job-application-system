import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { SimulationAdapter } from "../src/adapters/simulation.js";
import { loadConfig } from "../src/config.js";
import { DiscoveryService } from "../src/discovery/service.js";
import { normalizeOpportunity } from "../src/discovery/normalization.js";
import { scoreOpportunity } from "../src/discovery/scoring.js";
import { jobspipe, jobspipeQuotaLimits } from "../src/discovery/sources/jobspipe.js";
import { redactSecrets } from "../src/discovery/source-credentials.js";
import { SourceQuota } from "../src/discovery/source-quota.js";
import { ProfileStore } from "../src/profile-store.js";
import { ApplicationService } from "../src/service.js";
import { SqliteStore } from "../src/sqlite-store.js";
import { JsonStore } from "../src/store.js";

const execute = promisify(execFile);
const identity = { actorId: "applicant-one-agent", profileId: "applicant-one" };
const apiKey = "jp_live_test_placeholder";
const sourceEnv = { JOBSPIPE_API_KEY: apiKey };
const profile = { preferences: { fullTime: { jobTitles: ["Platform Engineer"] } } };
const ENDPOINT = "https://api.jobspipe.dev/v1/jobs/search";
const GREENHOUSE_URL = "https://job-boards.greenhouse.io/fictionalboard/jobs/4000001";
const RECRUITER_EMAILS = ["talent.partner@example.test", "hiring.team@example.test"];

// Shape captured from the keyless sandbox endpoint, with every company, URL
// and person replaced by fictional example.test data.
function row(id, overrides = {}) {
  return {
    id, job_title: "Senior Platform Engineer", normalized_title: "platform engineer",
    url: `https://careers.fictional-freight.example.test/jobs/${id}`,
    source_url: `https://board.example.test/listing/${id}`,
    company: "Fictional Freight", company_domain: "fictional-freight.example.test",
    company_object: { name: "Fictional Freight", funding_total_usd: 12000000, revenue_usd: 3400000,
      employee_count: 120 },
    description: "<p>Build Node.js services for a logistics platform.</p>",
    location: "Leeds, United Kingdom", country_code: "GB", country_codes: ["GB"], cities: ["Leeds"],
    remote: false, hybrid: true, work_arrangement: "hybrid",
    salary_string: "£60,000 - £70,000", salary_currency: "GBP", min_annual_salary: 60000, max_annual_salary: 70000,
    min_annual_salary_usd: 76000, max_annual_salary_usd: 88000,
    estimated_min_annual_salary_usd: 70000, estimated_max_annual_salary_usd: 95000,
    estimated_median_annual_salary_usd: 82000,
    employment_statuses: ["full-time"], seniority: "senior",
    date_posted: "2026-09-20T08:00:00Z", discovered_at: "2026-09-20T09:00:00Z",
    last_seen_at: "2026-09-23T09:00:00Z", verified_at: "2026-09-23T10:00:00Z",
    status: "active", closed_at: null, expires_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
    keyword_slugs: ["node-js", "platform"], technology_slugs: ["kubernetes"],
    visa_sponsorship: "no", ghost_score: 12, recruiter_emails: RECRUITER_EMAILS, applicant_count: 87,
    sources: ["greenhouse", { name: "example-board" }],
    ...overrides
  };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status,
  headers: { "content-type": "application/json" } });
const page = (data, metadata = {}) => json({ metadata: { total_results: data.length, truncated_results: false,
  next_cursor: null, credits_charged: data.length, jobs_already_paid: 0, ...metadata }, data });

async function fixture({ options = {}, fetchImpl, env = sourceEnv, store: makeStore, mode = {} } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-jobspipe-test-"));
  const profiles = await new ProfileStore(path.join(directory, "profiles.json"), { allowMissing: true }).init();
  await profiles.patch("applicant-one", {
    contact: { firstName: "Applicant", lastName: "Example", email: "applicant@example.test",
      phone: "+10000000000", location: "Leeds, United Kingdom" },
    documents: { resume: "/secure/resume.pdf" },
    skills: ["Node.js"],
    preferences: { locations: ["Leeds", "Remote"], fullTime: { jobTitles: ["Platform Engineer"],
      automatedDiscoverySources: ["jobspipe"] } }
  });
  const config = { defaultMode: "full_time", discovery: { limitPerSource: 25,
    sourceOptions: { jobspipe: options } },
  modes: { full_time: { minimumScore: 0, dailyApplicationCap: 8, autoApply: true, autoApplyDiscovered: true,
    sources: ["jobspipe"], requireConfirmationFor: [], ...mode } } };
  const stateFile = path.join(directory, "state.json");
  const store = makeStore ? await makeStore(directory) : await new JsonStore(stateFile).init();
  const applicationService = new ApplicationService({ store, config, adapter: new SimulationAdapter() });
  const discovery = new DiscoveryService({ applicationService, profiles, config, fetchImpl, sourceEnv: env });
  return { directory, stateFile, store, applicationService, discovery, config, profiles };
}

// Records every provider request with its parsed body.
function provider(respond) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const call = { url: String(url), method: options.method ?? "GET", headers: options.headers ?? {},
      body: options.body ? JSON.parse(options.body) : undefined, at: Date.now() };
    calls.push(call);
    return respond(call, calls.length);
  };
  return { calls, fetchImpl };
}

test("JobsPipe sends an allowlisted Bearer POST for active roles and follows cursors up to the page cap", async () => {
  const { calls, fetchImpl } = provider((call, count) => page(
    Array.from({ length: 25 }, (_, index) => row(`jp-${count}-${index}`)), { next_cursor: `cursor-${count + 1}` }));
  const { discovery } = await fixture({ fetchImpl });
  const result = await discovery.scan({ prepareApplications: false, limitPerSource: 200 }, identity);
  assert.equal(calls.length, 2, "the default page cap is two");
  const [first, second] = calls;
  assert.equal(first.url, ENDPOINT);
  assert.equal(first.method, "POST");
  assert.equal(first.headers.authorization, `Bearer ${apiKey}`);
  assert.equal(first.headers["content-type"], "application/json");
  assert.deepEqual(first.body, { posted_at_max_age_days: 7, job_title_or: ["Platform Engineer"], status: "active",
    source_not: ["linkedin"], limit: 25 });
  assert.equal(second.body.cursor, "cursor-2", "a second body with the cursor is not served from the first's cache");
  assert.equal(result.found, 50);
  assert.equal(result.requestsMade, 2);

  const agent = provider(() => page([row("jp-agent")]));
  const overridden = await fixture({ fetchImpl: agent.fetchImpl, options: { excludeSources: [],
    defaultCountries: ["gb"], maxPages: 1 } });
  await overridden.discovery.query({ source: "jobspipe", scanCycleId: "cycle-one", idempotencyKey: "jobspipe-query",
    queries: [{ limit: 10, filters: { job_title_or: ["Site Reliability Engineer", "Platform Engineer"],
      remote: "true", work_arrangement_or: ["remote"], max_ghost_score: "40", source_not: ["example-board"] } }] },
  identity);
  assert.deepEqual(agent.calls[0].body, { posted_at_max_age_days: 7, job_country_code_or: ["GB"],
    job_title_or: ["Site Reliability Engineer", "Platform Engineer"], remote: true, work_arrangement_or: ["remote"],
    max_ghost_score: 40, source_not: ["example-board"], status: "active", limit: 10 });
});

test("the default LinkedIn exclusion is always in the body unless private config removes it", async () => {
  const quota = new SourceQuota(await new JsonStore(path.join(await mkdtemp(path.join(os.tmpdir(), "jp-li-")),
    "state.json")).init()).forSource("jobspipe", jobspipeQuotaLimits());
  const bodies = [];
  const fetchImpl = async (url, options) => { bodies.push(JSON.parse(options.body)); return page([]); };
  await jobspipe.search({ profile, credentials: { apiKey }, quota, fetchImpl });
  await jobspipe.search({ profile, credentials: { apiKey }, quota, fetchImpl, query: { source_not: ["example-board"] } });
  await jobspipe.search({ profile, credentials: { apiKey }, quota, fetchImpl, sourceConfig: { excludeSources: [] } });
  assert.deepEqual(bodies[0].source_not, ["linkedin"]);
  assert.deepEqual(bodies[1].source_not, ["linkedin", "example-board"], "agents can add exclusions, not remove them");
  assert.equal(bodies[2].source_not, undefined);
  assert.ok(bodies.every((body) => body.status === "active"));
});

test("JobsPipe results normalize with verification evidence, stated pay only, and no contact data", async () => {
  const quota = new SourceQuota(await new JsonStore(path.join(await mkdtemp(path.join(os.tmpdir(), "jp-norm-")),
    "state.json")).init()).forSource("jobspipe", jobspipeQuotaLimits());
  const items = await jobspipe.search({ profile, credentials: { apiKey }, quota,
    fetchImpl: async () => page([row("jp-1001"), row("jp-1002", { url: GREENHOUSE_URL, remote: true,
      work_arrangement: "remote", salary_currency: null, min_annual_salary: null, max_annual_salary: null }),
    row("jp-1003", { status: "closed" }), row("jp-1004", { expires_at: "2026-01-01T00:00:00Z" }),
    row("jp-1005", { url: "http://insecure.example.test/job", source_url: null })]) });
  assert.deepEqual(items.map((item) => item.externalId), ["jp-1001", "jp-1002"], "closed, expired and non-HTTPS rows are dropped");
  const [stated, official] = items;
  assert.equal(stated.source, "jobspipe");
  assert.equal(stated.title, "Senior Platform Engineer");
  assert.equal(stated.company, "Fictional Freight");
  assert.equal(stated.companyDomain, "fictional-freight.example.test");
  assert.equal(stated.description, "Build Node.js services for a logistics platform.");
  assert.equal(stated.location, "Leeds, United Kingdom");
  assert.equal(stated.remote, false);
  assert.equal(stated.employmentType, "full-time");
  assert.equal(stated.postedAt, "2026-09-20T08:00:00.000Z");
  assert.equal(stated.listingUrl, "https://careers.fictional-freight.example.test/jobs/jp-1001");
  assert.equal(stated.applyUrl, stated.listingUrl);
  assert.equal(stated.applicationDestinationPending, true);
  assert.equal(stated.applicationFlow, "resolve_employer_url_before_prepare");
  assert.equal(stated.postingStatus, "active");
  assert.ok(Date.parse(stated.validThrough) > Date.now());
  assert.deepEqual(stated.compensation, { minimum: 60000, maximum: 70000, currency: "GBP", period: "year" });
  assert.equal(stated.compensationEstimate, undefined);
  assert.deepEqual({ ...stated.postingEvidence, expiresAt: undefined }, { status: "active",
    verifiedAt: "2026-09-23T10:00:00.000Z", lastSeenAt: "2026-09-23T09:00:00.000Z", expiresAt: undefined,
    ghostScore: 12, visaSponsorship: "no", seniority: "senior", employmentStatuses: ["full-time"],
    countryCodes: ["GB"], originSources: ["greenhouse", "example-board"], workArrangement: "hybrid", hybrid: true });
  assert.deepEqual(stated.tags, ["node-js", "platform", "kubernetes"]);
  const serialized = JSON.stringify(items);
  for (const forbidden of [...RECRUITER_EMAILS, "recruiter_emails", "applicant_count", "funding_total_usd",
    "revenue_usd", "company_object"]) assert.equal(serialized.includes(forbidden), false, forbidden);

  assert.equal(official.applyUrl, GREENHOUSE_URL);
  assert.equal(official.officialAtsCandidateUrl, GREENHOUSE_URL);
  assert.equal(official.applicationFlow, "verify_official_ats_before_prepare");
  assert.equal(official.remote, true);
  assert.equal(official.compensation, undefined);
  assert.equal(official.compensationEstimate.median, 82000);
  assert.ok(official.uncertainties.includes("compensation_estimated"));
});

test("an estimated JobsPipe salary leaves compensation unknown for eligibility", async () => {
  const quota = new SourceQuota(await new JsonStore(path.join(await mkdtemp(path.join(os.tmpdir(), "jp-pay-")),
    "state.json")).init()).forSource("jobspipe", jobspipeQuotaLimits());
  const [estimated] = await jobspipe.search({ profile, credentials: { apiKey }, quota,
    fetchImpl: async () => page([row("jp-2001", { salary_currency: null, min_annual_salary: null,
      max_annual_salary: null, estimated_min_annual_salary_usd: null, estimated_max_annual_salary_usd: null,
      estimated_median_annual_salary_usd: 60000 })]) });
  const opportunity = normalizeOpportunity(estimated);
  assert.ok(opportunity.uncertainties.includes("compensation_unknown"));
  assert.equal(opportunity.provenance.compensation, undefined);
  const applicant = { skills: ["Node.js"], preferences: { locations: ["Leeds"], fullTime: {
    jobTitles: ["Platform Engineer"], minimumCompensation: 100000, compensationCurrency: "USD" } } };
  const scored = scoreOpportunity(opportunity, applicant, "full_time");
  assert.equal(scored.scoreDetails.hardExclusion, undefined);
  assert.equal(scored.scoreDetails.compensationComparable, false);
});

test("a missing JobsPipe key sends no request, and the key never appears after a 401 or a network error", async () => {
  const idle = provider(() => page([]));
  const missing = await fixture({ env: {}, fetchImpl: idle.fetchImpl });
  const unconfigured = await missing.discovery.scan({ prepareApplications: false }, identity);
  assert.equal(idle.calls.length, 0);
  assert.equal(unconfigured.errors[0].code, "source_not_configured");
  assert.match(unconfigured.errors[0].error, /JOBSPIPE_API_KEY/);
  assert.equal((await missing.discovery.describeSources(identity)).sources[0].configured, false);

  const rejected = provider((call) => new Response(`invalid key ${call.headers.authorization}`, { status: 401 }));
  const { discovery, stateFile, store, applicationService, profiles, config } = await fixture({
    fetchImpl: rejected.fetchImpl });
  const first = await discovery.startCampaign({ target: 1, reserve: 0, sources: ["jobspipe"], reserveOnly: true },
    identity).catch((error) => ({ failed: error.message }));
  const scan = await discovery.scan({ prepareApplications: false }, identity);
  assert.equal(rejected.calls.length, 1, "the source stays paused while the same key is configured");
  assert.equal(scan.errors[0].code, "key_rejected");
  const descriptor = await discovery.describeSources(identity);
  assert.equal(descriptor.sources[0].quota.cooldown.reason, "key_rejected");
  const serialized = [JSON.stringify(first), JSON.stringify(scan), JSON.stringify(descriptor),
    await readFile(stateFile, "utf8")].join("\n");
  assert.equal(serialized.includes(apiKey), false);
  assert.match(await readFile(stateFile, "utf8"), /key_rejected/);

  const replaced = new DiscoveryService({ applicationService, profiles, config, fetchImpl: rejected.fetchImpl,
    sourceEnv: { JOBSPIPE_API_KEY: "jp_test_replacement_placeholder" } });
  await replaced.scan({ prepareApplications: false }, identity);
  assert.equal(rejected.calls.length, 2, "a different key lifts the pause");
  assert.ok(store.snapshot().sourceQuota.holds.every((hold) => !hold.reason.includes(apiKey)));

  const network = await fixture({ fetchImpl: async (url, options) => {
    throw new Error(`connect ECONNREFUSED with header Authorization: ${options.headers.authorization}`);
  } });
  const failed = await network.discovery.scan({ prepareApplications: false }, identity);
  assert.match(failed.errors[0].error, /ECONNREFUSED with header Authorization: Bearer \[redacted\]/);
  assert.equal(JSON.stringify(failed).includes(apiKey), false);
  assert.equal(redactSecrets("Authorization: Bearer another-token-value"), "Authorization: Bearer [redacted]");
});

test("JobsPipe credits are clamped to the monthly allowance, settled from credits_charged, and survive a restart", async () => {
  const limits = jobspipeQuotaLimits();
  assert.deepEqual(limits, { second: 2, credits_month: 1000 });
  const { calls, fetchImpl } = provider((call) => page(Array.from({ length: call.body.limit },
    (_, index) => row(`jp-${call.body.limit}-${index}`)), { credits_charged: 3 }));
  const { discovery, directory, config, profiles } = await fixture({ fetchImpl,
    store: (directory) => new SqliteStore(path.join(directory, "state.sqlite")).init() });
  const seeded = await discovery.sourceQuota.reserve("jobspipe", limits, 0, { credits: 990 });
  assert.equal(seeded.credits, 990);

  const scan = await discovery.scan({ prepareApplications: false, limitPerSource: 25 }, identity);
  assert.equal(calls[0].body.limit, 10, "limit is lowered to the 10 credits left");
  assert.equal(scan.found, 10);
  let usage = await discovery.sourceQuota.usage("jobspipe", limits);
  assert.equal(usage.windows.credits_month.used, 993, "jobs already paid for are not charged again");
  assert.equal(usage.windows.credits_month.resetAt, new Date(Date.UTC(new Date().getUTCFullYear(),
    new Date().getUTCMonth() + 1, 1)).toISOString());
  discovery.applicationService.store.close();

  const store = await new SqliteStore(path.join(directory, "state.sqlite")).init();
  const applicationService = new ApplicationService({ store, config, adapter: new SimulationAdapter() });
  const restarted = new DiscoveryService({ applicationService, profiles, config, fetchImpl, sourceEnv });
  usage = await restarted.sourceQuota.usage("jobspipe", limits);
  assert.equal(usage.windows.credits_month.remaining, 7);
  await restarted.sourceQuota.reserve("jobspipe", limits, 0, { credits: 7 });
  const exhausted = await restarted.scan({ prepareApplications: false }, identity);
  assert.equal(calls.length, 1, "no request is sent once the month's credits are used");
  assert.equal(exhausted.requestsMade, 0);
  assert.equal(exhausted.errors[0].code, "quota_exhausted");
  assert.equal(exhausted.errors[0].window, "credits_month");
  assert.match(exhausted.errors[0].error, /allowance of 1000 credits/);
  const descriptor = await restarted.describeSources(identity);
  assert.equal(descriptor.sources[0].quota.windows.credits_month.remaining, 0);
  assert.equal(descriptor.sources[0].applicationFlow, "verify_official_ats_before_prepare");
  store.close();
});

test("JobsPipe 402, 400, 504 and 429 map to quota, charge, retry and cooldown outcomes", async () => {
  const limits = jobspipeQuotaLimits();
  const outcome = async (status) => {
    const { calls, fetchImpl } = provider(() => new Response(JSON.stringify({ error: "failure" }), { status }));
    const context = await fixture({ fetchImpl });
    const first = await context.discovery.scan({ prepareApplications: false }, identity);
    const second = await context.discovery.scan({ prepareApplications: false }, identity);
    return { calls, first, second, usage: await context.discovery.sourceQuota.usage("jobspipe", limits) };
  };

  const exhausted = await outcome(402);
  assert.equal(exhausted.first.errors[0].code, "quota_exhausted");
  assert.equal(exhausted.calls.length, 1, "the source waits for the next month after a 402");
  assert.equal(exhausted.usage.cooldown.reason, "quota_exhausted");
  assert.equal(exhausted.usage.cooldown.until, exhausted.usage.windows.credits_month.resetAt);
  assert.equal(exhausted.second.errors[0].code, "quota_exhausted");

  const invalid = await outcome(400);
  assert.equal(invalid.first.errors[0].code, "invalid_request");
  assert.equal(invalid.usage.windows.credits_month.used, 2, "each 400 costs one credit");

  const timeout = await outcome(504);
  assert.equal(timeout.first.errors[0].code, "provider_timeout");
  assert.equal(timeout.first.errors[0].retryable, true);
  assert.equal(timeout.calls.length, 2, "a timeout does not pause the source");
  assert.equal(timeout.usage.windows.credits_month.used, 0, "timeouts are refunded");

  const limited = await outcome(429);
  assert.equal(limited.first.errors[0].code, "rate_limited");
  assert.equal(limited.calls.length, 1);
  assert.equal(limited.second.errors[0].code, "rate_limited");
  assert.equal(limited.usage.windows.credits_month.used, 0);
});

test("JobsPipe requests keep to the per-second rate", async () => {
  const { calls, fetchImpl } = provider((call, count) => page(Array.from({ length: 25 },
    (_, index) => row(`jp-rate-${count}-${index}`)), { next_cursor: `cursor-${count + 1}` }));
  const { discovery } = await fixture({ fetchImpl, options: { perSecond: 1, maxPages: 3 } });
  await discovery.scan({ prepareApplications: false, limitPerSource: 75 }, identity);
  assert.equal(calls.length, 3);
  const seconds = calls.map((call) => Math.floor(call.at / 1000));
  assert.equal(new Set(seconds).size, 3, "each request waits for its own one-second window");
});

test("unlisted JobsPipe filters and credentials in config are rejected before any request", async () => {
  const { calls, fetchImpl } = provider(() => page([]));
  const { discovery } = await fixture({ fetchImpl });
  const source = (await discovery.describeSources(identity)).sources[0];
  assert.equal(source.kind, "keyed_api");
  assert.equal(source.maxResultsPerPage, 25);
  assert.ok(!Object.hasOwn(source.filters, "has_recruiter_email"));
  assert.ok(!Object.hasOwn(source.filters, "status"));
  for (const filters of [{ has_recruiter_email: "true" }, { max_applicant_count: "5" }, { status: "any" },
    { remote: "yes" }, { max_ghost_score: "101x" }, { job_seniority_or: ["principal"] }, { limit: "100" }]) {
    await assert.rejects(discovery.query({ source: "jobspipe", scanCycleId: "cycle", idempotencyKey:
      `jobspipe-${Object.keys(filters)[0]}`, queries: [{ filters }] }, identity), { status: 400, message: /unsupported filter/ });
  }
  const planned = await discovery.scan({ prepareApplications: false,
    queryPlan: [{ filters: { has_recruiter_email: true }, limit: 5 }] }, identity);
  assert.match(planned.errors[0].error, /unsupported filter: has_recruiter_email/);
  assert.equal(calls.length, 0);

  const directory = await mkdtemp(path.join(os.tmpdir(), "job-jobspipe-config-"));
  const file = path.join(directory, "config.json");
  for (const [options, pattern] of [
    [{ apiKey: "x" }, /credentials belong in the server environment/],
    [{ quota: { second: 1 } }, /quota is not supported/],
    [{ plan: "unlimited" }, /plan must be one of/],
    [{ monthlyCredits: 1001 }, /monthlyCredits must be an integer from 0 to 1000/],
    [{ perSecond: 3 }, /perSecond must be an integer from 1 to 2/],
    [{ maxPages: 11 }, /maxPages/],
    [{ excludeSources: ["LinkedIn"] }, /excludeSources/],
    [{ defaultCountries: ["gbr"] }, /defaultCountries/]
  ]) {
    await writeFile(file, JSON.stringify({ discovery: { sourceOptions: { jobspipe: options } } }));
    await assert.rejects(loadConfig({ JOB_SERVER_CONFIG: file }), pattern);
  }
  await writeFile(file, JSON.stringify({ discovery: { sourceOptions: { jobspipe: { plan: "builder",
    monthlyCredits: 20000, perSecond: 5, maxPages: 3, excludeSources: ["linkedin", "example-board"],
    defaultCountries: ["GB"] } } } }));
  const loaded = await loadConfig({ JOB_SERVER_CONFIG: file });
  assert.deepEqual(jobspipeQuotaLimits(loaded.discovery.sourceOptions.jobspipe), { second: 5, credits_month: 20000 });
});

test("recruiter emails from JobsPipe never reach the store or the audit log", async () => {
  const { fetchImpl } = provider(() => page([row("jp-3001"), row("jp-3002", { url: GREENHOUSE_URL })]));
  const { discovery, stateFile, applicationService } = await fixture({ fetchImpl });
  await discovery.startCampaign({ target: 2, reserve: 0, sources: ["jobspipe"] }, identity);
  await discovery.scan({}, identity);
  await applicationService.waitForIdle();
  const state = await readFile(stateFile, "utf8");
  assert.match(state, /jp-3001/);
  for (const forbidden of [...RECRUITER_EMAILS, "recruiter_emails", "applicant_count", "funding_total_usd"]) {
    assert.equal(state.includes(forbidden), false, forbidden);
  }
  assert.equal(/@(?!example\.test)[a-z0-9.-]+\.[a-z]{2,}/i.test(state), false);
  assert.equal(state.includes("fictional-freight.example.test\""), true, "the company domain is kept");
  assert.equal(state.includes("talent.partner"), false);
});

test("a JobsPipe result with a Greenhouse URL is verified against the official feed before any application", async () => {
  const greenhouseApi = "https://boards-api.greenhouse.io/v1/boards/fictionalboard/jobs/4000001";
  const serve = (official) => provider((call) => call.url === ENDPOINT
    ? page([row("jp-4001", { url: GREENHOUSE_URL, remote: true, work_arrangement: "remote", location: "Remote" })])
    : official(call));
  const verified = serve((call) => {
    assert.equal(call.url, greenhouseApi);
    return json({ id: 4000001, title: "Senior Platform Engineer", absolute_url: GREENHOUSE_URL,
      content: "Build Node.js services for a logistics platform.", location: { name: "Remote" },
      updated_at: "2026-09-22T08:00:00Z", departments: [{ name: "Engineering" }], offices: [] });
  });
  const { discovery, applicationService } = await fixture({ fetchImpl: verified.fetchImpl });
  const scan = await discovery.scan({}, identity);
  assert.deepEqual(verified.calls.map((call) => call.url), [ENDPOINT, greenhouseApi]);
  const [entry] = scan.items;
  assert.equal(entry.opportunity.source, "greenhouse");
  assert.equal(entry.opportunity.externalId, "fictionalboard:4000001");
  assert.equal(entry.opportunity.applicationDestinationVerified, true);
  assert.equal(entry.opportunity.discoveryVerification.sourceId, "greenhouse");
  assert.equal(entry.opportunity.provenance.discoveredVia, "jobspipe");
  assert.equal(entry.opportunity.provenance.discoveryExternalId, "jp-4001");
  assert.ok(Date.parse(entry.opportunity.validThrough) > Date.now(), "the provider expiry is kept");
  assert.ok(entry.application, "the verified official role can be prepared");
  assert.equal(scan.sourceYield[0].sourceId, "jobspipe");
  await applicationService.waitForIdle();

  const unverified = serve(() => new Response("gone", { status: 404 }));
  const second = await fixture({ fetchImpl: unverified.fetchImpl });
  const pending = await second.discovery.scan({}, identity);
  assert.equal(unverified.calls.length, 2);
  assert.equal(pending.items[0].opportunity.source, "jobspipe");
  assert.equal(pending.items[0].opportunity.applicationDestinationPending, true);
  assert.ok(pending.items[0].opportunity.uncertainties.includes("official_ats_http_404"));
  assert.equal(pending.items[0].application, undefined);
  assert.equal(pending.items[0].applicationBlockedBySource, "employer_application_url_required");
  await second.applicationService.waitForIdle();
  assert.equal(second.applicationService.list("applications", identity.profileId).length, 0);
});

test("an expired JobsPipe posting is not queued and the reason is recorded", async () => {
  const { fetchImpl } = provider(() => page([row("jp-5001", { expires_at: "2026-01-01T00:00:00Z" }),
    row("jp-5002", { status: "closed" }), row("jp-5003")]));
  const { discovery, applicationService, store } = await fixture({ fetchImpl });
  const scan = await discovery.scan({ prepareApplications: false }, identity);
  assert.deepEqual(scan.items.map((entry) => entry.opportunity.externalId), ["jp-5003"]);
  const opportunity = scan.items[0].opportunity;
  await store.mutate((state) => {
    state.opportunities.find((item) => item.id === opportunity.id).validThrough = new Date(Date.now() - 1000).toISOString();
  });
  await assert.rejects(applicationService.requestApplication(opportunity.id, {}, identity),
    { status: 409, code: "posting_expired" });
  assert.equal(applicationService.list("applications", identity.profileId).length, 0);
  const blocked = store.snapshot().audit.find((item) => item.action === "application.blocked");
  assert.equal(blocked.subjectId, opportunity.id);
  assert.equal(blocked.details.reason, "posting_expired");
});

test("production environment split gives the JobsPipe key only to the API", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-jobspipe-env-"));
  const [source, server, worker] = ["env", "server.env", "worker.env"].map((name) => path.join(directory, name));
  await writeFile(source, [`JOBSPIPE_API_KEY=${apiKey}`, "WORKER_TOKEN=shared-secret"].join("\n"));
  await execute(process.execPath, ["scripts/split-production-env.js", source, server, worker]);
  assert.match(await readFile(server, "utf8"), /JOBSPIPE_API_KEY=/);
  assert.doesNotMatch(await readFile(worker, "utf8"), /JOBSPIPE/);
});
