import { createServer } from "node:http";
import path from "node:path";
import { chromium } from "playwright";
import { createUrlPolicy } from "./url-policy.js";
import { validateWorkerPayload } from "./document-policy.js";
import { ReceiptStore } from "./receipts.js";
import { executeInFreshContext } from "./execution.js";
import { createAdaptiveControllerFromEnv } from "./adaptive.js";
import { claimReviewerFromEnv, draftProviderFromEnv } from "./draft-provider.js";
import { createValidatedEgressProxy } from "./egress-proxy.js";
import { browserPathConfig, browserPathFor } from "./browser-path.js";
import { VerificationSessions } from "./verification-sessions.js";

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2_000_000) throw Object.assign(new Error("request is too large"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw Object.assign(new Error("request must be a JSON object"), { status: 400 }); }
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}

const token = process.env.WORKER_TOKEN;
if (!token) throw new Error("WORKER_TOKEN is required");
const urlPolicy = createUrlPolicy();
const artifactsDirectory = path.resolve(process.env.WORKER_ARTIFACTS ?? "./data/artifacts");
const documentRoot = path.resolve(process.env.WORKER_DOCUMENT_ROOT ?? "./data/documents");
const receiptStore = new ReceiptStore(process.env.WORKER_RECEIPTS ?? "./data/receipts");
const verificationSessions = new VerificationSessions({closeOnSuccess:true});
const verificationReceipts = new Map();
const egressProxy = await createValidatedEgressProxy(urlPolicy);
const browserPaths = browserPathConfig();
const browser = await chromium.launch({ headless: browserPaths.defaultHeadless, args: ["--disable-quic"] });
const headedBrowser = browserPaths.headedOrigins.size
  ? await chromium.launch({ headless: false, args: ["--disable-quic"] }) : null;
const adaptiveController = createAdaptiveControllerFromEnv();
const draftProvider = draftProviderFromEnv();
const claimReviewer = claimReviewerFromEnv();
const internalUrl = process.env.JOB_SERVER_INTERNAL_URL;
async function finalGate(pathname, body) {
  if (!internalUrl) throw new Error("JOB_SERVER_INTERNAL_URL is required for standing authorization");
  const endpoint = new URL(pathname, internalUrl);
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname)) {
    throw new Error("final gate must use a local server endpoint");
  }
  const response = await fetch(endpoint, { method: "POST", headers: {
    authorization: `Bearer ${token}`, "content-type": "application/json"
  }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`final gate returned HTTP ${response.status}`);
  return response.json();
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      return send(response, 200, { ok: true, browser: "chromium", release: process.env.JOB_RELEASE_ID ?? "unknown", waitingVerification: verificationSessions.size });
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      return send(response, 401, { error: "invalid worker token" });
    }
    const attempt = request.url?.match(/^\/v1\/attempts\/([a-zA-Z0-9_-]{1,80})$/);
    if (request.method === "GET" && attempt) {
      return send(response, 200, await receiptStore.status(attempt[1]));
    }
    if (request.method === "POST" && request.url === "/v1/verify") {
      try {
        const input = await readJson(request);
        const recorder = verificationReceipts.get(input.sessionId);
        const result = await verificationSessions.verify(input, {
          authorize: body => finalGate("/v1/internal/verification-decision", body),
          persistReceipt: async result => { if (!recorder) throw new Error("No bound receipt recorder"); await recorder(result); }
        });
        if (result.status === "submitted") verificationReceipts.delete(input.sessionId);
        return send(response, result.status === "submitted" ? 200 : 409, result);
      } catch { return send(response, 409, {error:"Verification outcome remains unconfirmed"}); }
    }
    if (request.method !== "POST" || request.url !== "/v1/submit") {
      return send(response, 404, { error: "route not found" });
    }
    const payload = await validateWorkerPayload(await readJson(request), documentRoot);
    const profile = payload.profile;
    const verificationRecorder = receiptStore.verificationRecorder(payload);
    const result = await receiptStore.run(payload, async (markFinalActionStarted) => {
      const selected = browserPathFor(payload.opportunity.applyUrl, browserPaths);
      return executeInFreshContext({ browser: selected === "headed" ? headedBrowser : browser,
        payload, urlPolicy, artifactsDirectory,
        adaptiveController, draftProvider, claimReviewer, egressProxy, markFinalActionStarted,
        authorizeFinal: (body) => finalGate("/v1/internal/final-decision", body),
        commitFinal: (body) => finalGate("/v1/internal/final-commit", body), verificationSessions });
    });
    const retained = result.requirements?.find(item => item.verificationSession)?.verificationSession;
    if (retained) {
      verificationReceipts.set(retained.id, verificationRecorder);
      const timer = setTimeout(() => verificationReceipts.delete(retained.id), Math.max(0, retained.expiresAt-Date.now()));
      timer.unref?.();
    }
    return send(response, result.status === "submitted" ? 200 : 409, result);
  } catch (error) {
    console.error(error);
    return send(response, error.status ?? 500, { error: error.message });
  }
});

const host = process.env.WORKER_HOST ?? "127.0.0.1";
const port = Number(process.env.WORKER_PORT ?? 4320);
server.listen(port, host, () => console.log(`application worker listening on http://${host}:${port}`));

async function shutdown() {
  server.close();
  await verificationSessions.closeAll();
  await browser.close();
  await headedBrowser?.close();
  await egressProxy.close();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
