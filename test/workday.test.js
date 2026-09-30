import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SimulationAdapter } from "../src/adapters/simulation.js";
import { DiscoveryService } from "../src/discovery/service.js";
import { normalizeOpportunity } from "../src/discovery/normalization.js";
import { workday, workdayRemote, WORKDAY_LIMITS } from "../src/discovery/sources/workday.js";
import { workdayPostingKey, workdaySite } from "../src/discovery/workday-identity.js";
import { isHandledRole, knownRoleIndex, roleKeys } from "../src/discovery/handled-roles.js";
import { sourceConfigWithLearnedBoards } from "../src/discovery/learned-boards.js";
import { automaticSubmissionUnsupported, employerAtsDestination, officialAtsDestination,
  revalidateWorkdayRole } from "../src/discovery/official-ats.js";
import { summarizeSourceHealth } from "../src/discovery/source-health.js";
import { ProfileStore } from "../src/profile-store.js";
import { ApplicationService } from "../src/service.js";
import { JsonStore } from "../src/store.js";

// Shapes follow the careers-site search and posting-detail responses, with
// every tenant, site, company and requisition replaced by a neutral value.
const identity = { actorId: "applicant-one-agent", profileId: "applicant-one" };
const owner = { actorId: "owner", profileId: "applicant-one", roles: ["owner"] };
const profile = { preferences: { fullTime: { jobTitles: ["Software Engineer"] } } };
const HOST = "https://example.wd5.myworkdayjobs.com";
const SEARCH = `${HOST}/wday/cxs/example/ExampleCareers/jobs`;
const SITE = { url: `${HOST}/en-US/ExampleCareers`, company: "Example Co" };
const REMOTE_PATH = "/job/US-Remote/Software-Engineer--Platform_JR2020825";
const listingUrl = `${HOST}/ExampleCareers${REMOTE_PATH}`;
const applyUrl = `${listingUrl}/apply`;

const row = (title, externalPath, locationsText, extra = {}) => ({ title, externalPath, locationsText,
  postedOn: "Posted 2 Days Ago", bulletFields: [workdayPostingKey(externalPath)], ...extra });
const ROWS = {
  remote: row("Software Engineer, Platform", REMOTE_PATH, "US, Remote"),
  office: row("Software Engineer, SPE", "/job/Israel-Yokneam/Software-Engineer--SPE_JR2015623", "Israel, Yokneam",
    { postedOn: "Posted 30+ Days Ago" }),
  several: row("Senior Software Engineer", "/job/US-Remote/Senior-Software-Engineer_JR-0109305", "2 Locations",
    { postedOn: "Posted Today" }),
  flex: row("Software Engineer, Remote", "/job/Remote/Software-Engineer--Remote_R12345", "Remote - Germany",
    { remoteType: "Flex" }),
  germany: row("Software Engineer II", "/job/Germany/Software-Engineer-II_R0012345-1", "Remote - Germany"),
  manager: row("Product Manager", "/job/US-Remote/Product-Manager_JR2020900", "US, Remote")
};
const detail = (item, info = {}) => ({
  hiringOrganization: { name: "XX00 Example Holdings, Ltd.", url: "" },
  jobPostingInfo: { id: "0000example", title: item.title, jobDescription: "<p>TypeScript Node.js platform work.</p>",
    location: item.locationsText, additionalLocations: null, remoteType: null, postedOn: item.postedOn,
    startDate: "2026-09-20", timeType: "Full time", jobReqId: workdayPostingKey(item.externalPath),
    jobPostingId: item.externalPath.split("/").at(-1), jobPostingSiteId: "ExampleCareers",
    country: { descriptor: "United States", id: "0000country" }, canApply: true, posted: true,
    externalUrl: `${HOST}/ExampleCareers${item.externalPath}`, ...info },
  similarJobs: [], userAuthenticated: false
});
const json = (body, status = 200) => new Response(JSON.stringify(body), { status,
  headers: { "content-type": "application/json" } });

