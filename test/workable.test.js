import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SimulationAdapter } from "../src/adapters/simulation.js";
import { DiscoveryService } from "../src/discovery/service.js";
import { workable } from "../src/discovery/sources/workable.js";
import { isHandledRole, roleKeys } from "../src/discovery/handled-roles.js";
import { employerAtsDestination, officialAtsDestination,
  revalidateWorkableRole } from "../src/discovery/official-ats.js";
import { summarizeSourceHealth } from "../src/discovery/source-health.js";
import { ProfileStore } from "../src/profile-store.js";
import { ApplicationService } from "../src/service.js";
import { JsonStore } from "../src/store.js";

const identity = { actorId: "applicant-one-agent", profileId: "applicant-one" };
const owner = { actorId: "owner", profileId: "applicant-one", roles: ["owner"] };
const listingUrl = "https://apply.workable.com/example-co/j/869D4D5FFD/";
const applyUrl = `${listingUrl}apply/`;
const account = {
  name: "Example Co", description: "<p>Example employer.</p>",
  jobs: [{
    title: "Senior Node.js Engineer", shortcode: "869d4d5ffd", employment_type: "Full-time",
    telecommuting: true, department: "Engineering", function: "Engineering", industry: "Software",
    url: "https://apply.workable.com/j/869D4D5FFD", shortlink: "https://apply.workable.com/j/869D4D5FFD",
    application_url: "https://apply.workable.com/j/869D4D5FFD/apply",
    published_on: "2026-09-20", created_at: "2026-09-20", country: "United States", city: "", state: "",
    locations: [
      { country: "United States", countryCode: "US", city: "", region: null, hidden: false },
      { country: "Hiddenland", countryCode: "HL", city: "Secret", region: null, hidden: true }
    ],
    description: "<p>TypeScript Node.js platform work. Salary: $120k–$150k USD per year.</p>"
  }, {
    title: "Office Engineer", shortcode: "B02DA69C8F", employment_type: "Full-time",
    telecommuting: false, department: "Engineering", published_on: "2026-09-21",
    locations: [{ country: "Remote", city: "", region: null, hidden: false }],
    description: "<p>On site.</p>"
  }]
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status,
  headers: { "content-type": "application/json" } });

test("Workable adapter normalizes explicit fields from the documented account feed", async () => {
  const requested = [];
  const rows = await workable.search({
    sourceConfig: { boards: [{ slug: "Example-Co" }] },
    fetchImpl: async (url) => { requested.push(String(url)); return json(account); }
  });
  assert.deepEqual(requested, ["https://www.workable.com/api/accounts/example-co?details=true"]);
  assert.equal(rows.length, 1);
  const [role] = rows;
  assert.equal(role.source, "workable");
  assert.equal(role.externalId, "example-co:869D4D5FFD");
  assert.equal(role.company, "Example Co");
  assert.equal(role.listingUrl, listingUrl);
  assert.equal(role.applyUrl, applyUrl);
  assert.equal(role.remote, true);
  assert.equal(role.location, "United States");
  assert.equal(role.employmentType, "Full-time");
  assert.equal(role.postedAt, "2026-09-20");
  assert.match(role.description, /TypeScript Node\.js/);
  assert.deepEqual(role.compensation, { minimum: 120000, maximum: 150000, currency: "USD", period: "year" });
  assert.deepEqual(role.tags, ["Engineering", "Software"]);
});

test("Workable remote status comes only from telecommuting", async () => {
  const stats = [];
  const rows = await workable.search({
    sourceConfig: { boards: [{ slug: "example-co", company: "Configured Co" }] },
    fetchImpl: async () => json(account), onStats: (value) => stats.push(value)
  });
  assert.deepEqual(rows.map((role) => role.title), ["Senior Node.js Engineer"]);
  assert.equal(rows[0].company, "Configured Co");
  assert.deepEqual(stats, [{ rawRows: 2, adapterPrescreenRejected: 1, pagesVisited: 1 }]);
});

