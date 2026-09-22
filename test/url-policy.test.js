import assert from "node:assert/strict";
import test from "node:test";
import net from "node:net";
import { PassThrough } from "node:stream";
import { classifyAddress, createUrlPolicy } from "../worker/url-policy.js";
import { createValidatedEgressProxy } from "../worker/egress-proxy.js";

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

test("IPv4-mapped IPv6 and reserved ranges are classified as non-public", () => {
  for (const address of ["::ffff:192.168.1.10", "::ffff:c0a8:010a", "::ffff:172.16.0.1",
    "::ffff:169.254.1.1", "fc00::1", "fe80::1", "2001:db8::1", "203.0.113.5"]) {
    assert.equal(classifyAddress(address), "non_public", address);
  }
  assert.equal(classifyAddress("2606:4700:4700::1111"), "public");
});

test("DNS answers are revalidated for every outbound request", async () => {
  let calls = 0;
  const policy = createUrlPolicy({}, async () => {
    calls += 1;
    return [{ address: calls === 1 ? "8.8.8.8" : "10.0.0.5", family: 4 }];
  });
  await policy.assertPublic("https://careers.example.test/apply");
  await assert.rejects(policy.assertPublic("https://careers.example.test/apply"), /public addresses/);
  assert.equal(calls, 2);
});

test("validated egress proxy refuses a CONNECT tunnel to a private DNS answer", async () => {
  const policy = createUrlPolicy({}, async () => [{ address: "192.168.1.10", family: 4 }]);
  const proxy = await createValidatedEgressProxy(policy);
  try {
    const response = await new Promise((resolve, reject) => {
      const socket = net.connect(new URL(proxy.url).port, "127.0.0.1", () => {
        socket.write("CONNECT careers.example.test:443 HTTP/1.1\r\nHost: careers.example.test\r\n\r\n");
      });
      let body = "";
      socket.on("data", (chunk) => { body += chunk; });
      socket.on("end", () => resolve(body));
      socket.on("error", reject);
    });
    assert.match(response, /403 Forbidden/);
  } finally { await proxy.close(); }
});

test("validated egress proxy closes a broken CONNECT stream without crashing", async () => {
  const policy = createUrlPolicy({}, async () => [{ address: "8.8.8.8", family: 4 }]);
  const upstream = new PassThrough();
  upstream.setTimeout = () => upstream;
  const proxy = await createValidatedEgressProxy(policy, { connectImpl: () => {
    queueMicrotask(() => upstream.emit("connect"));
    return upstream;
  } });
  try {
    const client = new PassThrough();
    const connected = new Promise((resolve) => client.on("data", (chunk) => {
      if (chunk.toString().includes("200 Connection Established")) resolve();
    }));
    proxy.server.emit("connect", { url: "careers.example.test:443" }, client, Buffer.alloc(0));
    await connected;
    assert.doesNotThrow(() => client.emit("error", new Error("write EPIPE")));
    assert.equal(upstream.destroyed, true);
  } finally { await proxy.close(); }
});
