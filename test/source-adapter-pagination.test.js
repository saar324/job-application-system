import assert from "node:assert/strict";
import test from "node:test";
import { himalayas } from "../src/discovery/sources/himalayas.js";
import { jobicy } from "../src/discovery/sources/jobicy.js";
import { remoteok } from "../src/discovery/sources/remoteok.js";
import { arbeitnow } from "../src/discovery/sources/arbeitnow.js";

const profile = { preferences: { fullTime: { jobTitles: ["Example Platform Engineer"] } } };

test("Himalayas reaches page two after twenty handled jobs", async () => {
  const pages = [];
  const items = await himalayas.search({ limit: 1, profile, query: { q: "Example Platform Engineer" },
    isHandled: (role) => role.externalId !== "late",
    fetchImpl: async (url) => {
      const page = Number(url.searchParams.get("page"));
      pages.push(page);
      const jobs = page === 1 ? Array.from({ length: 20 }, (_, index) => ({
        guid: `handled-${index}`, title: "Example Platform Engineer",
        applicationLink: `https://example.test/apply/${index}`
      })) : [{ guid: "late", title: "Example Platform Engineer",
        applicationLink: "https://example.test/apply/late" }];
      return new Response(JSON.stringify({ jobs }));
    } });
  assert.deepEqual(pages, [1, 2]);
  assert.deepEqual(items.map((item) => item.externalId), ["late"]);
});

test("Himalayas keeps a partial page and stops on a rate limit", async () => {
  const pages = [];
  const reasons = [];
  const items = await himalayas.search({ limit: 30, profile,
    query: { q: "Example Platform Engineer" },
    onError: (entry) => reasons.push(entry.reason),
    fetchImpl: async (url) => {
      const page = Number(url.searchParams.get("page"));
      pages.push(page);
      if (page === 2) return new Response("rate limited", { status: 429 });
      return new Response(JSON.stringify({ jobs: Array.from({ length: 20 }, (_, index) => ({
        guid: `first-${index}`, title: "Example Platform Engineer",
        applicationLink: `https://example.test/apply/${index}`
      })) }));
    } });
  assert.deepEqual(pages, [1, 2]);
  assert.equal(items.length, 20);
  assert.deepEqual(reasons, ["partial_fetch_failure"]);
});

test("Himalayas marks a raw pool ceiling as partial when more pages remain", async () => {
  const reasons = [];
  const items = await himalayas.search({ limit: 20, profile,
    query: { q: "Example Platform Engineer" },
    onError: (entry) => reasons.push(entry.reason),
    fetchImpl: async (url) => {
      const page = Number(url.searchParams.get("page"));
      return new Response(JSON.stringify({ pagination: { hasMore: true },
        jobs: Array.from({ length: 20 }, (_, index) => ({
          guid: `role-${page}-${index}`, title: "Example Platform Engineer",
          applicationLink: `https://example.test/apply/${page}-${index}`
        })) }));
    } });
  assert.equal(items.length, 20);
  assert.ok(reasons.includes("partial_raw_pool_cap"));
});

test("Jobicy requests the full non-paginated response per title", async () => {
  const counts = [];
  const items = await jobicy.search({ limit: 1, profile,
    isHandled: (role) => role.externalId !== "late",
    fetchImpl: async (url) => {
      counts.push(new URL(url).searchParams.get("count"));
      const jobs = Array.from({ length: 25 }, (_, index) => ({
        id: index === 24 ? "late" : `handled-${index}`,
        jobTitle: "Example Platform Engineer", companyName: "Example",
        url: `https://jobicy.com/jobs/${index}`
      }));
      return new Response(JSON.stringify({ jobs }));
    } });
  assert.ok(counts.length > 0);
  assert.ok(counts.every((count) => count === "200"));
  assert.deepEqual(items.map((item) => item.externalId), ["late"]);
});

test("Jobicy keeps a later-query role when the first query fills the raw cap", async () => {
  const searchProfile = { preferences: { fullTime: {
    jobTitles: ["Example Platform Engineer", "Example Interface Engineer"] } } };
  const first = Array.from({ length: 200 }, (_, index) => ({
    id: `noise-${index}`, jobTitle: "Example Platform Engineer", companyName: "Example",
    url: `https://jobicy.com/jobs/noise-${index}`
  }));
  const later = { id: "suitable-later", jobTitle: "Example Interface Engineer",
    companyName: "Example", url: "https://jobicy.com/jobs/suitable-later",
    jobDescription: "Example role description" };
  const requests = [];
  const errors = [];
  const items = await jobicy.search({ limit: 200, profile: searchProfile,
    onError: (entry) => errors.push(entry), fetchImpl: async (url) => {
      const term = new URL(url).searchParams.get("tag");
      requests.push(term);
      const jobs = term === "Example Platform Engineer" ? first
        : term === "Example Interface Engineer" ? [{ ...first[0], jobDescription: "Updated posting text" }, later] : [];
      return new Response(JSON.stringify({ jobs }));
    } });
  assert.ok(requests.includes("Example Platform Engineer"));
  assert.ok(requests.includes("Example Interface Engineer"));
  assert.ok(requests.length <= 16);
  assert.equal(items.length, 200);
  assert.ok(items.some((item) => item.externalId === later.id));
  assert.equal(items.filter((item) => item.externalId === first[0].id).length, 1);
  assert.equal(items.find((item) => item.externalId === first[0].id).description,
    "Updated posting text");
  assert.ok(errors.some((entry) => entry.reason === "partial_raw_pool_cap"
    && entry.rawRows === 201 && entry.omittedRows === 1));
});