// Serves one search result list for every term and a detail for each posting.
function workdayFetch({ rows = Object.values(ROWS), details = {}, total, search, requests = [] } = {}) {
  return async (url, options = {}) => {
    const text = String(url);
    const method = options.method ?? "GET";
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ url: text, method, body });
    if (method === "POST") {
      if (search) return search(text, body);
      const page = rows.slice(body.offset, body.offset + body.limit);
      return json({ total: body.offset === 0 ? total ?? rows.length : 0, jobPostings: page, facets: [] });
    }
    const item = [...rows, ...Object.values(ROWS)].find((candidate) => text.endsWith(candidate.externalPath));
    if (!item) return json({ errorCode: "S21", httpStatus: 404, message: "not found: Job_Posting_Anchor_ID=x" }, 404);
    return json(details[item.externalPath] ?? detail(item));
  };
}

async function search(options = {}) {
  const errors = [];
  const stats = [];
  const requests = options.requests ?? [];
  const rows = await workday.search({ profile, sourceConfig: { sites: [SITE] },
    onError: (error) => errors.push(error), onStats: (value) => stats.push(value),
    ...options, fetchImpl: options.fetchImpl ?? workdayFetch({ ...options.server, requests }) });
  return { rows, errors, stats: stats[0], requests };
}

test("Workday careers-site URLs parse to a tenant, instance and site", () => {
  assert.deepEqual(workdaySite(`${HOST}/en-US/ExampleCareers`), { tenant: "example", instance: "wd5",
    site: "ExampleCareers", key: "example/ExampleCareers", origin: HOST });
  assert.equal(workdaySite("https://Example.wd12.myworkdayjobs.com/ExampleCareers/")?.key, "example/ExampleCareers");
  assert.equal(workdaySite("https://example.wd1.myworkdayjobs.com/fr-FR/University")?.instance, "wd1");
  for (const url of ["https://careers.example.com/ExampleCareers",
    "https://example.myworkdaysite.com/recruiting/example/ExampleCareers",
    "http://example.wd5.myworkdayjobs.com/ExampleCareers",
    `${HOST}/ExampleCareers${REMOTE_PATH}`, `${HOST}/ExampleCareers/login`, `${HOST}/ExampleCareers?q=1`,
    `${HOST}/`, "https://example.wd1234.myworkdayjobs.com/ExampleCareers", "not a url", undefined]) {
    assert.equal(workdaySite(url), null, String(url));
  }
});

test("Workday reads nothing without valid sites or search terms", async () => {
  let fetches = 0;
  const fetchImpl = async () => { fetches += 1; return json({ total: 0, jobPostings: [] }); };
  assert.deepEqual((await search({ sourceConfig: {}, fetchImpl })).rows, []);
  assert.deepEqual((await search({ sourceConfig: { sites: [] }, fetchImpl })).rows, []);
  assert.deepEqual((await search({ sourceConfig: { sites: [{ url: "https://careers.example.com/Jobs" },
    { url: "http://example.wd5.myworkdayjobs.com/ExampleCareers" }, { url: `${HOST}/ExampleCareers${REMOTE_PATH}` }] },
  fetchImpl })).rows, []);
  assert.deepEqual((await search({ profile: { preferences: { fullTime: {} } }, fetchImpl })).rows, []);
  assert.deepEqual((await search({ query: { board: "example/OtherSite" }, fetchImpl })).rows, []);
  assert.equal(fetches, 0);
});

test("Workday honours a board query and rotates sites by cycle", async () => {
  const sites = [SITE, { url: "https://other.wd1.myworkdayjobs.com/OtherCareers", company: "Other Co" }];
  const onlyOther = await search({ sourceConfig: { sites }, query: { board: "Other/OtherCareers" },
    server: { rows: [] } });
  assert.deepEqual([...new Set(onlyOther.requests.map((item) => new URL(item.url).host))],
    ["other.wd1.myworkdayjobs.com"]);
  const rotated = await search({ sourceConfig: { sites }, searchCycle: 1, server: { rows: [] } });
  assert.equal(new URL(rotated.requests[0].url).host, "other.wd1.myworkdayjobs.com");
});

