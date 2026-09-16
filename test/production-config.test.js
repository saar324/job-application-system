import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);

test("production environment splitter withholds API and vault authority from worker", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-env-test-"));
  const source = path.join(directory, "legacy.env");
  const server = path.join(directory, "server.env");
  const worker = path.join(directory, "worker.env");
  await writeFile(source, [
    "JOB_SERVER_TOKENS_FILE=/secret/tokens.json",
    "JOB_SERVER_PROFILES_FILE=/secret/profiles.json",
    "APPLICATION_WEBHOOK_TOKEN=shared-secret",
    "APPLICATION_WEBHOOK_URL=http://127.0.0.1:4320/v1/submit",
    "WORKER_TOKEN=shared-secret",
    "WORKER_ARTIFACTS=/worker/artifacts",
    "JOB_SERVER_CREDENTIAL_VAULTS=/secret/vaults"
  ].join("\n"));
  await execute(process.execPath, ["scripts/split-production-env.js", source, server, worker]);
  const serverRaw = await readFile(server, "utf8");
  const workerRaw = await readFile(worker, "utf8");
  assert.match(serverRaw, /JOB_SERVER_TOKENS_FILE/);
  assert.match(serverRaw, /JOB_SERVER_CREDENTIAL_VAULTS/);
  assert.match(workerRaw, /WORKER_TOKEN/);
  assert.doesNotMatch(workerRaw, /TOKENS_FILE|PROFILES_FILE|CREDENTIAL_VAULTS|APPLICATION_WEBHOOK_TOKEN/);
});

test("deployment migrates the profile as its owning service account", async () => {
  const script = await readFile("scripts/deploy-systemd.sh", "utf8");
  assert.match(
    script,
    /runuser -u jobapp-api -- node "\$runtime_root\/scripts\/migrate-profile-settings\.js"/,
    "running the migration as root would replace the private profile with a root-owned file"
  );
});
