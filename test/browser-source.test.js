import assert from "node:assert/strict";
import test from "node:test";
import { extractSourcePage, isBlockingStatus, sourceAutomationPolicy } from "../src/discovery/browser-source.js";

test("browser source extraction returns structured jobs, likely detail links, and pagination", () => {
  const html = `<!doctype html><html><body>
    <script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org", "@type": "ItemList", itemListElement: [{
        "@type": "JobPosting", identifier: { value: "role-1" }, title: "Senior Backend Engineer",
        hiringOrganization: { name: "Example" }, description: "Node.js and PostgreSQL",
        jobLocationType: "TELECOMMUTE", applicantLocationRequirements: { name: "Europe" },
        employmentType: "FULL_TIME", datePosted: "2026-09-20",
        url: "https://jobs.example.test/jobs/role-1"
      }]
    })}</script>
    <a href="/jobs/role-2">Second role</a>
    <a href="/about">About</a>
    <a rel="next" href="/jobs?page=2">Next</a>
  </body></html>`;
  const result = extractSourcePage(html, "https://jobs.example.test/jobs?page=1", "example");
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].source, "example");
  assert.equal(result.jobs[0].company, "Example");
  assert.equal(result.jobs[0].remote, true);
  assert.deepEqual(result.jobLinks, [
    "https://jobs.example.test/jobs/role-2"
  ]);
  assert.equal(result.nextUrl, "https://jobs.example.test/jobs?page=2");
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
  assert.equal(isBlockingStatus(403), true);
  assert.equal(isBlockingStatus(429), true);
  assert.equal(isBlockingStatus(500), false);
});