test("Workday searches the shared title plan with fixed pages of 20", async () => {
  const { requests } = await search({ server: { rows: [ROWS.office] } });
  assert.ok(requests.every((item) => item.method === "POST" && item.url === SEARCH));
  assert.deepEqual(requests.map((item) => item.body.searchText), ["Software Engineer", "Software Developer", "software"]);
  assert.ok(requests.every((item) => item.body.limit === 20 && item.body.offset === 0
    && JSON.stringify(item.body.appliedFacets) === "{}" && item.body.searchText));
  const explicit = await search({ query: { title: "Platform Engineer" }, server: { rows: [ROWS.office] } });
  assert.deepEqual(explicit.requests.map((item) => item.body.searchText), ["Platform Engineer"]);
});

test("Workday paging stops on a short page, on the first page total, and at the page limit", async () => {
  const offices = Array.from({ length: 80 }, (_, index) => row(`Software Engineer ${index}`,
    `/job/Israel-Yokneam/Software-Engineer_JR${3000000 + index}`, "Israel, Yokneam"));
  const offsets = (requests) => requests.map((item) => item.body.offset);
  const byTotal = await search({ query: { title: "Software Engineer" }, server: { rows: offices.slice(0, 40) } });
  assert.deepEqual(offsets(byTotal.requests), [0, 20]);
  assert.equal(byTotal.errors.length, 0);
  const shortPage = await search({ query: { title: "Software Engineer" }, server: { rows: offices.slice(0, 25), total: 1700 } });
  assert.deepEqual(offsets(shortPage.requests), [0, 20]);
  assert.equal(shortPage.errors.length, 0);
  const capped = await search({ query: { title: "Software Engineer" }, server: { rows: offices, total: 1700 } });
  assert.deepEqual(offsets(capped.requests), [0, 20, 40]);
  assert.deepEqual(capped.errors.map((error) => [error.board, error.reason]),
    [["example/ExampleCareers", "partial_response_cap"]]);
  assert.equal(capped.stats.pagesVisited, 3);
  assert.equal(capped.stats.rawRows, 60);
});

test("Workday reads at most 15 details per site, newest first", async () => {
  const remote = Array.from({ length: 18 }, (_, index) => row(`Software Engineer ${index}`,
    `/job/US-Remote/Software-Engineer_JR${4000000 + index}`, "US, Remote",
    { postedOn: index === 17 ? "Posted Today" : "Posted 30+ Days Ago" }));
  const { rows, errors, stats, requests } = await search({ query: { title: "Software Engineer" },
    server: { rows: remote } });
  const details = requests.filter((item) => item.method === "GET");
  assert.equal(details.length, WORKDAY_LIMITS.detailsPerSite);
  assert.ok(details[0].url.endsWith("_JR4000017"));
  assert.equal(rows.length, 15);
  assert.equal(stats.detailReads, 15);
  assert.deepEqual(errors.map((error) => [error.stage, error.reason]), [["detail", "partial_response_cap"]]);
});

test("Workday stops at the per-scan request ceiling", async () => {
  const sites = Array.from({ length: 14 }, (_, index) => ({ url: `https://tenant${index}.wd5.myworkdayjobs.com/Careers` }));
  const offices = Array.from({ length: 20 }, (_, index) => row(`Software Engineer ${index}`,
    `/job/Israel-Yokneam/Software-Engineer_JR${5000000 + index}`, "Israel, Yokneam"));
  const { errors, requests } = await search({ sourceConfig: { sites }, server: {
    search: () => json({ total: 1700, jobPostings: offices, facets: [] }) } });
  assert.equal(requests.length, WORKDAY_LIMITS.requestsPerScan);
  assert.ok(errors.some((error) => error.reason === "partial_response_cap" && error.requestsPerScan === 120));
  assert.ok(errors.every((error) => error.reason === "partial_response_cap" && /^tenant\d+\/Careers$/.test(error.board)));
});

