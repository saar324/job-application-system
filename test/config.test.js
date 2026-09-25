import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";

test("configuration rejects an adapter typo instead of silently simulating", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-config-test-"));
  const file = path.join(directory, "config.json");
  await writeFile(file, JSON.stringify({ execution: { adapter: "playwrite" } }));
  await assert.rejects(loadConfig({ JOB_SERVER_CONFIG: file }), /unsupported execution adapter/);
});

test("public discovery starter enables feeds only in simulation", async () => {
  const config = await loadConfig({ JOB_SERVER_CONFIG: path.resolve("config/discovery.example.json") });
  assert.equal(config.execution.adapter, "simulation");
  for (const mode of ["full_time", "freelance"]) {
    assert.deepEqual(config.modes[mode].sources,
      ["remoteok", "arbeitnow", "jobicy", "himalayas"]);
    assert.equal(config.modes[mode].autoApply, false);
    assert.equal(config.modes[mode].autoApplyDiscovered, false);
    assert.equal(config.modes[mode].submissionApproval, "always");
  }
  assert.deepEqual(config.discovery.sourceOptions.ashby.boards, []);
  assert.deepEqual(config.discovery.sourceOptions.greenhouse.boards, []);
  assert.deepEqual(config.discovery.sourceOptions.lever.sites, []);
});
