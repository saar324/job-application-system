import assert from "node:assert/strict";
import test from "node:test";
import { resolveEmployerApplicationUrl } from "../src/discovery/application-destination.js";

test("qualified Arbeitnow listings resolve through the fixed board redirect without opening the employer form", async () => {
  const requests = [];
  const opportunity = { source: "arbeitnow", externalId: "role-1",
    listingUrl: "https://www.arbeitnow.com/jobs/companies/example/role-1",
    applyUrl: "https://www.arbeitnow.com/jobs/companies/example/role-1",
    applicationDestinationPending: true };
  const resolved = await resolveEmployerApplicationUrl(opportunity, async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(null, { status: 302,
      headers: { location: "https://jobs.ashbyhq.com/example/11111111-1111-4111-8111-111111111111/application" } });
  });
  assert.equal(resolved.applicationDestinationPending, false);
  assert.equal(resolved.applyUrl,
    "https://jobs.ashbyhq.com/example/11111111-1111-4111-8111-111111111111/application");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.method, "HEAD");
  assert.equal(requests[0].options.redirect, "manual");
});

test("destination resolution rejects insecure redirects and does not invent unsupported board routes", async () => {
  const base = { externalId: "role-2", listingUrl: "https://remoteok.com/remote-jobs/role-2",
    applyUrl: "https://remoteok.com/remote-jobs/role-2", applicationDestinationPending: true };
  const insecure = await resolveEmployerApplicationUrl({ ...base, source: "remoteok" }, async () =>
    new Response(null, { status: 302, headers: { location: "http://employer.example/apply" } }));
  assert.equal(insecure.applicationDestinationPending, true);
  let called = false;
  const unsupported = await resolveEmployerApplicationUrl({ ...base, source: "himalayas" }, async () => {
    called = true; return new Response();
  });
  assert.equal(unsupported.applicationDestinationPending, true);
  assert.equal(called, false);
});