test("Workday isolates site failures in backoff-compatible text", async () => {
  const sites = [SITE, { url: "https://missing.wd5.myworkdayjobs.com/Gone" },
    { url: "https://limited.wd5.myworkdayjobs.com/Careers" }, { url: "https://challenge.wd5.myworkdayjobs.com/Careers" }];
  const inner = workdayFetch({ rows: [ROWS.remote] });
  const { rows, errors } = await search({ sourceConfig: { sites }, fetchImpl: async (url, options) => {
    const host = new URL(url).hostname;
    if (host.startsWith("missing.")) {
      return json({ errorCode: "S21", httpStatus: 404, message: "not found: Job_Posting_Site_ID=Gone" }, 404);
    }
    if (host.startsWith("limited.")) return new Response("", { status: 429 });
    if (host.startsWith("challenge.")) return new Response("<html>Just a moment</html>", { status: 200 });
    return inner(url, options);
  } });
  assert.deepEqual(rows.map((role) => role.externalId), ["example/ExampleCareers:JR2020825"]);
  assert.deepEqual(errors.map((error) => error.board), ["missing/Gone", "limited/Careers", "challenge/Careers"]);
  assert.match(errors[0].error, /^Workday missing\/Gone returned HTTP 404 \(unknown site\)$/);
  // Only 403 and 429 start the board backoff; an unknown site is a per-site error.
  assert.doesNotMatch(errors[0].error, /returned HTTP (403|429)\b/i);
  assert.match(errors[1].error, /returned HTTP (403|429)\b/i);
  assert.match(errors[2].error, /invalid_official_response/);
  const missingList = await search({ fetchImpl: async () => json({ total: 0 }) });
  assert.match(missingList.errors[0].error, /invalid_official_response/);
});

test("Workday normalizes a remote posting from explicit detail fields", async () => {
  const { rows, stats, requests } = await search({ server: { rows: [ROWS.remote, ROWS.office, ROWS.flex, ROWS.manager] } });
  assert.equal(rows.length, 1);
  const [role] = rows;
  assert.equal(role.source, "workday");
  assert.equal(role.externalId, "example/ExampleCareers:JR2020825");
  assert.equal(role.company, "Example Co");
  assert.equal(role.listingUrl, listingUrl);
  assert.equal(role.applyUrl, applyUrl);
  assert.equal(role.remote, true);
  assert.equal(role.location, "US, Remote");
  assert.equal(role.employmentType, "full_time");
  assert.equal(role.postedAt, "2026-09-20");
  assert.match(role.description, /TypeScript Node\.js/);
  assert.equal(role.compensation, undefined);
  assert.ok(normalizeOpportunity(role).uncertainties.includes("compensation_unknown"));
  // The office row, the Flex row and the non-matching title are never read in detail.
  assert.deepEqual(requests.filter((item) => item.method === "GET").map((item) => item.url),
    [`${HOST}/wday/cxs/example/ExampleCareers${REMOTE_PATH}`]);
  assert.equal(stats.adapterPrescreenRejected, 3);
  assert.equal(stats.detailReads, 1);
});

test("Workday remote status needs a remote type or Remote in every location", async () => {
  assert.equal(workdayRemote(null, ["US, Remote"]), true);
  assert.equal(workdayRemote(null, ["Remote - Germany"]), true);
  assert.equal(workdayRemote("Fully Remote", ["Berlin, Germany"]), true);
  assert.equal(workdayRemote("Flex", ["US, Remote"]), false);
  assert.equal(workdayRemote("Hybrid", ["Remote - Germany"]), false);
  assert.equal(workdayRemote(null, ["US, Remote", "Israel, Yokneam"]), false);
  assert.equal(workdayRemote(null, ["Remote-friendly office, Berlin"]), false);
  assert.equal(workdayRemote(null, ["Non-Remote, Berlin"]), false);
  assert.equal(workdayRemote(null, []), false);

  const additional = await search({ server: { rows: [ROWS.remote], details: {
    [REMOTE_PATH]: detail(ROWS.remote, { additionalLocations: ["Canada, Remote"] }) } } });
  assert.equal(additional.rows[0].location, "US, Remote; Canada, Remote");
  const mixed = await search({ server: { rows: [ROWS.remote], details: {
    [REMOTE_PATH]: detail(ROWS.remote, { additionalLocations: ["Israel, Yokneam"] }) } } });
  assert.deepEqual(mixed.rows, []);
  const flexDetail = await search({ server: { rows: [ROWS.remote], details: {
    [REMOTE_PATH]: detail(ROWS.remote, { remoteType: "Flex" }) } } });
  assert.deepEqual(flexDetail.rows, []);
  const unknownType = await search({ server: { rows: [{ ...ROWS.remote, remoteType: "Virtual" }] } });
  assert.deepEqual(unknownType.rows, []);
  assert.equal(unknownType.stats.unrecognizedRemoteType, 1);

  const several = await search({ server: { rows: [ROWS.several], details: {
    [ROWS.several.externalPath]: detail(ROWS.several, { location: "US, Remote", additionalLocations: ["Remote - Germany"] }) } } });
  assert.deepEqual(several.rows.map((role) => [role.externalId, role.location]),
    [["example/ExampleCareers:JR-0109305", "US, Remote; Remote - Germany"]]);
  const germany = await search({ server: { rows: [ROWS.germany] } });
  assert.deepEqual(germany.rows.map((role) => role.externalId), ["example/ExampleCareers:R0012345-1"]);
});

