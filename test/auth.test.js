import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAuthenticator } from "../src/auth.js";

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
