import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractSourcePage } from "../src/discovery/browser-source.js";
import { DiscoveryService } from "../src/discovery/service.js";
import { ProfileStore } from "../src/profile-store.js";
import { ApplicationService } from "../src/service.js";
import { JsonStore } from "../src/store.js";

const home = "https://www.gjc.org/";
const list = "https://www.gjc.org/cgi-bin/listjobs.pl";
const detail = "https://www.gjc.org/cgi-bin/showjob.pl?id=12345";

test("a public legacy job list and exact detail are discovered within normal page limits", () => {
  const first = extractSourcePage(`<main><a href="/cgi-bin/listjobs.pl">View all job postings</a>
    <a href="/cgi-bin/gjc.pl?mode=create&resource=job">Post Jobs</a></main>`, home, "gisjobs");
  assert.deepEqual(first.jobLinks, [list]);
  const second = extractSourcePage(`<main><h2>Available Positions</h2>
    <a href="/cgi-bin/showjob.pl?id=12345">Geospatial Cloud Developer</a>
    <a href="/cgi-bin/showjob.pl?id=not-an-id">Invalid role</a></main>`, list, "gisjobs");
  assert.deepEqual(second.jobLinks, [detail]);
  const last = extractSourcePage(`<main><h2>Job Detail</h2>
    <p><b>Organization:</b> Example Maps<br><b>Title:</b> Contract Geospatial Cloud Developer<br>
    <b>Location:</b> Remote, Europe<br><b>Posted:</b> 2026-09-22<br></p>
    <p><b>Position Description</b>: Build secure map services on AWS.</p>
    <p>How to apply: contact the employer.</p></main>`, detail, "gisjobs");
  assert.equal(last.jobs.length, 1);
  assert.deepEqual({ title: last.jobs[0].title, company: last.jobs[0].company,
    location: last.jobs[0].location, remote: last.jobs[0].remote,
    employmentType: last.jobs[0].employmentType, externalId: last.jobs[0].externalId },
  { title: "Contract Geospatial Cloud Developer", company: "Example Maps",
    location: "Remote, Europe", remote: true, employmentType: "contract", externalId: "12345" });
  assert.equal(last.jobs[0].applyUrl, detail);
  assert.equal(last.jobs[0].applicationDestinationVerified, undefined);
  assert.deepEqual(last.jobs[0].uncertainties, ["employer_application_url_unverified"]);
});

test("legacy CGI extraction requires exact source, host, role id, and labeled facts", () => {
  const markup = `<main><a href="/cgi-bin/showjob.pl?id=12345">Geospatial Cloud Developer</a>
    <p><b>Organization:</b> Example Maps<br><b>Title:</b> Geospatial Cloud Developer<br>
    <b>Location:</b> Remote, Europe<br></p></main>`;
  assert.deepEqual(extractSourcePage(markup, "https://other.example/cgi-bin/listjobs.pl", "gisjobs").jobLinks, []);
  assert.deepEqual(extractSourcePage(markup, list, "other_source").jobLinks, []);
  assert.deepEqual(extractSourcePage(markup.replace("Organization:", "Unknown:"), detail,
    "gisjobs").jobs, []);
  assert.deepEqual(extractSourcePage(markup, "https://www.gjc.org/cgi-bin/showjob.pl?id=bad",
    "gisjobs").jobs, []);
});

test("a board-only geospatial listing stays destination-pending and queues no application", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gisjobs-test-"));
  const profiles = await new ProfileStore(path.join(directory, "profiles.json"),
    { allowMissing: true }).init();
  const identity = { actorId: "agent", profileId: "applicant" };
  await profiles.patch(identity.profileId, { contact: { firstName: "Ada", lastName: "Example",
    email: "ada@example.test", phone: "+10000000000", location: "Europe" },
  documents: { resume: "/private/resume.pdf" }, skills: ["Geospatial", "AWS"],
  preferences: { locations: ["Europe"], fullTime: { jobTitles: ["Geospatial Cloud Developer"],
    remoteOnly: true } } });
  const config = { defaultMode: "full_time", modes: { full_time: { minimumScore: 0,
    dailyApplicationCap: 8, sources: [], requireConfirmationFor: [] } } };
  const service = new ApplicationService({ store: await new JsonStore(path.join(directory,
    "state.json")).init(), profiles, config, adapter: {} });
  const discovery = new DiscoveryService({ applicationService: service, profiles, config });
  const campaignId = "11111111-1111-4111-8111-111111111111";
  await service.createCampaign({ id: campaignId, target: 1, reserve: 0, mode: "full_time",
    sources: [], fallbackSources: ["gisjobs"], reserveOnly: true }, identity);
  const role = extractSourcePage(`<main><b>Organization:</b> Example Maps<br>
    <b>Title:</b> Senior Geospatial Cloud Developer<br><b>Location:</b> Remote, Europe<br>
    <p>Build geospatial cloud services with AWS.</p></main>`, detail, "gisjobs").jobs[0];
  const result = await discovery.addCampaignSourceResults(campaignId, {
    sourceId: "gisjobs", items: [role], completed: true, pagesVisited: 1, requestsMade: 3
  }, identity);
  assert.equal(result.sourceCoverage.scans[0].selected, 0);
  assert.equal(result.sourceCoverage.scans[0].destinationPending, 1);
  assert.equal(result.applications.length, 0);
});