test("Workday drops closed postings and keeps pay unknown unless labeled", async () => {
  for (const info of [{ posted: false }, { canApply: false }, { title: " " }]) {
    const { rows, stats } = await search({ server: { rows: [ROWS.remote], details: {
      [REMOTE_PATH]: detail(ROWS.remote, info) } } });
    assert.deepEqual(rows, [], JSON.stringify(info));
    assert.equal(stats.detailReads, 1);
  }
  const unnamed = await search({ sourceConfig: { sites: [{ url: SITE.url }] }, server: { rows: [ROWS.remote] } });
  assert.equal(unnamed.rows[0].company, "example");
  const paid = await search({ server: { rows: [ROWS.remote], details: { [REMOTE_PATH]: detail(ROWS.remote,
    { jobDescription: "<p>Node.js work. Salary: $120k–$150k USD per year.</p>", timeType: "Part time" }) } } });
  assert.deepEqual(paid.rows[0].compensation, { minimum: 120000, maximum: 150000, currency: "USD", period: "year" });
  assert.equal(paid.rows[0].employmentType, "part_time");
});

test("Workday posting keys come from the requisition at the end of the path", async () => {
  assert.equal(workdayPostingKey("/job/Israel-Yokneam/Software-Engineer--SPE_JR2015623"), "JR2015623");
  assert.equal(workdayPostingKey("/job/US-Remote/Engineer_jr-0109305"), "JR-0109305");
  assert.equal(workdayPostingKey("/job/Berlin/Engineer_R12345"), "R12345");
  assert.equal(workdayPostingKey("/job/Berlin/Engineer_R0012345-1"), "R0012345-1");
  assert.equal(workdayPostingKey("Software-Engineer--SPE_JR2015623"), "JR2015623");
  for (const value of ["/job/Berlin/Engineer", "/job/Berlin/Engineer_", "/job/Berlin/Engineer_J", "/job/Berlin/Engineer_JR 1", null]) {
    assert.equal(workdayPostingKey(value), null, String(value));
  }
  const unparsable = await search({ server: { rows: [row("Software Engineer", "/job/US-Remote/Software-Engineer", "US, Remote")] } });
  assert.deepEqual(unparsable.rows, []);
  assert.equal(unparsable.stats.adapterPrescreenRejected, 1);
  assert.equal(unparsable.requests.filter((item) => item.method === "GET").length, 0);
});

test("Workday URL forms share one role key", () => {
  const stored = { source: "workday", externalId: "example/ExampleCareers:JR2020825", applyUrl, listingUrl };
  const key = "workday:example:JR2020825";
  assert.deepEqual([...roleKeys(stored)], [key]);
  for (const url of [listingUrl, applyUrl,
    `${HOST}/en-US/ExampleCareers${REMOTE_PATH}`,
    `${HOST}/en-US/ExampleCareers${REMOTE_PATH}/apply/applyManually`,
    `${listingUrl}?source=Board&utm_campaign=x`,
    `https://EXAMPLE.wd1.myworkdayjobs.com/University/job/US-Remote/Software-Engineer_jr2020825`,
    `${HOST}/en-US/ExampleCareers${REMOTE_PATH}/apply?source=jobspipe`]) {
    assert.deepEqual([...roleKeys({ source: "jobspipe", applyUrl: url })], [key], url);
    assert.equal(isHandledRole({ source: "browser", applyUrl: url }, new Set([key])), true);
  }
  assert.notDeepEqual([...roleKeys({ applyUrl: `${HOST}/ExampleCareers` })], [key]);
  assert.notDeepEqual([...roleKeys({ applyUrl: "https://other.wd5.myworkdayjobs.com/ExampleCareers" + REMOTE_PATH })], [key]);
});

