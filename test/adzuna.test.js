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
import { adzuna } from "../src/discovery/sources/adzuna.js";
import { redactSecrets, sourceCredentials } from "../src/discovery/source-credentials.js";
import { QUOTA_WINDOWS, SourceQuota, quotaLimits } from "../src/discovery/source-quota.js";
import { ProfileStore } from "../src/profile-store.js";
import { ApplicationService } from "../src/service.js";
import { SqliteStore } from "../src/sqlite-store.js";
import { JsonStore } from "../src/store.js";

const execute = promisify(execFile);
const identity = { actorId: "applicant-one-agent", profileId: "applicant-one" };
const credentials = Object.freeze({ appId: "test-app-id", appKey: "test-app-key-placeholder" });
const sourceEnv = { ADZUNA_APP_ID: credentials.appId, ADZUNA_APP_KEY: credentials.appKey };
const profile = { preferences: { fullTime: { jobTitles: ["Platform Engineer"] } } };

function row(id, overrides = {}) {
  return {
    id, title: "Platform Engineer", description: "Build Node.js services for a logistics platform…",
    created: "2026-09-20T08:00:00Z", redirect_url: `https://www.adzuna.example.test/land/ad/${id}?se=abc`,
    company: { display_name: "Fictional Freight Ltd" },
    location: { display_name: "Leeds, West Yorkshire", area: ["UK", "Yorkshire", "Leeds"] },
    category: { label: "IT Jobs", tag: "it-jobs" }, contract_type: "permanent", contract_time: "full_time",
    salary_min: 60000, salary_max: 70000, salary_is_predicted: "0", ...overrides
  };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status,
  headers: { "content-type": "application/json" } });

async function fixture({ config: extra = {}, fetchImpl, env = sourceEnv, store: makeStore, sources = ["adzuna"],
  profilePatch = {} } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-adzuna-test-"));
  const profiles = await new ProfileStore(path.join(directory, "profiles.json"), { allowMissing: true }).init();
  await profiles.patch("applicant-one", {
    contact: { firstName: "Applicant", lastName: "Example", email: "applicant@example.test",
      phone: "+10000000000", location: "Leeds, United Kingdom" },
    documents: { resume: "/secure/resume.pdf" },
    skills: ["Node.js"],
    preferences: { locations: ["Leeds"], fullTime: { jobTitles: ["Platform Engineer"],
      automatedDiscoverySources: sources } },
    ...profilePatch
  });
  const config = { defaultMode: "full_time", discovery: { limitPerSource: 10,
    sourceOptions: { adzuna: { countries: ["gb", "de"] }, ...(extra.sourceOptions ?? {}) } },
  modes: { full_time: { minimumScore: 0, dailyApplicationCap: 8, autoApply: true, autoApplyDiscovered: true,
    sources, requireConfirmationFor: [], ...(extra.mode ?? {}) } } };
  const stateFile = path.join(directory, "state.json");
  const store = makeStore ? await makeStore(directory) : await new JsonStore(stateFile).init();
  const applicationService = new ApplicationService({ store, config, adapter: new SimulationAdapter() });
  const discovery = new DiscoveryService({ applicationService, profiles, config, fetchImpl, sourceEnv: env });
  return { directory, stateFile, store, applicationService, discovery, config, profiles };
}

