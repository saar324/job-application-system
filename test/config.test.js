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