test("Workday destinations are known but never official for automatic submission", () => {
  const role = { source: "workday", externalId: "example/ExampleCareers:JR2020825", applyUrl, listingUrl };
  assert.equal(officialAtsDestination(role), false);
  assert.equal(employerAtsDestination(role), true);
  assert.equal(automaticSubmissionUnsupported(role), true);
  for (const changed of [{ source: "jobspipe" }, { applyUrl: listingUrl },
    { applyUrl: `${HOST}/en-US/ExampleCareers${REMOTE_PATH}/apply` }, { applyUrl: `${applyUrl}?source=x` },
    { applyUrl: `${HOST}/OtherSite${REMOTE_PATH}/apply` }, { applyUrl: applyUrl.replace("https:", "http:") },
    { applyUrl: applyUrl.replace("example.wd5", "evil.wd5") }, { externalId: "example/ExampleCareers:JR2020826" }]) {
    assert.equal(employerAtsDestination({ ...role, ...changed }), false, JSON.stringify(changed));
  }
});

test("Workday revalidation admits only an open posting with the same key and title", async () => {
  const role = { source: "workday", externalId: "example/ExampleCareers:JR2020825", applyUrl, listingUrl,
    title: "Software Engineer, Platform" };
  const live = detail(ROWS.remote);
  const urls = [];
  assert.equal(await revalidateWorkdayRole(role, async (url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    urls.push([String(url), options.method ?? "GET"]); return json(live); }), "open");
  assert.deepEqual(urls, [[`${HOST}/wday/cxs/example/ExampleCareers${REMOTE_PATH}`, "GET"]]);
  const closed = [
    async () => json({ errorCode: "S21", httpStatus: 404 }, 404),
    async () => new Response("", { status: 410 }),
    async () => json(detail(ROWS.remote, { canApply: false })),
    async () => json(detail(ROWS.remote, { posted: false })),
    async () => json(detail(ROWS.remote, { title: "Renamed role" })),
    async () => json(detail(ROWS.remote, { jobPostingId: "Other_JR2020826", externalUrl: `${HOST}/ExampleCareers/job/X/Other_JR2020826` })),
    async () => json(detail(ROWS.remote, { jobPostingId: null, externalUrl: null }))
  ];
  for (const fetchImpl of closed) assert.equal(await revalidateWorkdayRole(role, fetchImpl), "closed_or_changed");
  for (const fetchImpl of [async () => { throw new Error("The operation was aborted due to timeout"); },
    async () => new Response("<html>", { status: 200 }), async () => new Response("", { status: 503 }),
    async () => json({ similarJobs: [] })]) {
    assert.equal(await revalidateWorkdayRole(role, fetchImpl), "unavailable");
  }
  // A role whose stored URLs are not canonical is never re-read from a payload URL.
  let fetched = false;
  assert.equal(await revalidateWorkdayRole({ ...role, listingUrl: `${HOST}/en-US/ExampleCareers${REMOTE_PATH}` },
    async () => { fetched = true; return json(live); }), "closed_or_changed");
  assert.equal(fetched, false);
});

test("Workday site keys drive configured boards and backoff filtering", () => {
  const configured = { sites: [SITE, { url: "https://other.wd1.myworkdayjobs.com/OtherCareers" }] };
  const result = sourceConfigWithLearnedBoards({ opportunities: [] }, "applicant-one", "workday", configured,
    { isBackedOff: (key) => key === "workday:example/ExampleCareers" });
  assert.deepEqual(result.sites.map((site) => site.url), ["https://other.wd1.myworkdayjobs.com/OtherCareers"]);
});

