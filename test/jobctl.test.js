import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);

function executeWithInput(file, args, options, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, options);
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr })
      : reject(new Error(`jobctl exited ${code}: ${stderr}`)));
    child.stdin.end(input);
  });
}

test("jobctl lets the server decide whether a missing credential is allowed", async (context) => {
  let authorization;
  const server = createServer((request, response) => {
    authorization = request.headers.authorization;
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"profileId":"local-profile","readyToApply":false}\n');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const address = server.address();
  const { stdout } = await execute(process.execPath, ["bin/jobctl.js", "profile"], {
    env: {
      ...process.env,
      JOB_SERVER_URL: `http://127.0.0.1:${address.port}`,
      JOB_SERVER_TOKEN: "",
      JOB_SERVER_TOKEN_FILE: "/nonexistent/job-server-token"
    }
  });

  assert.equal(authorization, undefined);
  assert.equal(JSON.parse(stdout).profileId, "local-profile");
});

test("jobctl forwards a supplied campaign idempotency key", async (context) => {
  let key;
  const server = createServer((request, response) => {
    key = request.headers["idempotency-key"];
    response.writeHead(202, { "content-type": "application/json" });
    response.end('{"campaignId":"11111111-1111-4111-8111-111111111111"}\n');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const address = server.address();
  await executeWithInput(process.execPath, ["bin/jobctl.js", "campaign-start"], {
    env: { ...process.env, JOB_SERVER_URL: `http://127.0.0.1:${address.port}`, JOB_SERVER_TOKEN: "token" }
  }, '{"target":10,"idempotencyKey":"campaign-request-1"}');
  assert.equal(key, "campaign-request-1");
});