test("Adzuna search builds a bounded provider query and normalizes evidence", async () => {
  const urls = [];
  const items = await adzuna.search({ limit: 120, profile, credentials,
    sourceConfig: { countries: ["gb", "de"] },
    fetchImpl: async (url) => {
      urls.push(new URL(url));
      return json({ count: 3, results: [
        row(1001),
        row(1002, { salary_is_predicted: "1", contract_type: "contract", contract_time: "full_time",
          redirect_url: "https://www.adzuna.example.test/land/ad/1002?app_id=test-app-id" }),
        row(1003, { redirect_url: "http://www.adzuna.example.test/land/ad/1003" })
      ] });
    } });
  assert.equal(urls.length, 2, "a short page ends the term in that country and moves to the next");
  assert.equal(urls[0].origin + urls[0].pathname, "https://api.adzuna.com/v1/api/jobs/gb/search/1");
  assert.equal(urls[1].pathname, "/v1/api/jobs/de/search/1");
  assert.equal(urls[0].searchParams.get("results_per_page"), "50");
  assert.equal(urls[0].searchParams.get("what"), "Platform Engineer");
  assert.equal(urls[0].searchParams.get("max_days_old"), "7");
  assert.equal(urls[0].searchParams.get("sort_by"), "date");
  assert.equal(urls[0].searchParams.get("app_id"), credentials.appId);

  assert.deepEqual(items.map((item) => item.externalId), ["gb:1001", "gb:1002", "de:1001", "de:1002"]);
  const [stated, predicted] = items;
  assert.equal(stated.source, "adzuna");
  assert.equal(stated.company, "Fictional Freight Ltd");
  assert.equal(stated.location, "Leeds, West Yorkshire");
  assert.equal(stated.listingUrl, "https://www.adzuna.example.test/land/ad/1001?se=abc");
  assert.equal(stated.applyUrl, stated.listingUrl);
  assert.equal(stated.applicationDestinationPending, true);
  assert.equal(stated.contractType, "permanent");
  assert.equal(stated.contractTime, "full_time");
  assert.equal(stated.employmentType, "full_time");
  assert.equal(stated.category, "IT Jobs");
  assert.equal(stated.searchCountry, "gb");
  assert.equal(stated.postedAt, "2026-09-20T08:00:00.000Z");
  assert.deepEqual(stated.compensation, { minimum: 60000, maximum: 70000, currency: "GBP", period: "year" });
  assert.deepEqual(stated.uncertainties, ["description_snippet_only", "employer_application_url_unverified"]);
  assert.equal(predicted.compensation, undefined);
  assert.equal(predicted.compensationEstimate.predicted, true);
  assert.equal(predicted.employmentType, "contract");
  assert.ok(predicted.uncertainties.includes("compensation_predicted"));
  assert.doesNotMatch(predicted.applyUrl, /app_id/);
  assert.equal(items[2].compensation.currency, "EUR");
});

test("a standing `what` narrows the profile's titles, and `what_or` never becomes the search term", async () => {
  const multi = { preferences: { fullTime: { jobTitles: ["Program Manager", "Project Manager"] } } };
  const search = async (sourceConfig, query) => {
    const urls = [];
    await adzuna.search({ limit: 2, profile: multi, credentials, sourceConfig, query,
      fetchImpl: async (url) => { urls.push(new URL(url)); return json({ count: 0, results: [] }); } });
    return urls;
  };

  const plain = await search({ countries: ["de"] });
  assert.deepEqual(plain.map((u) => u.searchParams.get("what")), ["Program Manager", "Project Manager"]);

  const narrowed = await search({ countries: ["de"], defaults: { what: "remote" } });
  assert.deepEqual(narrowed.map((u) => u.searchParams.get("what")),
    ["Program Manager remote", "Project Manager remote"],
    "a standing default narrows each title instead of replacing the set");

  // `what_or` is sent as its own provider parameter, so it must not decide the terms.
  const alongside = await search({ countries: ["de"], defaults: { what_or: "remote hybrid" } });
  assert.deepEqual(alongside.map((u) => u.searchParams.get("what")), ["Program Manager", "Project Manager"],
    "titles survive a what_or-only default");
  assert.ok(alongside.every((u) => u.searchParams.get("what_or") === "remote hybrid"));
  assert.ok(alongside.every((u) => u.searchParams.get("what") !== "undefined"));

  const explicit = await search({ countries: ["de"] }, { what: "Delivery Manager" });
  assert.deepEqual(explicit.map((u) => u.searchParams.get("what")), ["Delivery Manager"],
    "an explicit query asks for those keywords and replaces the titles");

  const titleless = await search({ countries: ["de"], defaults: { what: "remote" } });
  assert.ok(titleless.length > 0);
});

test("Adzuna stops the country fan-out once the limit is met and skips searches without terms", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return json({ results: [row(1), row(2), row(3)] }); };
  const items = await adzuna.search({ limit: 3, profile, credentials, fetchImpl,
    sourceConfig: { countries: ["gb", "de"] } });
  assert.equal(items.length, 3);
  assert.equal(calls, 1, "quota is spent on the first configured country first");
  assert.deepEqual(await adzuna.search({ limit: 10, profile: { preferences: {} }, credentials, fetchImpl,
    sourceConfig: { countries: ["gb"] } }), []);
  assert.equal(calls, 1);
});

