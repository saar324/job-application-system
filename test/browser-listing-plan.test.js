import assert from "node:assert/strict";
import test from "node:test";
import { browserListingPlan } from "../src/discovery/browser-listing-plan.js";

test("reviewed same-origin listing pages rotate across source cycles", () => {
  const source = { id: "sample-board", url: "https://jobs.example.test/legacy",
    roleListingUrls: ["https://jobs.example.test/category/alpha",
      "https://jobs.example.test/category/beta"] };
  assert.equal(browserListingPlan(source, 0).url, source.roleListingUrls[0]);
  assert.equal(browserListingPlan(source, 1).url, source.roleListingUrls[1]);
  assert.equal(browserListingPlan(source, 2).url, source.roleListingUrls[0]);
  assert.equal(browserListingPlan(source, 0).origin, "configured_role_page_rotation");
});

test("unreviewed, cross-origin, or non-HTTPS choices do not replace a catalog URL", () => {
  const source = { id: "sample-board", url: "https://jobs.example.test/legacy",
    roleListingUrls: ["https://elsewhere.example.test/roles", "http://jobs.example.test/roles",
      "invalid", "https://jobs.example.test/category/valid"] };
  assert.equal(browserListingPlan(source, 0).url,
    "https://jobs.example.test/category/valid");
  assert.deepEqual(browserListingPlan({ ...source, roleListingUrls: source.roleListingUrls.slice(0, 3) }),
    { url: source.url, origin: "catalog", roleFamily: null });
  assert.deepEqual(browserListingPlan({ id: source.id, url: source.url }),
    { url: source.url, origin: "catalog", roleFamily: null });
});
