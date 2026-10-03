import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);

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

test("compose runs only the passive loopback API", async () => {
 const compose=await readFile("compose.yaml","utf8");
 assert.match(compose,/127\.0\.0\.1:4310:4310/);
 assert.doesNotMatch(compose,/application-worker|WEBHOOK|WORKER_|depends_on/);
 const unit=await readFile("deploy/systemd/job-application-server.service","utf8");
 assert.doesNotMatch(unit,/job-application-worker|LoadCredential/);
});
