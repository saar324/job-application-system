import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createProfileMcpServer } from "../src/mcp.js";
import { JsonStore } from "../src/store.js";
import { ApplicationService } from "../src/service.js";
import { SimulationAdapter } from "../src/adapters/simulation.js";

test("MCP tools are profile-bound, typed, and idempotent", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-mcp-"));
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  const config = { defaultMode: "full_time", modes: { full_time: {
    minimumScore: 75, autoApply: true, dailyApplicationCap: 8, requireConfirmationFor: []
  } } };
  const service = new ApplicationService({ store, config, adapter: new SimulationAdapter() });
  const identity = { actorId: "agent-one", profileId: "profile-one" };
  const profiles = { async status() { return { readyToApply: true, missingForApplications: [] }; } };
  const discovery = { async scan() { return { mode: "full_time", sources: [], found: 0,
    qualifying: 0, excluded: 0, errors: [], items: [] }; } };
  const server = createProfileMcpServer({ service, discovery, profiles, config, identity });
  const client = new Client({ name: "test-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "request_application"));
  const campaign = tools.tools.find((tool) => tool.name === "start_application_campaign");
  assert.equal(campaign.inputSchema.properties.target.maximum, 100);
  const args = { url: "https://careers.example.test/apply", idempotencyKey: "same-request-key" };
  const first = await client.callTool({ name: "request_application", arguments: args });
  const second = await client.callTool({ name: "request_application", arguments: args });
  assert.equal(first.structuredContent.applicationId, second.structuredContent.applicationId);
  assert.equal(service.list("opportunities", "profile-one").length, 1);
  assert.equal(service.list("opportunities", "profile-two").length, 0);
  await service.waitForIdle();
  await client.close(); await server.close();
});
