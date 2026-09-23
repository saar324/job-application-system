import assert from "node:assert/strict";
import test from "node:test";
import { parsePublicFeed, publicFeedUrl } from "../src/discovery/public-feeds.js";

test("Jobgether official API query is bounded and normalized", () => {
  const url = new URL(publicFeedUrl("jobgether", { query: "backend engineer", page: 2, limit: 100 }));
  assert.equal(url.pathname, "/api/v1/jobs");
  assert.equal(url.searchParams.get("locations"), "europe,bulgaria");
  assert.equal(url.searchParams.get("remoteType"), "full-remote");
  assert.equal(url.searchParams.get("sort"), "relevance");
  assert.equal(url.searchParams.get("limit"), "25");
  const parsed = parsePublicFeed("jobgether", { jobs: [{ id: "one", title: "Backend Engineer",
    company: "Acme", url: "https://jobgether.com/offer/one", location: "Europe",
    remote: "Full Remote", contractType: "Full time", postedAt: "2026-09-20",
    jobFunctions: ["Backend Developer"] }], pagination: { hasMore: true } });
  assert.equal(parsed.items[0].remote, true);
  assert.equal(parsed.items[0].employmentType, "Full time");
  assert.equal(parsed.detailLinks[0], "https://jobgether.com/offer/one");
  assert.equal(parsed.hasMore, true);
});

test("Remotive and We Work Remotely feeds preserve eligibility evidence", () => {
  const remotive = parsePublicFeed("remotive", { jobs: [{ id: 1, title: "AI Engineer",
    company_name: "Acme", description: "<p>Python and LLM systems</p>",
    candidate_required_location: "Worldwide", job_type: "full_time",
    publication_date: "2026-09-20", salary: "€70k - €90k",
    url: "https://remotive.com/remote-jobs/software-development/ai-engineer-1" }] });
  assert.equal(remotive.items[0].location, "Worldwide");
  assert.deepEqual(remotive.items[0].compensation,
    { minimum: 70000, maximum: 90000, currency: "EUR", period: "year" });
  const rss = `<rss><channel><item><title>Acme: Backend Engineer</title>
    <region>Anywhere in the World</region><description>&lt;p&gt;Node.js and PostgreSQL&lt;/p&gt;</description>
    <link>https://weworkremotely.com/remote-jobs/acme-backend</link></item></channel></rss>`;
  const wwr = parsePublicFeed("weworkremotely", rss);
  assert.equal(wwr.items[0].company, "Acme");
  assert.equal(wwr.items[0].title, "Backend Engineer");
  assert.equal(wwr.items[0].location, "Worldwide");
  assert.match(wwr.items[0].description, /Node\.js/);
});
