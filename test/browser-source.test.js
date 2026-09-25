import assert from "node:assert/strict";
import test from "node:test";
import { extractSourcePage, isBlockingStatus, isChallengePage,
  sourceAutomationPolicy } from "../src/discovery/browser-source.js";

test("browser source extraction returns structured jobs, likely detail links, and pagination", () => {
  const html = `<!doctype html><html><body>
    <script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org", "@type": "ItemList", itemListElement: [{
        "@type": "JobPosting", identifier: { value: "role-1" }, title: "Senior Platform Developer",
        hiringOrganization: { name: "Example" }, description: "Node.js and PostgreSQL",
        jobLocationType: "TELECOMMUTE", applicantLocationRequirements: { name: "Europe" },
        employmentType: "FULL_TIME", datePosted: "2026-09-20",
        url: "https://jobs.example.test/jobs/role-1"
      }]
    })}</script>
    <a href="/jobs/role-2">Second role</a>
    <a href="/remote-jobs/company-acme">Acme jobs</a>
    <a href="/companies/acme/jobs/role-3">Engineer at Acme</a>
    <a href="/about">About</a>
    <a rel="next" href="/jobs?page=2">Next</a>
  </body></html>`;
  const result = extractSourcePage(html, "https://jobs.example.test/jobs?page=1", "example");
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].source, "example");
  assert.equal(result.jobs[0].company, "Example");
  assert.equal(result.jobs[0].remote, true);
  assert.deepEqual(result.jobLinks, [
    "https://jobs.example.test/companies/acme/jobs/role-3",
    "https://jobs.example.test/jobs/role-2"
  ]);
  assert.equal(result.nextUrl, "https://jobs.example.test/jobs?page=2");
});

test("Remote Rocketship listing cards outrank job-category links and retain official apply destinations", () => {
  const listing = `<!doctype html><html><body>
    <a href="/jobs/architect/">architect jobs</a>
    <a href="/company/examplevendor/jobs/map-test-hungary-remote/">Geospatial Test and Deployment Specialist</a>
    <a href="/jobs/software-engineer/">software engineer jobs</a>
    <a href="/company/example/jobs/map-platform-europe-remote/">Geospatial Platform Developer</a>
  </body></html>`;
  const listingResult = extractSourcePage(listing,
    "https://www.remoterocketship.com/country/europe/jobs/maps/", "remoterocketship");
  assert.deepEqual(listingResult.jobLinks.slice(0, 2), [
    "https://www.remoterocketship.com/company/examplevendor/jobs/map-test-hungary-remote/",
    "https://www.remoterocketship.com/company/example/jobs/map-platform-europe-remote/"
  ]);
  const detail = `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org", "@type": "JobPosting", title: "Geospatial Test and Deployment Specialist",
    hiringOrganization: { name: "Example Vendor" }, description: "geospatial integration testing",
    jobLocationType: "TELECOMMUTE", applicantLocationRequirements: { name: "Hungary" },
    url: "https://www.remoterocketship.com/company/examplevendor/jobs/map-test-hungary-remote/"
  })}</script></head><body>
    <a href="https://jobs.lever.co/examplevendor/00000000-0000-4000-8000-000000000001">Apply Now</a>
  </body></html>`;
  const detailResult = extractSourcePage(detail, listingResult.jobLinks[0], "remoterocketship");
  assert.equal(detailResult.jobs[0].location, "Hungary");
  assert.equal(detailResult.jobs[0].applyUrl,
    "https://jobs.lever.co/examplevendor/00000000-0000-4000-8000-000000000001");
  assert.equal(detailResult.jobs[0].applicationDestinationVerified, true);
});

test("browser source policy enforces conservative bounds and manual-only instructions", () => {
  const policy = sourceAutomationPolicy({ id: "eures",
    screeningNote: "Use manually because EURES prohibits scraping or automated extraction." },
  { maxListingPages: 999, maxRequests: 999, minDelayMs: 1 });
  assert.equal(policy.manual, true);
  assert.equal(policy.maxAcceptedResults, 10);
  assert.equal(policy.maxCandidates, 50);
  assert.equal(policy.maxListingPages, 10);
  assert.equal(policy.maxRequests, 150);
  assert.equal(policy.minDelayMs, 500);
  assert.equal(policy.sourceTimeoutMs, 50_000);
  assert.equal(sourceAutomationPolicy({ id: "bounded", automation: { sourceTimeoutMs: 90_000 } },
    { sourceTimeoutMs: 40_000 }).sourceTimeoutMs, 40_000);
  assert.equal(isBlockingStatus(403), true);
  assert.equal(isBlockingStatus(429), true);
  assert.equal(isBlockingStatus(500), false);
});

test("DOM fallback requires a role, company, and explicit compatible remote region", () => {
  const eligible = extractSourcePage(`<!doctype html><html><head>
    <title>Senior Platform Engineer at Acme | Example Jobs</title></head><body>
    <h1>Senior Platform Engineer</h1><main><p>Location: Remote, Europe</p>
    <p>Full-time role using TypeScript and PostgreSQL.</p></main></body></html>`,
  "https://jobs.example.test/jobs/platform", "example");
  assert.equal(eligible.jobs.length, 1);
  assert.equal(eligible.jobs[0].company, "Acme");
  assert.equal(eligible.jobs[0].location, "Remote, Europe");
  const unsafe = extractSourcePage(`<!doctype html><html><head>
    <title>Senior Platform Engineer at Acme | Example Jobs</title></head><body>
    <h1>Senior Platform Engineer</h1><main><p>Remote role</p></main></body></html>`,
  "https://jobs.example.test/jobs/platform", "example");
  assert.equal(unsafe.jobs.length, 0);
});

