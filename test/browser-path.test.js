import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { browserPathConfig, browserPathFor } from "../worker/browser-path.js";

test("headed path requires an explicit exact origin flag and rolls back to headless", () => {
  const disabled = browserPathConfig({ WORKER_HEADED_ORIGINS: "jobs.ashbyhq.com" });
  assert.equal(browserPathFor("https://jobs.ashbyhq.com/example", disabled), "default");
  const enabled = browserPathConfig({ WORKER_HEADED_ENABLED: "true",
    WORKER_HEADED_ORIGINS: "jobs.ashbyhq.com" });
  assert.equal(browserPathFor("https://jobs.ashbyhq.com/example", enabled), "headed");
  assert.equal(browserPathFor("https://other.ashbyhq.com/example", enabled), "default");
  assert.equal(enabled.defaultHeadless, true);
  assert.throws(() => browserPathConfig({ WORKER_HEADED_ENABLED: "true",
    WORKER_HEADED_ORIGINS: "*.ashbyhq.com" }), /exact hostnames/);
});

test("systemd uses the Xvfb-aware launch path and keeps its opt-in flags", async () => {
  const unit = await readFile(new URL("../deploy/systemd/job-application-worker.service", import.meta.url), "utf8");
  const script = await readFile(new URL("../worker/start-systemd.sh", import.meta.url), "utf8");
  const split = await readFile(new URL("../scripts/split-production-env.js", import.meta.url), "utf8");
  assert.match(unit, /ExecStart=\/bin\/sh worker\/start-systemd\.sh/);
  assert.match(script, /xvfb-run -a \/usr\/bin\/node worker\/server\.js/);
  assert.match(split, /WORKER_HEADED_ENABLED/);
  assert.match(split, /WORKER_HEADED_ORIGINS/);
  await promisify(execFile)("/bin/sh", ["-n", new URL("../worker/start-systemd.sh", import.meta.url).pathname]);
});