test("unpaginated feeds report rows omitted by the bounded pool", async () => {
  const jobicyReasons = [];
  await jobicy.search({ limit: 1, profile, onError: (entry) => jobicyReasons.push(entry.reason),
    fetchImpl: async () => new Response(JSON.stringify({ jobs: [
      { id: 1, jobTitle: "Example Platform Engineer", url: "https://jobicy.com/jobs/1" },
      { id: 2, jobTitle: "Example Platform Engineer", url: "https://jobicy.com/jobs/2" }
    ] })) });
  assert.ok(jobicyReasons.includes("partial_raw_pool_cap"));
  const remoteReasons = [];
  await remoteok.search({ limit: 1, onError: (entry) => remoteReasons.push(entry.reason),
    fetchImpl: async () => new Response(JSON.stringify([{
      id: 1, position: "Example Platform Engineer", url: "https://remoteok.com/jobs/1"
    }, { id: 2, position: "Example Platform Engineer", url: "https://remoteok.com/jobs/2" }])) });
  assert.ok(remoteReasons.includes("partial_raw_pool_cap"));
});

test("RemoteOK processes rows after twenty handled jobs in its full response", async () => {
  const items = await remoteok.search({ limit: 1,
    isHandled: (role) => role.externalId !== "late",
    fetchImpl: async () => new Response(JSON.stringify([
      { legal: "metadata" },
      ...Array.from({ length: 25 }, (_, index) => ({
        id: index === 24 ? "late" : `handled-${index}`,
        position: "Example Platform Engineer", company: "Example",
        url: `https://remoteok.com/jobs/${index}`
      }))
    ])) });
  assert.deepEqual(items.map((item) => item.externalId), ["late"]);
});

test("Arbeitnow follows a bounded next page when page one is handled", async () => {
  const pages = [];
  const items = await arbeitnow.search({ limit: 1,
    isHandled: (role) => role.externalId !== "late",
    fetchImpl: async (url) => {
      const page = Number(new URL(url).searchParams.get("page") ?? 1);
      pages.push(page);
      const data = page === 1 ? Array.from({ length: 25 }, (_, index) => ({
        slug: `handled-${index}`, title: "Example Platform Engineer",
        url: `https://www.arbeitnow.com/jobs/${index}`
      })) : [{ slug: "late", title: "Example Platform Engineer",
        url: "https://www.arbeitnow.com/jobs/late" }];
      return new Response(JSON.stringify({ data, links: {
        next: page === 1 ? "https://www.arbeitnow.com/api/job-board-api?page=2" : null
      } }));
    } });
  assert.deepEqual(pages, [1, 2]);
  assert.deepEqual(items.map((item) => item.externalId), ["late"]);
});

test("Arbeitnow records a page cap instead of claiming exhaustion", async () => {
  const reasons = [];
  const items = await arbeitnow.search({ limit: 1,
    isHandled: () => true,
    onError: (entry) => reasons.push(entry.reason),
    fetchImpl: async (url) => {
      const page = Number(new URL(url).searchParams.get("page") ?? 1);
      return new Response(JSON.stringify({ data: [{ slug: `handled-${page}`,
        title: "Example Platform Engineer", url: `https://www.arbeitnow.com/jobs/${page}` }],
      links: { next: `https://www.arbeitnow.com/api/job-board-api?page=${page + 1}` } }));
    } });
  assert.deepEqual(items, []);
  assert.deepEqual(reasons, ["partial_page_cap"]);
});

test("Arbeitnow rejects an unsafe next-page URL without fetching it", async () => {
  const fetched = [];
  const reasons = [];
  const items = await arbeitnow.search({ limit: 2,
    onError: (entry) => reasons.push(entry.reason),
    fetchImpl: async (url) => {
      fetched.push(url);
      return new Response(JSON.stringify({ data: [{ slug: "one",
        title: "Example Platform Engineer", url: "https://www.arbeitnow.com/jobs/one" }],
      links: { next: "https://untrusted.example.test/jobs" } }));
    } });
  assert.equal(items.length, 1);
  assert.equal(fetched.length, 1);
  assert.deepEqual(reasons, ["invalid_next_page"]);
});

test("Jobicy stops after a blocked query and keeps earlier results", async () => {
  let requests = 0;
  const reasons = [];
  const items = await jobicy.search({ limit: 5, profile,
    onError: (entry) => reasons.push(entry.reason),
    fetchImpl: async () => {
      requests += 1;
      if (requests === 1) return new Response(JSON.stringify({ jobs: [{ id: "one",
        jobTitle: "Example Platform Engineer", companyName: "Example",
        url: "https://jobicy.com/jobs/one" }] }));
      return new Response("rate limited", { status: 429 });
    } });
  assert.deepEqual(items.map((item) => item.externalId), ["one"]);
  assert.equal(requests, 2);
  assert.deepEqual(reasons, ["partial_fetch_failure"]);
});
