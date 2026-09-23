#!/usr/bin/env node
// Run as the token-file owner after stopping processes that write the token map.
// No plaintext backup is created by this migration.
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { digestFromTokenKey, hashedTokenKey } from "../src/token-keys.js";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--file" || !path.isAbsolute(args[1])) {
  process.stderr.write("usage: node scripts/hash-token-map.js --file /absolute/private/tokens.json\n");
  process.exit(2);
}

const file = args[1];
let temporary;
let temporaryCreated = false;
let replaced = false;
try {
  const source = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let original;
  let contents;
  try {
    original = await source.stat();
    if (!original.isFile() || original.nlink !== 1) throw new Error("token map must be a regular file with one link");
    contents = await source.readFile({ encoding: "utf8" });
  } finally { await source.close(); }
  let map;
  try { map = JSON.parse(contents); }
  catch { throw new Error("token map JSON is invalid"); }
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    throw new Error("token map must be a JSON object");
  }
  const converted = Object.create(null);
  let hashed = 0;
  for (const [key, identity] of Object.entries(map)) {
    const digest = digestFromTokenKey(key);
    const hashKey = /^sha256:/i.test(key) ? `sha256:${digest.toString("hex")}` : hashedTokenKey(key);
    if (Object.hasOwn(converted, hashKey)) throw new Error("token map contains duplicate credentials");
    converted[hashKey] = identity;
    if (!/^sha256:/i.test(key)) hashed += 1;
  }
  if (hashed === 0) {
    process.stdout.write(`${JSON.stringify({ entries: Object.keys(converted).length, converted: 0 })}\n`);
    process.exit(0);
  }
  temporary = path.join(path.dirname(file), `.${path.basename(file)}.hash-${process.pid}-${randomBytes(6).toString("hex")}`);
  const output = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
    | constants.O_NOFOLLOW, 0o600);
  temporaryCreated = true;
  try {
    if (original.uid !== process.getuid?.() || original.gid !== process.getgid?.()) {
      await output.chown(original.uid, original.gid);
    }
    await output.writeFile(`${JSON.stringify(converted, null, 2)}\n`);
    await output.chmod(0o600);
    await output.sync();
  } finally { await output.close(); }
  const current = await lstat(file);
  if (!current.isFile() || current.nlink !== 1 || current.dev !== original.dev
    || current.ino !== original.ino || current.size !== original.size
    || current.mtimeMs !== original.mtimeMs) {
    throw new Error("token map changed during migration; retry after stopping token writers");
  }
  await rename(temporary, file);
  replaced = true;
  temporary = undefined;
  temporaryCreated = false;
  try {
    const directory = await open(path.dirname(file), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } catch {
    throw new Error("token map was replaced, but directory sync failed; inspect file before retrying");
  }
  process.stdout.write(`${JSON.stringify({ entries: Object.keys(converted).length, converted: hashed })}\n`);
} catch (error) {
  if (temporaryCreated && temporary) await unlink(temporary).catch(() => undefined);
  process.stderr.write(`${replaced && !error.message.startsWith("token map was replaced")
    ? "token map was replaced; inspect file before retrying" : error.message}\n`);
  process.exitCode = 1;
}
