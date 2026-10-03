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