test("missing Adzuna credentials report source_not_configured without a request", async () => {
  assert.equal(sourceCredentials("adzuna", { ADZUNA_APP_ID: "test-app-id", ADZUNA_APP_KEY: " " }), null);
  assert.equal(sourceCredentials("remoteok", sourceEnv), null);
  for (const env of [{}, { ADZUNA_APP_ID: "test-app-id", ADZUNA_APP_KEY: "" }]) {
    const hosts = [];
    const { discovery } = await fixture({ env, sources: ["adzuna", "remoteok"], fetchImpl: async (url) => {
      hosts.push(new URL(url).hostname);
      return json([{ legal: "metadata" }, { id: "7", position: "Platform Engineer", company: "Example Works",
        description: "Node.js", location: "Worldwide", date: new Date().toISOString(),
        url: "https://remoteok.com/jobs/7", apply_url: "https://careers.example.test/apply/7" }]);
    } });
    const result = await discovery.scan({ prepareApplications: false }, identity);
    assert.deepEqual(hosts, ["remoteok.com"]);
    assert.equal(result.found, 1, "other selected sources complete normally");
    const error = result.errors.find((item) => item.source === "adzuna");
    assert.equal(error.code, "source_not_configured");
    assert.match(error.error, /ADZUNA_APP_ID and ADZUNA_APP_KEY/);
    const descriptor = await discovery.describeSources(identity);
    assert.equal(descriptor.sources.find((item) => item.id === "adzuna").configured, false);
  }
});

test("Adzuna credentials never appear in scan output, errors, or durable state", async () => {
  assert.equal(redactSecrets("GET /search?app_id=test-app-id&app_key=test-app-key-placeholder", credentials),
    "GET /search?app_id=[redacted]&app_key=[redacted]");
  assert.equal(redactSecrets("echo app_key=unknown-value&x=1"), "echo app_key=[redacted]&x=1");
  for (const failure of [
    async (url) => { throw new Error(`connect ECONNREFUSED while requesting ${url}`); },
    async (url) => new Response(`bad request for ${url}`, { status: 500 })
  ]) {
    const { discovery, stateFile } = await fixture({ fetchImpl: failure });
    const result = await discovery.query({ source: "adzuna", scanCycleId: "cycle-one",
      idempotencyKey: "query-redaction", queries: [{ filters: { what: "Platform Engineer" }, limit: 10 }] },
    identity);
    const campaign = await discovery.startCampaign({ target: 1, reserve: 0, sources: ["adzuna"],
      reserveOnly: true }, identity).catch((error) => ({ failed: error.message }));
    const descriptor = await discovery.describeSources(identity);
    const serialized = [JSON.stringify(result), JSON.stringify(campaign), JSON.stringify(descriptor),
      await readFile(stateFile, "utf8")].join("\n");
    for (const secret of Object.values(credentials)) assert.equal(serialized.includes(secret), false);
    assert.equal(result.errors[0].source, "adzuna");
    assert.match(result.errors[0].error, /ECONNREFUSED|HTTP 500/);
    assert.match(await readFile(stateFile, "utf8"), /campaign\.scan_completed/);
  }
  const { discovery } = await fixture({ fetchImpl: async (url) => {
    throw new Error(`upstream echoed ${url}`);
  } });
  const result = await discovery.scan({ prepareApplications: false }, identity);
  assert.match(result.errors[0].error, /app_id=\[redacted\]&app_key=\[redacted\]/);
});

test("the Adzuna ledger is atomic and survives a restart mid-day", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-adzuna-quota-"));
  const file = path.join(directory, "state.sqlite");
  const start = Date.parse("2026-09-24T09:00:00Z");
  let now = start;
  const limits = quotaLimits("adzuna");
  assert.deepEqual(limits, { minute: 25, day: 250, week: 1000, month: 2500 });
  assert.deepEqual(quotaLimits("adzuna", { day: 200, month: 9000 }), { minute: 25, day: 200, week: 1000, month: 2500 });

  const first = await new SqliteStore(file).init();
  const quota = new SourceQuota(first, { now: () => now });
  const burst = await Promise.all(Array.from({ length: 30 }, () => quota.reserve("adzuna", limits)));
  assert.equal(burst.filter((item) => item.reserved).length, 25);
  assert.equal(burst.find((item) => !item.reserved).window, "minute");
  for (let used = 25; used < 200; used += 1) {
    now = start + Math.floor(used / 20) * 60_000;
    assert.equal((await quota.reserve("adzuna", limits)).reserved, true);
  }
  first.close();

  const reopened = await new SqliteStore(file).init();
  const restarted = new SourceQuota(reopened, { now: () => now });
  assert.equal((await restarted.usage("adzuna", limits)).windows.day.used, 200);
  let permitted = 0;
  now = start + 20 * 60_000;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    now += 3_000;
    if ((await restarted.reserve("adzuna", limits)).reserved) permitted += 1;
  }
  assert.equal(permitted, 50);
  const refused = await restarted.reserve("adzuna", limits);
  assert.equal(refused.code, "quota_exhausted");
  assert.equal(refused.window, "day");
  assert.equal(refused.resetAt, "2026-09-25T00:00:00.000Z");
  reopened.close();

  assert.deepEqual(QUOTA_WINDOWS.week(Date.parse("2026-09-24T09:00:00Z")),
    { start: "2026-09-21T00:00:00.000Z", resetAt: "2026-09-28T00:00:00.000Z" });
  assert.deepEqual(QUOTA_WINDOWS.month(Date.parse("2026-12-31T23:59:59Z")),
    { start: "2026-12-01T00:00:00.000Z", resetAt: "2027-01-01T00:00:00.000Z" });
});

