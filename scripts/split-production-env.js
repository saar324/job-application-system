#!/usr/bin/env node
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { SOURCE_CREDENTIAL_ENV_NAMES } from "../src/discovery/source-credentials.js";

const source = path.resolve(process.argv[2] ?? "/etc/job-application/env");
const serverFile = path.resolve(process.argv[3] ?? "/etc/job-application/server.env");
const workerFile = path.resolve(process.argv[4] ?? "/etc/job-application/worker.env");
const values = new Map();
for (const line of (await readFile(source, "utf8")).split(/\r?\n/)) {
  if (!line || line.trimStart().startsWith("#")) continue;
  const separator = line.indexOf("=");
  if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1));
}
const serverKeys = [
  "HOST", "PORT", "JOB_SERVER_CONFIG", "JOB_SERVER_DATA", "JOB_SERVER_DATABASE",
  "JOB_SERVER_DATABASE_BUSY_TIMEOUT_MS", "JOB_SERVER_PROFILES_FILE",
  "JOB_SERVER_TOKENS_JSON", "JOB_SERVER_TOKENS_FILE", "AUTH_DISABLED",
  "APPLICATION_WEBHOOK_URL", "APPLICATION_WEBHOOK_TOKEN", "JOB_SERVER_DOCUMENT_STAGING",
  "JOB_SERVER_ALLOWED_DOCUMENT_ROOTS", "JOB_SERVER_DOCUMENT_MAX_BYTES", "JOB_SERVER_CREDENTIAL_VAULTS"
  , "JOB_SEMANTIC_ENABLED", "JOB_SEMANTIC_ENDPOINT", "JOB_SEMANTIC_TOKEN", "JOB_SEMANTIC_MODEL",
  "JOB_SEMANTIC_TIMEOUT_MS", "JOB_SEMANTIC_MAX_CHARACTERS", "JOB_SEMANTIC_VERSION",
  ...SOURCE_CREDENTIAL_ENV_NAMES
];
const workerKeys = [
  "WORKER_TOKEN", "WORKER_HOST", "WORKER_PORT", "WORKER_ALLOWED_DOMAINS", "WORKER_ALLOW_HTTP",
  "JOB_SERVER_INTERNAL_URL",
  "WORKER_ARTIFACTS", "WORKER_DOCUMENT_ROOT", "WORKER_RECEIPTS", "WORKER_HEADLESS",
  "WORKER_HEADED_ENABLED", "WORKER_HEADED_ORIGINS", "PLAYWRIGHT_BROWSERS_PATH",
  "WORKER_ADAPTIVE_ENABLED", "WORKER_ADAPTIVE_ENDPOINT", "WORKER_ADAPTIVE_TOKEN",
  "WORKER_ADAPTIVE_PROFILES", "WORKER_ADAPTIVE_MODES", "WORKER_ADAPTIVE_DOMAINS",
  "WORKER_ADAPTIVE_KILL_SWITCH_FILE",
  "WORKER_ADAPTIVE_MAX_STEPS", "WORKER_ADAPTIVE_TIMEOUT_MS", "WORKER_ADAPTIVE_MAX_TOKENS",
  "WORKER_ADAPTIVE_MAX_COST_USD"
  , "WORKER_DRAFT_ENABLED", "WORKER_DRAFT_ENDPOINT", "WORKER_DRAFT_TOKEN", "WORKER_DRAFT_TIMEOUT_MS"
];
await secureWrite(serverFile, select(serverKeys));
await secureWrite(workerFile, select(workerKeys));

function select(keys) {
  return `${keys.filter((key) => values.has(key)).map((key) => `${key}=${values.get(key)}`).join("\n")}\n`;
}

async function secureWrite(file, contents) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
}