test("Workable merges a job repeated once per location into one role", async () => {
  const repeated = (country) => ({ title: "Senior Data Engineer", shortcode: "FAD6715D76",
    employment_type: "Full-time", telecommuting: true, published_on: "2026-09-22",
    locations: [{ country, countryCode: "", city: "", region: null, hidden: false }],
    description: "<p>Data platform.</p>" });
  const stats = [];
  const rows = await workable.search({ sourceConfig: { boards: [{ slug: "example-co" }] },
    fetchImpl: async () => json({ name: "Example Co", jobs: [repeated("Romania"), repeated("Greece"),
      repeated("Romania")] }), onStats: (value) => stats.push(value) });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].externalId, "example-co:FAD6715D76");
  assert.equal(rows[0].location, "Romania; Greece");
  assert.deepEqual(stats, [{ rawRows: 3, adapterPrescreenRejected: 0, pagesVisited: 1 }]);
});

test("Workable reads only configured, valid account slugs", async () => {
  let fetches = 0;
  const fetchImpl = async () => { fetches += 1; return json(account); };
  assert.deepEqual(await workable.search({ sourceConfig: {}, fetchImpl }), []);
  assert.deepEqual(await workable.search({ sourceConfig: { boards: [] }, fetchImpl }), []);
  assert.deepEqual(await workable.search({ sourceConfig: { boards: [
    { slug: "../admin" }, { slug: "has space" }, { slug: "a?b=c" }] }, fetchImpl }), []);
  assert.deepEqual(await workable.search({ sourceConfig: { boards: [{ slug: "example-co" }] },
    query: { board: "someone-else" }, fetchImpl }), []);
  assert.equal(fetches, 0);
  const requested = [];
  await workable.search({ sourceConfig: { boards: [{ slug: "example-co" }, { slug: "other-co" }] },
    query: { board: "other-co" }, fetchImpl: async (url) => { requested.push(String(url)); return json(account); } });
  assert.deepEqual(requested, ["https://www.workable.com/api/accounts/other-co?details=true"]);
});

