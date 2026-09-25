import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);

test("all-source runner uses the public catalog when no private catalog is supplied", async () => {
  let submitted;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    submitted = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(400, { "content-type": "application/json" });
    response.end('{"error":"fixture stop"}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(execute(process.execPath, ["scripts/run-all-source-campaign.js",
      "--server", `http://127.0.0.1:${server.address().port}`, "--reserve-only"]),
    /fixture stop/);
    assert.deepEqual(submitted.sources,
      ["remoteok", "arbeitnow", "jobicy", "himalayas", "ashby", "greenhouse", "lever"]);
    assert.deepEqual(submitted.fallbackSources,
      ["jobgether", "remotive", "weworkremotely", "workingnomads", "wellfound", "ycombinator"]);
    assert.equal(submitted.reserveOnly, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
