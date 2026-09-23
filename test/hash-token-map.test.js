import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createAuthenticator } from "../src/auth.js";
import { hashedTokenKey } from "../src/token-keys.js";

const execute = promisify(execFile);

test("private token migration atomically hashes keys without exposing credentials", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-token-migration-"));
  const file = path.join(directory, "tokens.json");
  const owner = "private-owner-token";
  const agent = "private-agent-token";
  await writeFile(file, JSON.stringify({
    [owner]: { actorId: "owner", profileId: "one", roles: ["owner"] },
    [agent]: { actorId: "agent", profileId: "one", roles: ["agent"] }
  }));
  await chmod(file, 0o600);
  const authenticate = createAuthenticator({ JOB_SERVER_TOKENS_FILE: file });
  const result = await execute(process.execPath, ["scripts/hash-token-map.js", "--file", file]);
  assert.deepEqual(JSON.parse(result.stdout), { entries: 2, converted: 2 });
  assert.doesNotMatch(result.stdout + result.stderr, /private-owner-token|private-agent-token/);
  const contents = await readFile(file, "utf8");
  assert.deepEqual(Object.keys(JSON.parse(contents)), [hashedTokenKey(owner), hashedTokenKey(agent)]);
  assert.doesNotMatch(contents, /private-owner-token|private-agent-token/);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(authenticate({ headers: { authorization: `Bearer ${owner}` } }).roles, ["owner"]);
  assert.deepEqual(authenticate({ headers: { authorization: `Bearer ${agent}` } }).roles, ["agent"]);
  const again = await execute(process.execPath, ["scripts/hash-token-map.js", "--file", file]);
  assert.deepEqual(JSON.parse(again.stdout), { entries: 2, converted: 0 });
});

test("malformed or duplicate hash keys leave the original token map untouched", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-token-reject-"));
  const file = path.join(directory, "tokens.json");
  for (const input of [
    { "sha256:short": { profileId: "one" } },
    { "same-secret": { profileId: "one" },
      [hashedTokenKey("same-secret")]: { profileId: "two" } }
  ]) {
    const original = `${JSON.stringify(input)}\n`;
    await writeFile(file, original);
    await assert.rejects(execute(process.execPath, ["scripts/hash-token-map.js", "--file", file]));
    assert.equal(await readFile(file, "utf8"), original);
  }
});
