import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAuthenticator } from "../src/auth.js";
import { hashedTokenKey } from "../src/token-keys.js";

test("bearer tokens resolve to one fixed identity", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-auth-test-"));
  const tokenFile = path.join(directory, "tokens.json");
  await writeFile(tokenFile, JSON.stringify({
    "secret-one": { actorId: "applicant-one-bot", profileId: "applicant-one", roles: ["agent"] }
  }));
  const authenticate = createAuthenticator({ JOB_SERVER_TOKENS_FILE: tokenFile });
  assert.deepEqual(authenticate({ headers: { authorization: "Bearer secret-one" } }), {
    actorId: "applicant-one-bot", profileId: "applicant-one", roles: ["agent"]
  });
  assert.equal(authenticate({ headers: { authorization: "Bearer wrong" } }), null);

  await writeFile(tokenFile, JSON.stringify({
    "secret-two": { actorId: "applicant-two-bot", profileId: "applicant-two", roles: ["agent"] }
  }));
  assert.equal(authenticate({ headers: { authorization: "Bearer secret-one" } }), null);
  assert.equal(authenticate({ headers: { authorization: "Bearer secret-two" } }).profileId, "applicant-two");
});

test("hashed owner and agent keys authenticate their exact roles beside legacy keys", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-auth-hash-"));
  const tokenFile = path.join(directory, "tokens.json");
  await writeFile(tokenFile, JSON.stringify({
    [hashedTokenKey("owner-secret")]: { actorId: "owner", profileId: "person-one", roles: ["owner"] },
    [hashedTokenKey("agent-secret")]: { actorId: "agent", profileId: "person-one", roles: ["agent"] },
    "legacy-secret": { actorId: "legacy", profileId: "person-two", roles: ["agent"] }
  }));
  const authenticate = createAuthenticator({ JOB_SERVER_TOKENS_FILE: tokenFile });
  assert.deepEqual(authenticate({ headers: { authorization: "Bearer owner-secret" } }).roles, ["owner"]);
  assert.deepEqual(authenticate({ headers: { authorization: "Bearer agent-secret" } }).roles, ["agent"]);
  assert.equal(authenticate({ headers: { authorization: "Bearer legacy-secret" } }).profileId, "person-two");
  assert.equal(authenticate({ headers: { authorization: `Bearer ${hashedTokenKey("owner-secret")}` } }), null);
  assert.equal(authenticate({ headers: { authorization: "Bearer wrong" } }), null);
});

test("malformed hash keys and duplicate plaintext/hash credentials fail closed", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-auth-invalid-"));
  const tokenFile = path.join(directory, "tokens.json");
  await writeFile(tokenFile, JSON.stringify({ "sha256:abcd": { profileId: "one" } }));
  assert.throws(() => createAuthenticator({ JOB_SERVER_TOKENS_FILE: tokenFile }), /malformed sha256 key/);
  await writeFile(tokenFile, JSON.stringify({
    "same-secret": { profileId: "one" },
    [hashedTokenKey("same-secret")]: { profileId: "two" }
  }));
  assert.throws(() => createAuthenticator({ JOB_SERVER_TOKENS_FILE: tokenFile }), /duplicate credentials/);
});
