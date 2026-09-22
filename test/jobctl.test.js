import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);

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
