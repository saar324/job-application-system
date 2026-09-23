import { createServer } from "node:http";
import { ClientError } from "./service.js";
import { telemetry } from "./telemetry.js";
import { handleMcpRequest } from "./mcp.js";
import { runIdempotent } from "./idempotency.js";

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
          telemetry: telemetry.health()
        });
      }
      const identity = authenticate(request);
      if (!identity) return send(response, 401, { error: "invalid or missing bearer token" });

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
      if (request.method === "PATCH" && url.pathname === "/v1/profile") {
        return send(response, 200, await profiles.patch(identity.profileId, await jsonBody(request)));
      }
      if (request.method === "POST" && url.pathname === "/v1/discovery/scan") {
        return send(response, 200, await discovery.scan(await jsonBody(request), identity));
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
      if (request.method === "POST" && url.pathname === "/v1/campaigns") {
        const body = await jsonBody(request);
        const saved = await idempotentHttp(service, request, identity, "start_campaign", body,
          async () => ({ status: 202, body: await discovery.startCampaign(body, identity) }));
        return send(response, saved.status, saved.body);
      }
      if (request.method === "GET" && url.pathname === "/v1/campaigns") {
        return send(response, 200, { items: service.listCampaigns(identity.profileId) });
      }
      const campaign = url.pathname.match(/^\/v1\/campaigns\/([^/]+)$/);
      if (request.method === "GET" && campaign) {
        return send(response, 200, service.campaignStatus(campaign[1], identity.profileId));
      }
      const campaignApproval = url.pathname.match(/^\/v1\/campaigns\/([^/]+)\/approve$/);
      if (request.method === "POST" && campaignApproval) {
        const body = await jsonBody(request);
        const saved = await idempotentHttp(service, request, identity, "approve_campaign", body,
          async () => ({ status: 200,
            body: await service.approveCampaign(campaignApproval[1], body.entries, identity) }));
        return send(response, saved.status, saved.body);
      }
      const campaignSource = url.pathname.match(/^\/v1\/campaigns\/([^/]+)\/source-results$/);
      if (request.method === "POST" && campaignSource) {
        const body = await jsonBody(request);
        const saved = await idempotentHttp(service, request, identity, "campaign_source_results", body,
          async () => ({ status: 200,
            body: await discovery.addCampaignSourceResults(campaignSource[1], body, identity) }));
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
      if (request.method === "POST" && url.pathname === "/v1/confirmations/approve-batch") {
        const body = await jsonBody(request);
        const saved = await idempotentHttp(service, request, identity, "approve_prepared_batch", body,
          async () => ({ status: 200, body: await service.approvePreparedBatch(body.entries, identity) }));
        return send(response, saved.status, saved.body);
      }
      const refreshPreview = url.pathname.match(/^\/v1\/applications\/([^/]+)\/refresh-preview$/);
      if (request.method === "POST" && refreshPreview) {
        const saved = await idempotentHttp(service, request, identity, "refresh_final_preview",
          { applicationId: refreshPreview[1] },
          async () => ({ status: 202, body: await service.refreshFinalPreview(refreshPreview[1], identity) }));
        return send(response, saved.status, saved.body);
      }

      const apply = url.pathname.match(/^\/v1\/opportunities\/([^/]+)\/apply$/);
      if (request.method === "POST" && apply) {
        const body = await jsonBody(request);
        const saved = await idempotentHttp(service, request, identity, "request_application",
          { opportunityId: apply[1], body },
          async () => ({ status: 202, body: await service.requestApplication(apply[1], body, identity) }));
        return send(response, saved.status, saved.body);
      }
      const confirmation = url.pathname.match(/^\/v1\/confirmations\/([^/]+)$/);
      if (request.method === "POST" && confirmation) {
        const body = await jsonBody(request);
        const saved = await idempotentHttp(service, request, identity, "resolve_confirmation",
          { confirmationId: confirmation[1], body },
          async () => ({ status: 200, body: await service.resolveConfirmation(confirmation[1], body, identity) }));
        return send(response, saved.status, saved.body);
      }
      const manualSubmission = url.pathname.match(/^\/v1\/applications\/([^/]+)\/manual-submission$/);
      if (request.method === "POST" && manualSubmission) {
        return send(response, 200, await service.recordManualSubmission(
          manualSubmission[1], await jsonBody(request), identity
        ));
      }
      const employerStatus = url.pathname.match(/^\/v1\/applications\/([^/]+)\/employer-status$/);
      if (request.method === "POST" && employerStatus) {
        return send(response, 200, await service.recordEmployerStatus(
          employerStatus[1], await jsonBody(request), identity
        ));
      }
      const research = url.pathname.match(/^\/v1\/applications\/([^/]+)\/research$/);
      if (request.method === "POST" && research) {
        const body = await jsonBody(request);
        const saved = await idempotentHttp(service, request, identity, "attach_research",
          { applicationId: research[1], body },
          async () => ({ status: 200, body: await service.attachResearch(research[1], body, identity) }));
        return send(response, saved.status, saved.body);
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