async function workdayFixture({ autoApplyDiscovered = true, server = {}, liveDetail, fetchImpl } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-workday-test-"));
  const profiles = await new ProfileStore(path.join(directory, "profiles.json"), { allowMissing: true }).init();
  await profiles.patch(identity.profileId, {
    contact: { firstName: "Applicant", lastName: "Example", email: "applicant-one@example.test",
      phone: "+10000000000", location: "Remote" },
    documents: { resume: "/secure/resume.pdf" },
    skills: ["TypeScript", "Node.js"],
    preferences: { locations: ["Remote", "United States"], fullTime: { jobTitles: ["Software Engineer"],
      automatedDiscoverySources: ["workday"] } }
  });
  const config = {
    defaultMode: "full_time",
    discovery: { limitPerSource: 10, sourceOptions: { workday: { sites: [SITE] } } },
    modes: { full_time: { minimumScore: 0, dailyApplicationCap: 8, autoApply: true,
      autoApplyDiscovered, sources: ["workday"], requireConfirmationFor: [] } }
  };
  const requests = [];
  const discoveryFetch = fetchImpl ?? workdayFetch({ rows: [ROWS.remote], ...server, requests });
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  const applicationService = new ApplicationService({ store, config, profiles, adapter: new SimulationAdapter(),
    fetchImpl: async () => liveDetail ? json(liveDetail) : json({ errorCode: "S21", httpStatus: 404 }, 404) });
  applicationService.enqueue = () => {};
  const discovery = new DiscoveryService({ applicationService, profiles, config, fetchImpl: discoveryFetch,
    officialRequestPaceMs: 0 });
  return { profiles, applicationService, discovery, requests };
}

test("discovered Workday roles are not pending and never auto-applied", async () => {
  const { applicationService, discovery } = await workdayFixture();
  const result = await discovery.scan({}, identity);
  assert.equal(result.qualifying, 1, JSON.stringify(result.errors));
  const [entry] = result.items;
  assert.notEqual(entry.opportunity.applicationDestinationPending, true);
  assert.notEqual(entry.opportunity.applicationDestinationVerified, true);
  assert.equal(entry.application, undefined);
  assert.equal(entry.applicationBlockedBySource, "ats_submission_unsupported");
  assert.equal(applicationService.list("applications", identity.profileId).length, 0);
  const row = result.sourceYield.find((item) => item.sourceId === "workday");
  assert.equal(row.destinationPending, 0);
  assert.equal(row.submissionUnsupported, 1);
  assert.equal(row.selected, 0);
  assert.equal(row.detailReads, 1);
  assert.equal(row.unrecognizedRemoteType, 0);
  assert.equal(summarizeSourceHealth("workday", [{ ...row, completed: true }]).status, "submission_unsupported");

  // The stored role is handled, including when an aggregator returns its localized apply URL.
  const handled = knownRoleIndex(applicationService.store.snapshot(), identity.profileId);
  assert.equal(isHandledRole({ source: "jobspipe",
    applyUrl: `${HOST}/en-US/ExampleCareers${REMOTE_PATH}/apply?source=jobspipe` }, handled), true);
  const again = await discovery.scan({}, identity);
  assert.equal(again.found, 0);
});

test("campaigns skip Workday roles instead of queueing them", async () => {
  const { applicationService, discovery } = await workdayFixture({ autoApplyDiscovered: false,
    liveDetail: detail(ROWS.remote) });
  const campaign = await discovery.startCampaign({ target: 1, reserve: 0 }, identity);
  assert.equal(applicationService.list("applications", identity.profileId).length, 0);
  const scan = applicationService.store.snapshot().audit.findLast((item) =>
    item.action === "campaign.scan_completed" && item.subjectId === campaign.campaignId);
  assert.equal(scan.details.submissionUnsupported, 1);
  assert.deepEqual(scan.details.selectedOpportunityIds, []);
});

test("manual Workday requests revalidate and still need exact final approval", async () => {
  const { profiles, applicationService, discovery } = await workdayFixture({ autoApplyDiscovered: false,
    liveDetail: detail(ROWS.remote) });
  await profiles.setStandingSubmissionPolicy(identity.profileId, { mode: "automatic", modes: ["full_time"],
    sources: ["workday"], destinationHosts: ["example.wd5.myworkdayjobs.com"],
    answerClasses: ["profile_fact", "resume", "link", "grounded_prose"], dailyCap: 5, campaignCap: 5 }, owner);
  const [entry] = (await discovery.scan({}, identity)).items;
  const application = await applicationService.requestApplication(entry.opportunity.id, {}, identity);
  assert.equal(application.finalApprovalRequired, true);
  assert.equal(application.submissionApproval, "always");
});

