import assert from "node:assert/strict";
import test from "node:test";
import { jobgetherGeographyScope, parsePublicFeed,
  publicFeedUrl } from "../src/discovery/public-feeds.js";

test("Jobgether official API query is bounded and normalized", () => {
  const url = new URL(publicFeedUrl("jobgether", { query: "platform developer", page: 2,
    limit: 100, residenceCountry: "Portugal" }));
  assert.equal(url.pathname, "/api/v1/jobs");
  assert.equal(url.searchParams.get("locations"), "portugal");
  assert.equal(url.searchParams.get("remoteType"), "full-remote");
  assert.equal(url.searchParams.get("sort"), "relevance");
  assert.equal(url.searchParams.get("limit"), "25");
  assert.equal(new URL(publicFeedUrl("jobgether")).searchParams.has("locations"), false);
  assert.equal(new URL(publicFeedUrl("jobgether")).searchParams.has("keyword"), false);
  assert.equal(new URL(publicFeedUrl("jobgether")).searchParams.has("contractType"), false);
  assert.deepEqual([0, 1, 2].map((index) => jobgetherGeographyScope("Portugal", index)),
    ["residence", "worldwide", "residence"]);
  assert.deepEqual([0, 1, 2].map((index) => jobgetherGeographyScope("Portugal", index, 0,
    ["Europe"])), ["europe", "residence", "worldwide"]);
  assert.equal(jobgetherGeographyScope("Portugal", 0, 0, ["EU / EEA"]), "europe");
  assert.equal(jobgetherGeographyScope("Portugal", 0, 1, ["Europe"]), "residence");
  assert.equal(new URL(publicFeedUrl("jobgether", { residenceCountry: "Portugal",
    geographyScope: "residence" })).searchParams.get("locations"), "portugal");
  assert.equal(new URL(publicFeedUrl("jobgether", { residenceCountry: "Portugal",
    geographyScope: "worldwide" })).searchParams.has("locations"), false);
  assert.equal(new URL(publicFeedUrl("jobgether", { residenceCountry: "",
    geographyScope: "residence" })).searchParams.has("locations"), false);
  const parsed = parsePublicFeed("jobgether", { jobs: [{ id: "one", title: "Platform Developer",
    company: "Acme", url: "https://jobgether.com/offer/one", location: "Europe",
    remote: "Full Remote", contractType: "Full time", postedAt: "2026-09-20",
    jobFunctions: ["Platform Developer"] }], pagination: { hasMore: true } });
  assert.equal(parsed.items[0].remote, true);
  assert.equal(parsed.items[0].employmentType, "Full time");
  assert.equal(parsed.detailLinks[0], "https://jobgether.com/offer/one");
  assert.equal(parsed.hasMore, true);
});

test("Remotive and We Work Remotely feeds preserve eligibility evidence", () => {
  assert.equal(publicFeedUrl("remotive", { limit: 50 }),
    "https://remotive.com/api/remote-jobs?limit=50");
  assert.equal(publicFeedUrl("weworkremotely"), "https://weworkremotely.com/remote-jobs.rss");
  const remotive = parsePublicFeed("remotive", { jobs: [{ id: 1, title: "ML Developer",
    company_name: "Acme", description: "<p>Python and LLM systems</p>",
    candidate_required_location: "Worldwide", job_type: "full_time",
    publication_date: "2026-09-20", salary: "€70k - €90k",
    url: "https://remotive.com/remote-jobs/software-development/ai-engineer-1" }] });
  assert.equal(remotive.items[0].location, "Worldwide");
  assert.deepEqual(remotive.items[0].compensation,
    { minimum: 70000, maximum: 90000, currency: "EUR", period: "year" });
  assert.equal(remotive.items[0].applicationDestinationVerified, undefined);
  const rss = `<rss><channel><item><title>Acme: Platform Developer</title>
    <region>Anywhere in the World</region><description>&lt;p&gt;Node.js and PostgreSQL&lt;/p&gt;</description>
    <link>https://weworkremotely.com/remote-jobs/acme-backend</link></item></channel></rss>`;
  const wwr = parsePublicFeed("weworkremotely", rss);
  assert.equal(wwr.items[0].company, "Acme");
  assert.equal(wwr.items[0].title, "Platform Developer");
  assert.equal(wwr.items[0].location, "Worldwide");
  assert.match(wwr.items[0].description, /Node\.js/);
  assert.equal(wwr.items[0].applicationDestinationVerified, undefined);
});
