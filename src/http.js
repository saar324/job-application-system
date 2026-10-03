import { createServer } from "node:http";
import { ClientError } from "./service.js";
import { telemetry } from "./telemetry.js";
import { handleMcpRequest } from "./mcp.js";
import { runIdempotent } from "./idempotency.js";
import { fitReviewContext } from "./discovery/fit-context.js";
import { readSessionResume } from "./documents.js";

async function jsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 1_000_000) throw new ClientError(413, "request body is too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new ClientError(400, "request body must be a JSON object"); }
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}

async function idempotentHttp(service, request, identity, action, input, execute) {
  const raw = request.headers["idempotency-key"];
  if (raw === undefined) return execute();
  if (typeof raw !== "string" || raw.length < 8 || raw.length > 200) {
    throw new ClientError(400, "Idempotency-Key must contain 8 to 200 characters");
  }
  return runIdempotent({ store: service.store, profileId: identity.profileId,
    action: `http.${action}`, key: raw, input, execute });
}

export function createHttpServer({ service, discovery, profiles, authenticate, config }) {
  return createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return send(response, 200, {
          ok: true, adapter: service.adapter.name,
          storage: service.store.kind ?? "json", schemaVersion: service.store.schemaVersion?.(),
          telemetry: telemetry.health(), execution: service.executionHealth(),
          release: process.env.JOB_RELEASE_ID ?? "unknown"
        });
      }
      if (url.pathname.startsWith("/v1/internal/")) return send(response, 410, { error: "Server browser execution is retired. Use the passive Chrome queue." });
      const identity = authenticate(request);
      if (!identity) return send(response, 401, { error: "invalid or missing bearer token" });

      if (request.method === "GET" && url.pathname === "/v1/chrome-queue") {
        return send(response, 200, service.chromeQueue.list(identity.profileId));
      }
      if (request.method === "POST" && url.pathname === "/v1/chrome-queue") {
        return send(response, 201, await service.chromeQueue.add(await jsonBody(request), identity));
      }
      if (request.method === "POST" && url.pathname === "/v1/chrome-queue/next") {
        return send(response, 200, await service.chromeQueue.claim(await jsonBody(request), identity));
      }
      const queueAction = url.pathname.match(/^\/v1\/chrome-queue\/([^/]+)\/(checkpoint|resume|review|submit-start|receipt|skip|validation-error|takeover)$/);
      if (request.method === "POST" && queueAction) {
        const action = ({ "submit-start": "startSubmission", "validation-error": "validationError" })[queueAction[2]] ?? queueAction[2];
        return send(response, 200, await service.chromeQueue[action](queueAction[1], await jsonBody(request), identity));
      }
      if (request.method === "GET" && url.pathname === "/v1/session-context") {
        const profile = await profiles.get(identity.profileId);
        return send(response, 200, Object.fromEntries(["displayName", "contact", "links", "documents", "skills",
          "experience", "workHistory", "education", "applicationAnswers", "approvedAnswers", "verifiedExamples", "preferences"]
          .filter(key => profile?.[key] !== undefined).map(key => [key, profile[key]])));
      }
      if (request.method === "GET" && url.pathname === "/v1/session-resume") {
        try {
          const document = await readSessionResume(await profiles.get(identity.profileId));
          response.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store",
            "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(document.filename)}` });
          return response.end(document.bytes);
        } catch { return send(response, 409, { error: "Current resume is unavailable or outside approved document roots" }); }
      }
      if (request.method === "POST" && ![
        "/mcp", "/v1/discovery/scan", "/v1/discovery/consider", "/v1/discovery/filter", "/v1/discovery/query",
        "/v1/direct-applications", "/v1/opportunities"
      ].includes(url.pathname) && !/^\/v1\/opportunities\/[^/]+\/apply$/.test(url.pathname)
        && !/^\/v1\/applications\/[^/]+\/(recruiter-outreach|employer-status)$/.test(url.pathname)) {
        return send(response, 410, { error: "Automatic campaigns and form workers are retired. Use the Chrome queue." });
      }

      if (url.pathname === "/mcp") {
        if (request.method !== "POST") return send(response, 405, { error: "method not allowed" });
        return handleMcpRequest(request, response, await jsonBody(request), {
          service, discovery, profiles, config, identity
        });
      }

      if (request.method === "GET" && url.pathname === "/v1/config") {
        return send(response, 200, { defaultMode: config.defaultMode, modes: config.modes, adapter: service.adapter.name });
      }
      if (request.method === "GET" && url.pathname === "/v1/me") {
        const profile = await profiles.get(identity.profileId);
        return send(response, 200, {
          actorId: identity.actorId,
          profileId: identity.profileId,
          defaultMode: profile?.defaultMode ?? config.defaultMode
        });
      }
      if (request.method === "GET" && url.pathname === "/v1/profile/status") {
        return send(response, 200, await profiles.status(identity.profileId, undefined, config.defaultMode));
      }
      if (request.method === "GET" && url.pathname === "/v1/profile/fit-context") {
        const profile = await profiles.get(identity.profileId);
        const mode = url.searchParams.get("mode") ?? profile?.defaultMode ?? config.defaultMode;
        if (!config.modes[mode]) return send(response, 400, { error: "unknown mode" });
        return send(response, 200, fitReviewContext(profile, mode));
      }
      if (request.method === "PATCH" && url.pathname === "/v1/profile") {
        return send(response, 200, await profiles.patch(identity.profileId, await jsonBody(request)));
      }
      if (request.method === "PUT" && url.pathname === "/v1/profile/approved-answers") {
        if (!identity.roles?.includes("owner")) return send(response, 403, { error: "owner authority required" });
        const body = await jsonBody(request);
        return send(response, 200, await profiles.setApprovedAnswers(identity.profileId, body.answers, identity));
      }
      if (url.pathname === "/v1/profile/verified-examples") {
        if (!identity.roles?.includes("owner")) return send(response, 403, { error: "owner authority required" });
        if (request.method === "GET") {
          return send(response, 200, { examples: (await profiles.get(identity.profileId))?.verifiedExamples ?? [] });
        }
        if (request.method === "PUT") {
          const body = await jsonBody(request);
          if (Object.keys(body).some((key) => key !== "examples")) {
            return send(response, 400, { error: "only examples can be supplied" });
          }
          return send(response, 200, await profiles.setVerifiedExamples(identity.profileId, body.examples, identity));
        }
        return send(response, 405, { error: "method not allowed" });
      }
      if (url.pathname === "/v1/standing-submission-policy") {
        if (request.method === "GET") {
          return send(response, 200, { policy: (await profiles.get(identity.profileId))?.standingSubmissionPolicy ?? null });
        }
        if (request.method === "PUT") {
          if (!identity.roles?.includes("owner")) return send(response, 403, { error: "owner authority required" });
          const policy = await profiles.setStandingSubmissionPolicy(
            identity.profileId, await jsonBody(request), identity);
          // The profile write atomically includes its versioned owner history.
          // The state audit is secondary and must not turn a successful policy
          // mutation into an ambiguous HTTP failure.
          await service.recordStandingPolicyChange(policy, identity).catch((error) =>
            console.error("secondary standing policy audit failed", error));
          return send(response, 200, { policy });
        }
      }
      if (request.method === "POST" && ["/v1/discovery/scan", "/v1/discovery/query", "/v1/discovery/consider"].includes(url.pathname)
        && service.chromeQueue.list(identity.profileId).waiting) return send(response, 409, { error: "The current application needs owner help or an outcome check. Wait before discovery." });
      if (request.method === "POST" && url.pathname === "/v1/discovery/scan") {
        const body = await jsonBody(request);
        return send(response, 200, await discovery.scan({ ...body, reviewOnly: true }, identity));
      }
      if (request.method === "POST" && url.pathname === "/v1/discovery/consider") {
        const body = await jsonBody(request);
        const saved = await idempotentHttp(service, request, identity, "discovery_consider", body,
          async () => ({ status: 200, body: await discovery.considerCandidate(body, identity) }));
        return send(response, saved.status, saved.body);
      }
      if (request.method === "POST" && url.pathname === "/v1/discovery/filter") {
        return send(response, 200, await discovery.filterCandidates(await jsonBody(request), identity));
      }
      if (request.method === "GET" && url.pathname === "/v1/discovery/sources") {
        return send(response, 200, await discovery.describeSources(identity));
      }
      if (request.method === "POST" && url.pathname === "/v1/discovery/query") {
        const body = await jsonBody(request);
        const saved = await idempotentHttp(service, request, identity, "discovery_query", body,
          async () => ({ status: 200, body: await discovery.query(body, identity) }));
        return send(response, saved.status, saved.body);
      }
      if (request.method === "POST" && url.pathname === "/v1/direct-applications") {
        const body = await jsonBody(request);
        const saved = await idempotentHttp(service, request, identity, "direct_application",
          { body },
          async () => ({ status: 202, body: await service.directApplication(body, identity) }));
        return send(response, saved.status, saved.body);
      }
      if (request.method === "GET" && url.pathname === "/v1/opportunities") {
        return send(response, 200, { items: service.list("opportunities", identity.profileId) });
      }
      if (request.method === "POST" && url.pathname === "/v1/opportunities") {
        return send(response, 201, await service.addOpportunity(await jsonBody(request), identity));
      }
      if (request.method === "GET" && url.pathname === "/v1/applications") {
        return send(response, 200, { items: service.list("applications", identity.profileId) });
      }
      if (request.method === "GET" && url.pathname === "/v1/application-log") {
        return send(response, 200, { items: service.applicationLog(identity.profileId) });
      }
      if (request.method === "GET" && url.pathname === "/v1/application-metrics") {
        return send(response, 200, service.applicationMetrics(identity.profileId));
      }
      if (request.method === "GET" && url.pathname === "/v1/confirmations") {
        const items = service.list("confirmations", identity.profileId);
        return send(response, 200, { items: items.filter((item) => item.status === "pending") });
      }
      const apply = url.pathname.match(/^\/v1\/opportunities\/([^/]+)\/apply$/);
      if (request.method === "POST" && apply) {
        const body = await jsonBody(request);
        const saved = await idempotentHttp(service, request, identity, "request_application",
          { opportunityId: apply[1], body },
          async () => ({ status: 202, body: await service.requestApplication(apply[1], body, identity) }));
        return send(response, saved.status, saved.body);
      }
      const recruiterOutreach = url.pathname.match(/^\/v1\/applications\/([^/]+)\/recruiter-outreach$/);
      if (request.method === "POST" && recruiterOutreach) {
        return send(response, 200, await service.recordRecruiterOutreach(recruiterOutreach[1], await jsonBody(request), identity));
      }
      const employerStatus = url.pathname.match(/^\/v1\/applications\/([^/]+)\/employer-status$/);
      if (request.method === "POST" && employerStatus) {
        return send(response, 200, await service.recordEmployerStatus(
          employerStatus[1], await jsonBody(request), identity
        ));
      }
      return send(response, 404, { error: "route not found" });
    } catch (error) {
      const status = error.status ?? 500;
      telemetry.count("http.errors", 1, { method: request.method, route: url.pathname, status });
      send(response, status, { error: status === 500 ? "internal server error" : error.message });
      if (status === 500) console.error(error);
    }
  });
}