test("manual Workday requests are refused when the posting closed or cannot be checked", async () => {
  for (const liveDetail of [undefined, detail(ROWS.remote, { canApply: false }),
    detail(ROWS.remote, { title: "Renamed role" })]) {
    const fixture = await workdayFixture({ autoApplyDiscovered: false, liveDetail });
    const [entry] = (await fixture.discovery.scan({}, identity)).items;
    await assert.rejects(fixture.applicationService.requestApplication(entry.opportunity.id, {}, identity),
      (error) => error.status === 409 && /role_closed_or_changed/.test(error.message));
    assert.equal(fixture.applicationService.list("applications", identity.profileId).length, 0);
  }
  for (const failure of [async () => { throw new Error("The operation was aborted due to timeout"); },
    async () => new Response("<html>Just a moment</html>", { status: 200 })]) {
    const offline = await workdayFixture({ autoApplyDiscovered: false });
    const [entry] = (await offline.discovery.scan({}, identity)).items;
    offline.applicationService.fetchImpl = failure;
    await assert.rejects(offline.applicationService.requestApplication(entry.opportunity.id, {}, identity),
      (error) => error.status === 503 && /workday_revalidation_unavailable/.test(error.message));
    assert.equal(offline.applicationService.list("applications", identity.profileId).length, 0);
  }
});

test("a Workday 429 backs the site off for later scans", async () => {
  let limited = true;
  const inner = workdayFetch({ rows: [ROWS.remote] });
  const hosts = [];
  const { applicationService, discovery } = await workdayFixture({ fetchImpl: async (url, options) => {
    hosts.push(new URL(url).host);
    return limited ? new Response("", { status: 429 }) : inner(url, options);
  } });
  const described = await discovery.describeSources(identity);
  const source = described.sources.find((item) => item.id === "workday");
  assert.deepEqual(source.configuredBoards, ["example/ExampleCareers"]);
  assert.deepEqual(source.filters, { board: "configured", title: "provider", location: "local" });
  assert.equal(source.kind, "official_feed");
  assert.equal(source.automaticSubmission, "unsupported");

  const first = await discovery.scan({}, identity);
  // The host is blocked after the 429, so no other search is sent to it in this scan.
  assert.equal(hosts.length, 1);
  assert.equal(first.sourceYield.find((item) => item.sourceId === "workday").rateLimited, true);
  const backoff = applicationService.store.snapshot().audit.filter((item) => item.action === "discovery.ats_backoff");
  assert.deepEqual(backoff.map((item) => [item.subjectId, item.details.reason]),
    [["workday:example/ExampleCareers", "http_429"]]);
  limited = false;
  await discovery.scan({}, identity);
  assert.equal(hosts.length, 1);
});

test("concurrent Workday searches of one site never share a response", async () => {
  const bodies = [];
  const { discovery } = await workdayFixture({ fetchImpl: async (url, options = {}) => {
    if (options.method === "POST") {
      const body = JSON.parse(options.body);
      bodies.push(body.searchText);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return json({ total: 1, jobPostings: body.searchText === "Software Engineer" ? [ROWS.remote] : [ROWS.several] });
    }
    const item = [ROWS.remote, ROWS.several].find((candidate) => String(url).endsWith(candidate.externalPath));
    return json(detail(item, { location: "US, Remote" }));
  } });
  const result = await discovery.query({ source: "workday", scanCycleId: "cycle-one", idempotencyKey: "workday-query",
    queries: [{ filters: { title: "Software Engineer" } }, { filters: { title: "Senior Software Engineer" } }] }, identity);
  assert.deepEqual(bodies.sort(), ["Senior Software Engineer", "Software Engineer"]);
  assert.deepEqual(result.items.map((entry) => entry.opportunity.externalId).sort(),
    ["example/ExampleCareers:JR-0109305", "example/ExampleCareers:JR2020825"]);
});
