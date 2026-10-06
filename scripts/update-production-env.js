#!/usr/bin/env node
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const file = path.resolve(process.argv[2] ?? "/etc/job-application/env");
const raw = await readFile(file, "utf8");
const values = new Map();
for (const line of raw.split(/\r?\n/)) {
  if (!line || line.trimStart().startsWith("#")) continue;
  const separator = line.indexOf("=");
  if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1));
}
const updates = {
  HOST: "127.0.0.1",
  PORT: "4310",
  JOB_SERVER_CONFIG: "/etc/job-application/config.json",
  JOB_SERVER_DATA: "/var/lib/job-application/state.json",
  JOB_SERVER_DATABASE: "/var/lib/job-application/state.sqlite",
  JOB_SERVER_PROFILES_FILE: "/var/lib/job-application/profiles.json",
  JOB_SERVER_TOKENS_FILE: "/var/lib/job-application/tokens.json",
  AUTH_DISABLED: "false",
};
for (const [key, value] of Object.entries(updates)) values.set(key, value);
for (const key of [...values.keys()]) {
  if (/^(WORKER_|APPLICATION_WEBHOOK_|APPLICATION_WORKER_|PLAYWRIGHT_)/.test(key)
    || ["JOB_SERVER_DOCUMENT_STAGING", "JOB_SERVER_INTERNAL_URL"].includes(key)) values.delete(key);
}
if (!values.get("JOB_SERVER_ALLOWED_DOCUMENT_ROOTS")) {
  throw new Error("JOB_SERVER_ALLOWED_DOCUMENT_ROOTS must point to a private document directory");
}
const temporary = `${file}.${process.pid}.tmp`;
await writeFile(temporary, `${[...values].map(([key, value]) => `${key}=${value}`).join("\n")}\n`, { mode: 0o600 });
await chmod(temporary, 0o600);
await rename(temporary, file);
