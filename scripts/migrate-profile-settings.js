#!/usr/bin/env node
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const file = path.resolve(process.argv[2] ?? "/var/lib/job-application/profiles.json");
const document = JSON.parse(await readFile(file, "utf8"));
for (const profile of document.profiles ?? []) {
  profile.preferences ??= {};
  profile.preferences.fullTime ??= {};
  profile.preferences.freelance ??= {};
  profile.preferences.fullTime.submissionApproval ??= "always";
  profile.preferences.freelance.submissionApproval ??= "always";
}
const temporary = `${file}.${process.pid}.tmp`;
await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
await chmod(temporary, 0o600);
await rename(temporary, file);