test("an exhausted Adzuna allowance stops scans before any request, including after a JSON-store restart", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return json({ results: [row(calls)] }); };
  const extra = { sourceOptions: { adzuna: { countries: ["gb"], quota: { day: 1 } } } };
  const { discovery, stateFile, config, profiles } = await fixture({ fetchImpl, config: extra });
  const first = await discovery.scan({ prepareApplications: false }, identity);
  assert.equal(first.found, 1);
  assert.equal(calls, 1);
  const store = await new JsonStore(stateFile).init();
  const applicationService = new ApplicationService({ store, config, adapter: new SimulationAdapter() });
  const restarted = new DiscoveryService({ applicationService, profiles, config, fetchImpl, sourceEnv });
  const second = await restarted.scan({ prepareApplications: false }, identity);
  assert.equal(calls, 1, "no request is sent once the day window is used up");
  assert.equal(second.requestsMade, 0);
  const error = second.errors.find((item) => item.source === "adzuna");
  assert.equal(error.code, "quota_exhausted");
  assert.equal(error.window, "day");
  assert.match(error.resetAt, /T00:00:00\.000Z$/);
  const descriptor = await restarted.describeSources(identity);
  assert.equal(descriptor.sources[0].quota.windows.day.remaining, 0);
});

test("an Adzuna HTTP 429 puts the source into the rate-limited cooldown", async () => {
  let calls = 0;
  const { discovery } = await fixture({ fetchImpl: async () => {
    calls += 1;
    return new Response("slow down", { status: 429 });
  } });
  const first = await discovery.scan({ prepareApplications: false }, identity);
  assert.equal(first.errors[0].code, "rate_limited");
  assert.equal(calls, 1);
  const second = await discovery.scan({ prepareApplications: false }, identity);
  assert.equal(calls, 1);
  assert.equal(second.errors[0].code, "rate_limited");
  assert.ok(Date.parse(second.errors[0].resetAt) - Date.now() > 5 * 60 * 60_000);
  const descriptor = await discovery.describeSources(identity);
  assert.equal(descriptor.sources[0].quota.cooldown.reason, "rate_limited");
});

test("predicted Adzuna pay is an estimate and never meets or fails a compensation floor", async () => {
  const [predicted] = await adzuna.search({ limit: 1, profile, credentials, sourceConfig: { countries: ["gb"] },
    fetchImpl: async () => json({ results: [row(2001, { salary_min: 60000, salary_max: 60000,
      salary_is_predicted: "1", description: "Build services for a logistics platform…" })] }) });
  const opportunity = normalizeOpportunity(predicted);
  assert.ok(opportunity.uncertainties.includes("compensation_unknown"));
  assert.match(opportunity.provenance.compensationEstimate.excerpt, /60000/);
  assert.equal(opportunity.provenance.compensation, undefined);
  const applicant = { skills: ["Node.js", "Kubernetes"], preferences: { locations: ["Leeds"],
    fullTime: { jobTitles: ["Platform Engineer"], minimumCompensation: 100000, compensationCurrency: "GBP" } } };
  const scored = scoreOpportunity(opportunity, applicant, "full_time");
  assert.equal(scored.scoreDetails.hardExclusion, undefined);
  assert.equal(scored.scoreDetails.compensationComparable, false);
  assert.ok(scored.scoreDetails.uncertainties.includes("description_snippet_only"));
  const stated = scoreOpportunity(normalizeOpportunity({ ...predicted, compensation: predicted.compensationEstimate,
    compensationEstimate: undefined }), applicant, "full_time");
  assert.match(stated.scoreDetails.hardExclusion, /below the configured minimum/,
    "the same numbers stated by the employer would fail the floor");
});

