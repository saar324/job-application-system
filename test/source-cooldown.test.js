import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { sourceCooldown } from "../src/discovery/source-cooldown.js";
import { DiscoveryService } from "../src/discovery/service.js";
import { createHttpServer } from "../src/http.js";
import { ApplicationService } from "../src/service.js";
import { JsonStore } from "../src/store.js";

const identity = { actorId: "agent", profileId: "one", roles: ["agent"] };
const execute = promisify(execFile);
const campaignInput = (id) => ({ id, target: 1, reserve: 0, mode: "full_time",
  sources: [], fallbackSources: ["board"], reserveOnly: true });

test("source cooldowns are profile scoped, bounded, and not extended by coverage skips", () => {
  const at = "2026-09-23T00:00:00.000Z";
  const event = (details) => ({ at, profileId: "one", action: "campaign.source_scanned",
    details: { sourceId: "board", completed: true, ...details } });
  for (const [details, duration] of [
    [{ rateLimited: true }, 6 * 60 * 60_000],
    [{ challenge: true }, 24 * 60 * 60_000],
    [{ timedOut: true }, 30 * 60_000]
  ]) {
    const events = [event(details), { ...event({ cooldownSkipped: true }),
      at: "2026-09-23T01:00:00.000Z" }];
    assert.equal(Date.parse(sourceCooldown(events, "one", "board", Date.parse(at))?.until),
      Date.parse(at) + duration);
    assert.equal(sourceCooldown(events, "one", "board", Date.parse(at) + duration), null);
    assert.equal(sourceCooldown(events, "two", "board", Date.parse(at)), null);
    assert.equal(sourceCooldown(events, "one", "another", Date.parse(at)), null);
  }
  assert.equal(sourceCooldown([event({ rateLimited: true }), { ...event({}),
    at: "2026-09-23T01:00:00.000Z" }], "one", "board", Date.parse(at) + 2 * 60 * 60_000), null);
});

test("a restarted reserve run covers a cooling source without browser or official requests", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "source-cooldown-"));
  const file = path.join(directory, "state.json");
  const config = { defaultMode: "full_time", modes: { full_time: { minimumScore: 0 } } };
  const firstStore = await new JsonStore(file).init();
  const first = new ApplicationService({ store: firstStore, config, adapter: {} });
  const firstId = "11111111-1111-4111-8111-111111111111";
  await first.createCampaign(campaignInput(firstId), identity);
  await first.recordCampaignSourceScan(firstId, { sourceId: "board", found: 0, qualifying: 0,
    excluded: 0, handledFiltered: 0, selected: 0, completed: true, pagesVisited: 1,
    requestsMade: 1, rateLimited: true }, identity);

  const restartedStore = await new JsonStore(file).init();
  const restarted = new ApplicationService({ store: restartedStore, config, adapter: {} });
  const secondId = "22222222-2222-4222-8222-222222222222";
  const otherId = "33333333-3333-4333-8333-333333333333";
  await restarted.createCampaign(campaignInput(secondId), identity);
  await restarted.createCampaign(campaignInput(otherId), { actorId: "other", profileId: "two" });
  const before = restarted.campaignStatus(secondId, "one");
  assert.equal(before.sourceCoverage.cooldowns.board.reason, "rate_limited");
  assert.equal(restarted.campaignStatus(otherId, "two").sourceCoverage.cooldowns.board, undefined);

  const discovery = new DiscoveryService({ applicationService: restarted,
    profiles: { async get() { throw new Error("profile lookup should not run"); } }, config,
    fetchImpl: async () => { throw new Error("network should not run"); } });
  const covered = await discovery.addCampaignSourceResults(secondId, { sourceId: "board", items: [],
    completed: true, cooldownSkipped: true, pagesVisited: 0, requestsMade: 0 }, identity);
  assert.deepEqual(covered.sourceCoverage.fallbackRemaining, []);
  assert.equal(covered.sourceCoverage.plannedCount, 1);
  assert.equal(covered.sourceCoverage.scans[0].requestsMade, 0);
  assert.equal(covered.sourceCoverage.scans[0].cooldownReason, "rate_limited");
  assert.equal(covered.sourceCoverage.health[0].status, "cooldown");
  assert.equal(covered.applications.length, 0);
  await assert.rejects(() => discovery.addCampaignSourceResults(otherId, { sourceId: "board", items: [],
    completed: true, cooldownSkipped: true, pagesVisited: 0, requestsMade: 0 },
  { actorId: "other", profileId: "two" }), /active hold/);

  const thirdId = "44444444-4444-4444-8444-444444444444";
  await restarted.createCampaign(campaignInput(thirdId), identity);
  const catalog = path.join(directory, "catalog.json");
  await writeFile(catalog, JSON.stringify({ autonomousDiscovery: { visibleBrowserSources: [
    { id: "board", url: "https://browser.invalid/jobs" }
  ] } }));
  const server = createHttpServer({ service: restarted, discovery,
    profiles: {}, config, authenticate: (request) => request.headers.authorization === "Bearer test-token"
      ? identity : null });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const script = fileURLToPath(new URL("../scripts/run-browser-source-campaign.js", import.meta.url));
    const { stdout } = await execute(process.execPath, [script, "--campaign", thirdId,
      "--catalog", catalog, "--server", `http://127.0.0.1:${server.address().port}`,
      "--channel", "intentionally-missing-browser"], { env: { ...process.env,
      JOB_SERVER_TOKEN: "test-token" }, timeout: 10_000 });
    assert.match(stdout, /"status":"cooldown"/);
    const third = restarted.campaignStatus(thirdId, "one");
    assert.equal(third.sourceCoverage.scans[0].requestsMade, 0);
    assert.equal(third.sourceCoverage.health[0].status, "cooldown");
    assert.equal(third.applications.length, 0);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
