import { createServer } from "node:http";
import { ClientError } from "./service.js";

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

export function createHttpServer({ service, discovery, profiles, authenticate, config }) {
  return createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return send(response, 200, { ok: true, adapter: service.adapter.name });
      }
      const identity = authenticate(request);
      if (!identity) return send(response, 401, { error: "invalid or missing bearer token" });

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
      if (request.method === "POST" && url.pathname === "/v1/direct-applications") {
        return send(response, 202, await service.directApplication(await jsonBody(request), identity));
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
      if (request.method === "GET" && url.pathname === "/v1/confirmations") {
        const items = service.list("confirmations", identity.profileId);
        return send(response, 200, { items: items.filter((item) => item.status === "pending") });
      }

      const apply = url.pathname.match(/^\/v1\/opportunities\/([^/]+)\/apply$/);
      if (request.method === "POST" && apply) {
        return send(response, 202, await service.requestApplication(apply[1], await jsonBody(request), identity));
      }
      const confirmation = url.pathname.match(/^\/v1\/confirmations\/([^/]+)$/);
      if (request.method === "POST" && confirmation) {
        return send(response, 200, await service.resolveConfirmation(confirmation[1], await jsonBody(request), identity));
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
      return send(response, 404, { error: "route not found" });
    } catch (error) {
      const status = error.status ?? 500;
      send(response, status, { error: status === 500 ? "internal server error" : error.message });
      if (status === 500) console.error(error);
    }
  });
}
