import assert from "node:assert/strict";
import test from "node:test";
import { createUrlPolicy } from "../worker/url-policy.js";

test("URL policy allows configured application hosts and public subresources", () => {
  const policy = createUrlPolicy({ WORKER_ALLOWED_DOMAINS: "boards.greenhouse.io" });
  assert.equal(policy.assertAllowed("https://boards.greenhouse.io/example").hostname, "boards.greenhouse.io");
  assert.equal(policy.assertNetworkSafe("https://cdn.example.com/file.js").hostname, "cdn.example.com");
});

test("default URL policy allows hosted Google application forms", () => {
  const policy = createUrlPolicy({ WORKER_ALLOWED_DOMAINS: "" });
  assert.equal(policy.assertAllowed("https://docs.google.com/forms/d/e/example/viewform").hostname, "docs.google.com");
});

test("URL policy rejects local, literal-IP, and unlisted navigation targets", () => {
  const policy = createUrlPolicy({ WORKER_ALLOWED_DOMAINS: "boards.greenhouse.io" });
  assert.throws(() => policy.assertAllowed("http://localhost:3000"));
  assert.throws(() => policy.assertNetworkSafe("https://127.0.0.1/private"));
  assert.throws(() => policy.assertAllowed("https://example.com/apply"), /not allowed/);
});

test("configured exact domains are scoped and private DNS answers are rejected", async () => {
  const publicPolicy = createUrlPolicy({ WORKER_ALLOWED_DOMAINS: "careers.example.com" },
    async () => [{ address: "8.8.8.8", family: 4 }]);
  assert.equal(publicPolicy.assertAllowed("https://careers.example.com/apply").hostname,
    "careers.example.com");
  assert.equal(publicPolicy.assertAllowed("https://boards.greenhouse.io/example").hostname,
    "boards.greenhouse.io");
  assert.throws(() => publicPolicy.assertAllowed("https://other.example.com"), /not allowed/);
  await publicPolicy.assertPublic("https://careers.example.com/apply");

  const privatePolicy = createUrlPolicy({}, async () => [{ address: "10.0.0.5", family: 4 }]);
  await assert.rejects(privatePolicy.assertPublic("https://careers.example.com"), /public address/);
});
