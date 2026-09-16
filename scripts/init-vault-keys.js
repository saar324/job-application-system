#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const profilesFile = path.resolve(process.argv[2] ?? "/var/lib/job-application/profiles.json");
const keysFile = path.resolve(process.argv[3] ?? "/etc/job-application/vault-keys.json");
const profiles = JSON.parse(await readFile(profilesFile, "utf8")).profiles ?? [];
let keys = {};
try { keys = JSON.parse(await readFile(keysFile, "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
for (const profile of profiles) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(profile.id)) throw new Error("invalid profile ID in profile store");
  if (!keys[profile.id]) keys[profile.id] = randomBytes(32).toString("base64");
}
const temporary = `${keysFile}.${process.pid}.tmp`;
await writeFile(temporary, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
await chmod(temporary, 0o600);
await rename(temporary, keysFile);
