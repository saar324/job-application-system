import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHttpServer } from "../src/http.js";
import { JsonStore } from "../src/store.js";
import { ApplicationService } from "../src/service.js";
import { SimulationAdapter } from "../src/adapters/simulation.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-http-"));
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  const config = { defaultMode: "full_time", modes: { full_time: {
    minimumScore: 75, autoApply: true, dailyApplicationCap: 8, requireConfirmationFor: []
  } } };
  const service = new ApplicationService({ store, config, adapter: new SimulationAdapter() });
  const profiles = { async get(profileId) { return { id: profileId }; },
    async status() { return { readyToApply: true, missingForApplications: [] }; } };
  const campaignId = "11111111-1111-4111-8111-111111111111";
  const discovery = {
    async scan() { return { items: [] }; },
    async startCampaign(input, identity) {
      return service.createCampaign({ id: campaignId, target: input.target ?? 10,
        reserve: input.reserve ?? 10, mode: "full_time" }, identity);
    }
  };
  const authenticate = (request) => request.headers.authorization === "Bearer profile-one-token"
    ? { actorId: "agent-one", profileId: "profile-one" } : null;
  const server = createHttpServer({ service, discovery, profiles, authenticate, config });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, service, campaignId, base: `http://127.0.0.1:${server.address().port}` };
}

test("HTTP authentication fixes profile identity and mutation retries are idempotent", async () => {
  const { server, service, base } = await fixture();
  try {
    const request = () => fetch(`${base}/v1/direct-applications`, {
      method: "POST", headers: { authorization: "Bearer profile-one-token", "content-type": "application/json",
        "idempotency-key": "direct-request-1" },
      body: JSON.stringify({ url: "https://careers.example.test/apply", profileId: "profile-two" })
    });
    const first = await request(); const firstBody = await first.json();
    const second = await request(); const secondBody = await second.json();
    assert.equal(first.status, 202); assert.equal(second.status, 202);
    assert.equal(firstBody.application.id, secondBody.application.id);
    assert.equal(service.list("opportunities", "profile-one").length, 1);
    assert.equal(service.list("opportunities", "profile-two").length, 0);
    await service.waitForIdle();
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("HTTP idempotency serializes concurrent retries and rejects changed payloads", async () => {
  const { server, service, base } = await fixture();
  let executions = 0;
  const directApplication = service.directApplication.bind(service);
  service.directApplication = async (...args) => {
    executions += 1;
    await new Promise((resolve) => setTimeout(resolve, 40));
    return directApplication(...args);
  };
  const send = (url) => fetch(`${base}/v1/direct-applications`, {
    method: "POST", headers: { authorization: "Bearer profile-one-token", "content-type": "application/json",
      "idempotency-key": "concurrent-request-key" }, body: JSON.stringify({ url })
  });
  try {
    const [left, right] = await Promise.all([
      send("https://careers.example.test/one"), send("https://careers.example.test/one")
    ]);
    assert.equal(left.status, 202);
    assert.equal(right.status, 202);
    assert.equal(executions, 1);
    const changed = await send("https://careers.example.test/two");
    assert.equal(changed.status, 409);
    assert.match((await changed.json()).error, /different request data/);
    await service.waitForIdle();
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("HTTP routes reject missing auth, malformed JSON, and short idempotency keys", async () => {
  const { server, base } = await fixture();
  try {
    assert.equal((await fetch(`${base}/v1/applications`)).status, 401);
    assert.equal((await fetch(`${base}/v1/direct-applications`, { method: "POST",
      headers: { authorization: "Bearer profile-one-token", "content-type": "application/json" }, body: "[]" })).status, 400);
    assert.equal((await fetch(`${base}/v1/direct-applications`, { method: "POST",
      headers: { authorization: "Bearer profile-one-token", "content-type": "application/json", "idempotency-key": "tiny" },
      body: JSON.stringify({ url: "https://careers.example.test/apply" }) })).status, 400);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("application metrics require profile authentication", async () => {
  const { server, base } = await fixture();
  try {
    assert.equal((await fetch(`${base}/v1/application-metrics`)).status, 401);
    const response = await fetch(`${base}/v1/application-metrics`, {
      headers: { authorization: "Bearer profile-one-token" }
    });
    assert.equal(response.status, 200);
    const metrics = await response.json();
    assert.equal(metrics.attempts, 0);
    assert.equal(metrics.worker.activeMs.medianMs, null);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("campaign HTTP start is idempotent and campaign reads stay profile-bound", async () => {
  const { server, service, campaignId, base } = await fixture();
  const send = () => fetch(`${base}/v1/campaigns`, {
    method: "POST", headers: { authorization: "Bearer profile-one-token", "content-type": "application/json",
      "idempotency-key": "campaign-request-key" },
    body: JSON.stringify({ target: 10, reserve: 5 })
  });
  try {
    const first = await send(); const replay = await send();
    assert.equal(first.status, 202); assert.equal(replay.status, 202);
    assert.equal((await first.json()).campaignId, campaignId);
    assert.equal((await replay.json()).campaignId, campaignId);
    assert.equal(service.listCampaigns("profile-one").length, 1);
    assert.equal(service.listCampaigns("profile-two").length, 0);
    const status = await fetch(`${base}/v1/campaigns/${campaignId}`, {
      headers: { authorization: "Bearer profile-one-token" }
    });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).target, 10);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("Streamable HTTP MCP uses the same profile-bound bearer authentication", async () => {
  const { server, base } = await fixture();
  const client = new Client({ name: "http-test", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: "Bearer profile-one-token" } }
    }));
    const status = await client.callTool({ name: "profile_status", arguments: {} });
    assert.equal(status.structuredContent.readyToApply, true);
  } finally {
    await client.close().catch(() => undefined);
    await new Promise((resolve) => server.close(resolve));
  }
});
