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
  assert.ok(
    script.indexOf('chown jobapp-api:jobapply "$profiles_file"')
      < script.indexOf('runuser -u jobapp-api -- node "$runtime_root/scripts/migrate-profile-settings.js"'),
    "the private profile must be readable by the service account before migration"
  );
});

test("production environment updater replaces development paths with isolated absolute paths", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-production-env-test-"));
  const environment = path.join(directory, "env");
  await writeFile(environment, [
    "JOB_SERVER_CONFIG=./config/default.json",
    "JOB_SERVER_DATA=./data/state.json",
    "JOB_SERVER_PROFILES_FILE=./config/profiles.json",
    "JOB_SERVER_TOKENS_FILE=./data/tokens.json",
    "APPLICATION_WEBHOOK_TOKEN=shared-secret",
    "WORKER_TOKEN=shared-secret",
    "JOB_SERVER_ALLOWED_DOCUMENT_ROOTS=/srv/private-applicant-documents"
  ].join("\n"));
  await execute(process.execPath, ["scripts/update-production-env.js", environment]);
  const output = await readFile(environment, "utf8");
  assert.match(output, /JOB_SERVER_CONFIG=\/etc\/job-application\/config\.json/);
  assert.match(output, /JOB_SERVER_DATA=\/var\/lib\/job-application\/state\.json/);
  assert.match(output, /JOB_SERVER_PROFILES_FILE=\/var\/lib\/job-application\/profiles\.json/);
  assert.match(output, /JOB_SERVER_TOKENS_FILE=\/var\/lib\/job-application\/tokens\.json/);
  assert.match(output, /AUTH_DISABLED=false/);
  assert.match(output, /JOB_SERVER_ALLOWED_DOCUMENT_ROOTS=\/srv\/private-applicant-documents/);
});

test("compose keeps private API state away from the worker and avoids host IPC", async () => {
  const compose = await readFile("compose.yaml", "utf8");
  assert.match(compose, /JOB_SERVER_CONFIG: \/app\/config\/local\.json/);
  assert.match(compose, /job-documents:\/app\/data\/documents:ro/);
  assert.match(compose, /WORKER_DOCUMENT_ROOT: \/app\/data\/documents/);
  assert.match(compose, /shm_size: "1gb"/);
  assert.doesNotMatch(compose, /ipc:\s*host/);
  const workerSection = compose.split("\n  application-worker:")[1].split("\nvolumes:")[0];
  assert.doesNotMatch(workerSection, /^\s*- \.\/data:\/app\/data\s*$/m);
  assert.doesNotMatch(workerSection, /^\s*env_file:/m);
});