test("Workable isolates account failures and reports them in backoff-compatible text", async () => {
  const errors = [];
  const rows = await workable.search({
    sourceConfig: { boards: [{ slug: "missing-co" }, { slug: "limited-co" }, { slug: "challenge-co" },
      { slug: "example-co" }] },
    onError: (error) => errors.push(error),
    fetchImpl: async (url) => {
      if (String(url).includes("missing-co")) return new Response("Not Found", { status: 404 });
      if (String(url).includes("limited-co")) return new Response("", { status: 429 });
      if (String(url).includes("challenge-co")) return new Response("<html>Just a moment</html>", { status: 200 });
      return json(account);
    }
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(errors.map((error) => error.board), ["missing-co", "limited-co", "challenge-co"]);
  assert.match(errors[0].error, /returned HTTP 404 \(unknown account\)/);
  assert.match(errors[1].error, /returned HTTP 429\b/);
  assert.match(errors[2].error, /invalid_official_response.*challenge/);
});

test("Workable URL forms share one role key", () => {
  const stored = { source: "workable", externalId: "example-co:869D4D5FFD", applyUrl, listingUrl };
  const key = "workable:869D4D5FFD";
  assert.deepEqual([...roleKeys(stored)], [key]);
  for (const url of ["https://apply.workable.com/j/869D4D5FFD",
    "https://apply.workable.com/j/869d4d5ffd/apply/?utm_source=board",
    "https://apply.workable.com/example-co/j/869D4D5FFD",
    "https://apply.workable.com/Example-Co/j/869D4D5FFD/apply"]) {
    assert.deepEqual([...roleKeys({ source: "browser", applyUrl: url })], [key], url);
    assert.equal(isHandledRole({ source: "browser", applyUrl: url }, new Set([key])), true);
  }
  assert.notDeepEqual([...roleKeys({ applyUrl: "https://apply.workable.com/example-co/" })], [key]);
});

test("Workable destinations are known but never official for automatic submission", () => {
  const role = { source: "workable", externalId: "example-co:869D4D5FFD", applyUrl, listingUrl };
  assert.equal(officialAtsDestination(role), false);
  assert.equal(employerAtsDestination(role), true);
  assert.equal(employerAtsDestination({ ...role, source: "himalayas" }), false);
  assert.equal(employerAtsDestination({ ...role, applyUrl: "https://apply.workable.com/other-co/j/869D4D5FFD/apply/" }), false);
  assert.equal(employerAtsDestination({ ...role, applyUrl: "https://evil.example.test/example-co/j/869D4D5FFD/apply/" }), false);
});

test("Workable revalidation admits only a published role with the same shortcode and title", async () => {
  const role = { source: "workable", externalId: "example-co:869D4D5FFD", applyUrl, listingUrl,
    title: "Senior Node.js Engineer" };
  const live = { shortcode: "869D4D5FFD", title: "Senior Node.js Engineer", state: "published" };
  const urls = [];
  assert.equal(await revalidateWorkableRole(role, async (url) => { urls.push(String(url)); return json(live); }), "open");
  assert.deepEqual(urls, ["https://apply.workable.com/api/v2/accounts/example-co/jobs/869D4D5FFD"]);
  assert.equal(await revalidateWorkableRole(role, async () => new Response("", { status: 404 })), "closed_or_changed");
  assert.equal(await revalidateWorkableRole(role, async () => json({ ...live, state: "closed" })), "closed_or_changed");
  assert.equal(await revalidateWorkableRole(role, async () => json({ ...live, title: "Other" })), "closed_or_changed");
  assert.equal(await revalidateWorkableRole(role, async () => { throw new Error("timeout"); }), "unavailable");
  assert.equal(await revalidateWorkableRole(role, async () => new Response("<html>", { status: 200 })), "unavailable");
  assert.equal(await revalidateWorkableRole(role, async () => new Response("", { status: 503 })), "unavailable");
});

async function workableFixture({ autoApplyDiscovered = true, liveRole } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-workable-test-"));
  const profiles = await new ProfileStore(path.join(directory, "profiles.json"), { allowMissing: true }).init();
  await profiles.patch(identity.profileId, {
    contact: { firstName: "Applicant", lastName: "Example", email: "applicant-one@example.test",
      phone: "+10000000000", location: "Remote" },
    documents: { resume: "/secure/resume.pdf" },
    skills: ["TypeScript", "Node.js"],
    preferences: { locations: ["Remote", "United States"], fullTime: { jobTitles: ["Senior Engineer"],
      automatedDiscoverySources: ["workable"] } }
  });
  const config = {
    defaultMode: "full_time",
    discovery: { limitPerSource: 10, sourceOptions: { workable: { boards: [{ slug: "example-co" }] } } },
    modes: { full_time: { minimumScore: 0, dailyApplicationCap: 8, autoApply: true,
      autoApplyDiscovered, sources: ["workable"], requireConfirmationFor: [] } }
  };
  const fetchImpl = async (url) => String(url).includes("/api/v2/")
    ? (liveRole ? json(liveRole) : new Response("", { status: 404 })) : json(account);
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  const applicationService = new ApplicationService({ store, config, profiles,
    adapter: new SimulationAdapter(), fetchImpl });
  applicationService.enqueue = () => {};
  const discovery = new DiscoveryService({ applicationService, profiles, config, fetchImpl,
    officialRequestPaceMs: 0 });
  return { profiles, applicationService, discovery };
}

test("discovered Workable roles are not pending and never auto-applied", async () => {
  const { applicationService, discovery } = await workableFixture();
  const result = await discovery.scan({}, identity);
  assert.equal(result.qualifying, 1, JSON.stringify(result.errors));
  const [entry] = result.items;
  assert.notEqual(entry.opportunity.applicationDestinationPending, true);
  assert.notEqual(entry.opportunity.applicationDestinationVerified, true);
  assert.equal(entry.opportunity.discoveryState, undefined);
  assert.equal(entry.application, undefined);
  assert.equal(entry.applicationBlockedBySource, "ats_submission_unsupported");
  assert.equal(applicationService.list("applications", identity.profileId).length, 0);
  const row = result.sourceYield.find((item) => item.sourceId === "workable");
  assert.equal(row.destinationPending, 0);
  assert.equal(row.submissionUnsupported, 1);
  assert.equal(row.selected, 0);
  assert.equal(summarizeSourceHealth("workable", [{ ...row, completed: true }]).status, "submission_unsupported");

  const again = await discovery.scan({}, identity);
  assert.equal(again.found, 0);
});

test("campaigns skip Workable roles instead of queueing them", async () => {
  const { applicationService, discovery } = await workableFixture({ autoApplyDiscovered: false,
    liveRole: { shortcode: "869D4D5FFD", title: "Senior Node.js Engineer", state: "published" } });
  const campaign = await discovery.startCampaign({ target: 1, reserve: 0 }, identity);
  assert.equal(applicationService.list("applications", identity.profileId).length, 0);
  const scan = applicationService.store.snapshot().audit.findLast((item) =>
    item.action === "campaign.scan_completed" && item.subjectId === campaign.campaignId);
  assert.equal(scan.details.submissionUnsupported, 1);
  assert.deepEqual(scan.details.selectedOpportunityIds, []);
});

test("manual Workable requests revalidate and still need exact final approval", async () => {
  const live = { shortcode: "869D4D5FFD", title: "Senior Node.js Engineer", state: "published" };
  const { profiles, applicationService, discovery } = await workableFixture({ autoApplyDiscovered: false,
    liveRole: live });
  await profiles.setStandingSubmissionPolicy(identity.profileId, { mode: "automatic", modes: ["full_time"],
    sources: ["workable"], destinationHosts: ["apply.workable.com"],
    answerClasses: ["profile_fact", "resume", "link", "grounded_prose"], dailyCap: 5, campaignCap: 5 }, owner);
  const [entry] = (await discovery.scan({}, identity)).items;
  const application = await applicationService.requestApplication(entry.opportunity.id, {}, identity);
  assert.equal(application.finalApprovalRequired, true);
  assert.equal(application.submissionApproval, "always");
});

test("manual Workable requests are refused when the posting closed or cannot be checked", async () => {
  const closed = await workableFixture({ autoApplyDiscovered: false });
  const [closedEntry] = (await closed.discovery.scan({}, identity)).items;
  await assert.rejects(closed.applicationService.requestApplication(closedEntry.opportunity.id, {}, identity),
    (error) => error.status === 409 && /role_closed_or_changed/.test(error.message));
  assert.equal(closed.applicationService.list("applications", identity.profileId).length, 0);

  const changed = await workableFixture({ autoApplyDiscovered: false,
    liveRole: { shortcode: "869D4D5FFD", title: "Renamed role", state: "published" } });
  const [changedEntry] = (await changed.discovery.scan({}, identity)).items;
  await assert.rejects(changed.applicationService.requestApplication(changedEntry.opportunity.id, {}, identity),
    /role_closed_or_changed/);

  const offline = await workableFixture({ autoApplyDiscovered: false });
  const [offlineEntry] = (await offline.discovery.scan({}, identity)).items;
  offline.applicationService.fetchImpl = async () => { throw new Error("The operation was aborted due to timeout"); };
  await assert.rejects(offline.applicationService.requestApplication(offlineEntry.opportunity.id, {}, identity),
    (error) => error.status === 503 && /workable_revalidation_unavailable/.test(error.message));
  assert.equal(offline.applicationService.list("applications", identity.profileId).length, 0);
});
