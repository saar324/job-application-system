import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { WebhookAdapter } from "../src/adapters/webhook.js";
import { NeedsInputError, NeedsReviewError, PostingUnavailableError,
  RetryableExecutionError } from "../src/adapters/errors.js";

async function worker(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/v1/submit` };
}

test("webhook adapter maps worker input and uncertain outcomes conservatively", async () => {
  const fixture = await worker((request, response) => {
    assert.equal(request.headers.authorization, "Bearer worker-secret");
    response.writeHead(409, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "needs_input", message: "question", requirements: [{ kind: "missing_answer" }] }));
  });
  try {
    const adapter = new WebhookAdapter({ url: fixture.url, token: "worker-secret" });
    await assert.rejects(adapter.submit({ application: { id: "one" } }), NeedsInputError);
  } finally { await new Promise((resolve) => fixture.server.close(resolve)); }

  const uncertain = await worker((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "submitted", receipt: {} }));
  });
  try {
    await assert.rejects(new WebhookAdapter({ url: uncertain.url }).submit({}), NeedsReviewError);
  } finally { await new Promise((resolve) => uncertain.server.close(resolve)); }
});

test("webhook adapter carries a typed unavailable-posting result", async () => {
  const fixture = await worker((_request, response) => {
    response.writeHead(409, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "posting_unavailable", reasonCode: "posting_not_found",
      metrics: { activeMs: 90 } }));
  });
  try {
    await assert.rejects(new WebhookAdapter({ url: fixture.url }).submit({}), (error) => {
      assert.ok(error instanceof PostingUnavailableError);
      assert.equal(error.reasonCode, "posting_not_found");
      assert.equal(error.metrics.activeMs, 90);
      return true;
    });
  } finally { await new Promise((resolve) => fixture.server.close(resolve)); }
});

test("webhook adapter marks a 500 before the final action as retryable", async () => {
  const fixture = await worker((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET") {
      response.end(JSON.stringify({ status: "before_final_action" }));
      return;
    }
    response.writeHead(500);
    response.end(JSON.stringify({ error: "navigation connection closed" }));
  });
  try {
    await assert.rejects(new WebhookAdapter({ url: fixture.url }).submit({ application: { id: "one" } }),
      RetryableExecutionError);
  } finally { await new Promise((resolve) => fixture.server.close(resolve)); }
});