test("a pending Adzuna destination blocks application creation", async () => {
  const fetchImpl = async (url) => json({ results: new URL(url).pathname.includes("/gb/") ? [row(3001)] : [] });
  const { discovery, applicationService } = await fixture({ fetchImpl });
  const scan = await discovery.scan({}, identity);
  assert.equal(scan.qualifying, 1);
  assert.equal(scan.items[0].application, undefined);
  assert.equal(scan.items[0].applicationBlockedBySource, "employer_application_url_required");
  assert.equal(scan.items[0].opportunity.applicationDestinationPending, true);
  assert.equal(scan.sourceYield[0].destinationPending, 1);
  await applicationService.waitForIdle();
  assert.equal(applicationService.list("applications", identity.profileId).length, 0);

  const campaignFixture = await fixture({ fetchImpl });
  await campaignFixture.discovery.startCampaign({ target: 1, reserve: 0, sources: ["adzuna"] }, identity);
  const scanned = campaignFixture.store.snapshot().audit.find((item) => item.action === "campaign.scan_completed");
  assert.equal(scanned.details.destinationPending, 1);
  assert.deepEqual(scanned.details.applicationIds, []);
  await campaignFixture.applicationService.waitForIdle();
  assert.equal(campaignFixture.applicationService.list("applications", identity.profileId).length, 0);
});

test("unconfigured Adzuna countries, credentials, and unlisted filters are rejected", async () => {
  let calls = 0;
  const { discovery } = await fixture({ fetchImpl: async () => { calls += 1; return json({ results: [] }); } });
  const descriptor = await discovery.describeSources(identity);
  const source = descriptor.sources[0];
  assert.equal(source.kind, "keyed_api");
  assert.deepEqual(source.filterOptions.country, ["gb", "de"]);
  assert.equal(source.applicationFlow, "resolve_employer_url_before_prepare");
  assert.equal(source.configured, true);
  for (const filters of [{ country: "us" }, { app_id: "x" }, { app_key: "x" }, { what_and: "a" },
    { sort_by: "newest" }, { max_days_old: "seven" }]) {
    await assert.rejects(discovery.query({ source: "adzuna", scanCycleId: "cycle", idempotencyKey: `query-${
      Object.keys(filters)[0]}-${Object.values(filters)[0]}`, queries: [{ filters }] }, identity),
    { status: 400, message: /unsupported filter/ });
  }
  await assert.rejects(adzuna.search({ query: { country: "us" }, profile, credentials,
    sourceConfig: { countries: ["gb"] }, fetchImpl: async () => { calls += 1; } }), /unsupported filter: country/);
  const campaignScan = await discovery.scan({ prepareApplications: false,
    queryPlan: [{ filters: { country: "us" }, limit: 5 }] }, identity);
  assert.match(campaignScan.errors[0].error, /unsupported filter: country/);
  assert.equal(calls, 0);

  const directory = await mkdtemp(path.join(os.tmpdir(), "job-adzuna-config-"));
  const file = path.join(directory, "config.json");
  for (const [adzunaOptions, pattern] of [
    [{ countries: ["xx"] }, /countries must list unique supported/],
    [{ countries: ["gb"], app_key: "x" }, /credentials belong in the server environment/],
    [{ countries: ["gb"], quota: { day: 251 } }, /quota\.day must be an integer from 0 to 250/],
    [{ countries: ["gb"], quota: { hour: 5 } }, /quota\.hour/],
    [{ countries: ["gb"], defaults: { app_id: "x" } }, /unsupported filter: app_id/]
  ]) {
    await writeFile(file, JSON.stringify({ discovery: { sourceOptions: { adzuna: adzunaOptions } } }));
    await assert.rejects(loadConfig({ JOB_SERVER_CONFIG: file }), pattern);
  }
  await writeFile(file, JSON.stringify({ discovery: { sourceOptions: { adzuna: { countries: ["gb", "de"],
    defaults: { max_days_old: "3" }, quota: { day: 200 } } } } }));
  assert.deepEqual((await loadConfig({ JOB_SERVER_CONFIG: file })).discovery.sourceOptions.adzuna.countries, ["gb", "de"]);
});

test("production environment split gives keyed-source credentials only to the API", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-adzuna-env-"));
  const [source, server, worker] = ["env", "server.env", "worker.env"].map((name) => path.join(directory, name));
  await writeFile(source, ["ADZUNA_APP_ID=test-app-id", "ADZUNA_APP_KEY=test-app-key-placeholder",
    "WORKER_TOKEN=shared-secret"].join("\n"));
  await execute(process.execPath, ["scripts/split-production-env.js", source, server, worker]);
  assert.match(await readFile(server, "utf8"), /ADZUNA_APP_ID=test-app-id\nADZUNA_APP_KEY=/);
  assert.doesNotMatch(await readFile(worker, "utf8"), /ADZUNA/);
});