test("DOM fallback recognizes only the saved residence country outside broad regions", () => {
  const html = `<!doctype html><html><head><title>Platform Developer at Example | Careers</title>
    </head><body><h1>Platform Developer</h1><p>Location: Remote, Portugal</p></body></html>`;
  const url = "https://jobs.example.test/jobs/backend";
  assert.equal(extractSourcePage(html, url, "example").jobs.length, 0);
  const portugal = extractSourcePage(html, url, "example", { residenceCountry: "Portugal" });
  assert.equal(portugal.jobs[0].location, "Remote, Portugal");
  assert.equal(portugal.jobs[0].remote, true);
  assert.equal(extractSourcePage(html, url, "example", { residenceCountry: "Bulgaria" }).jobs.length, 0);
});

test("a structured detail page may take explicit remote-region evidence from its visible text", () => {
  const html = `<!doctype html><html><body><script type="application/ld+json">${JSON.stringify({
    "@type": "JobPosting", title: "Senior Platform Developer", hiringOrganization: { name: "Acme" },
    description: "TypeScript", employmentType: "FULL_TIME"
  })}</script><h1>Senior Platform Developer</h1><p>Location: Remote - EU</p></body></html>`;
  const result = extractSourcePage(html, "https://jobs.example.test/job/backend", "example");
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].remote, true);
  assert.equal(result.jobs[0].location, "Remote, EU");
});

test("a visible Apply link becomes the verified application destination", () => {
  const html = `<!doctype html><html><body><script type="application/ld+json">${JSON.stringify({
    "@type": "JobPosting", title: "Senior Platform Developer", hiringOrganization: { name: "Acme" },
    description: "TypeScript", jobLocationType: "TELECOMMUTE",
    applicantLocationRequirements: { name: "Europe" }
  })}</script><a href="https://careers.acme.test/apply/123?utm_source=board&amp;role=backend">Apply for job</a></body></html>`;
  const result = extractSourcePage(html, "https://board.example.test/job/backend", "example");
  assert.equal(result.jobs[0].listingUrl, "https://board.example.test/job/backend");
  assert.equal(result.jobs[0].applyUrl, "https://careers.acme.test/apply/123?utm_source=board&role=backend");
  assert.equal(result.jobs[0].applicationDestinationVerified, true);
});

test("public feed role pages expose employer Apply links without promoting category pages", () => {
  const html = `<html><head><title>Remote roles</title></head><body>
    <a href="https://jobs.ashbyhq.com/example/11111111-1111-4111-8111-111111111111/application">
      Apply for this position</a></body></html>`;
  const remotive = extractSourcePage(html,
    "https://remotive.com/remote-jobs/software-development/senior-engineer-123", "remotive");
  const wwr = extractSourcePage(html,
    "https://weworkremotely.com/remote-jobs/example-senior-engineer", "weworkremotely");
  assert.equal(remotive.observedApplyUrl,
    "https://jobs.ashbyhq.com/example/11111111-1111-4111-8111-111111111111/application");
  assert.equal(wwr.observedApplyUrl, remotive.observedApplyUrl);
  assert.equal(extractSourcePage(html,
    "https://remotive.com/remote-jobs/software-development", "remotive").observedApplyUrl,
  undefined);
  assert.equal(extractSourcePage(html,
    "https://weworkremotely.com/remote-jobs", "weworkremotely").observedApplyUrl,
  undefined);
});

test("same-board Apply links remain unverified and challenge pages stop extraction", () => {
  const html = `<!doctype html><html><head><title>Platform Developer at Acme</title></head><body>
    <h1>Platform Developer</h1><p>Remote, Europe</p>
    <a href="https://board.example.test/apply/123">Apply now</a></body></html>`;
  const result = extractSourcePage(html, "https://board.example.test/jobs/123", "board");
  assert.equal(result.jobs[0].applicationDestinationVerified, undefined);
  assert.equal(isChallengePage("<html><title>Just a moment...</title></html>"), true);
  assert.equal(isChallengePage("<html><title>Engineering Jobs</title><div class='cf-chl-widget'></div></html>"), true);
  assert.equal(isChallengePage(html), false);
});

test("Working Nomads uses the current role location and ignores similar-job regions", () => {
  const html = `<!doctype html><html><head>
    <title>UI Programmer at Acme | Working Nomads</title></head><body>
    <h1>UI Programmer</h1>
    <div class="jd-meta-line"><div><i class="fa fa-map-marker"></i></div><span>Croatia</span></div>
    <main><p>Full-time remote role.</p></main>
    <section><h3>Similar Jobs</h3><p>Remote, Europe</p></section>
  </body></html>`;
  const result = extractSourcePage(html, "https://www.workingnomads.com/jobs/frontend-engineer-acme", "workingnomads");
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].location, "Croatia");
  assert.equal(result.jobs[0].remote, true);
  assert.doesNotMatch(result.jobs[0].description, /Similar Jobs/);
});
