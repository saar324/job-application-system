import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod/v4";
import { runIdempotent } from "./idempotency.js";

function result(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

function page(items, cursor, requestedLimit) {
  const offset = cursor ? Number(Buffer.from(cursor, "base64url").toString("utf8")) : 0;
  const limit = Math.max(1, Math.min(100, Number(requestedLimit ?? 25)));
  const selected = items.slice(offset, offset + limit);
  const next = offset + selected.length < items.length
    ? Buffer.from(String(offset + selected.length)).toString("base64url") : undefined;
  return { items: selected, ...(next ? { nextCursor: next } : {}) };
}

async function idempotent(service, identity, action, key, input, fn) {
  return runIdempotent({ store: service.store, profileId: identity.profileId,
    action: `mcp.${action}`, key, input, execute: async () => JSON.parse(JSON.stringify(await fn())) });
}

export function createProfileMcpServer({ service, discovery, profiles, config, identity }) {
  const server = new McpServer({ name: "job-application-system", version: "1.0.0" });
  server.registerTool("profile_status", {
    description: "Return application readiness for the authenticated profile.",
    inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false }
  }, async () => result(await profiles.status(identity.profileId, undefined, config.defaultMode)));

  server.registerTool("scan_jobs", {
    description: "Scan configured public job sources for the authenticated profile.",
    inputSchema: {
      mode: z.enum(["full_time", "freelance"]).optional(),
      sources: z.array(z.string()).max(20).optional(),
      limitPerSource: z.number().int().min(1).max(200).optional(),
      idempotencyKey: z.string().min(8).max(200)
    }, annotations: { openWorldHint: true }
  }, async ({ idempotencyKey, ...input }) => result(await idempotent(
    service, identity, "scan_jobs", idempotencyKey, input, async () => {
      const scan = await discovery.scan(input, identity);
      return {
        mode: scan.mode, sources: scan.sources, found: scan.found, qualifying: scan.qualifying,
        excluded: scan.excluded, errors: scan.errors,
        opportunityIds: scan.items.map((item) => item.opportunity.id)
      };
    }
  )));

  server.registerTool("describe_job_sources", {
    description: "Describe enabled, bounded search filters for the authenticated profile.",
    inputSchema: { mode: z.enum(["full_time", "freelance"]).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ mode }) => result(await discovery.describeSources(identity, mode)));

  server.registerTool("query_jobs", {
    description: "Run a bounded search plan against one enabled public job source.",
    inputSchema: {
      mode: z.enum(["full_time", "freelance"]).optional(),
      source: z.string(),
      queries: z.array(z.object({ filters: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
        limit: z.number().int().min(1).max(200).optional() })).min(1).max(8),
      scanCycleId: z.string().min(1).max(100),
      idempotencyKey: z.string().min(8).max(200)
    }, annotations: { openWorldHint: true }
  }, async (input) => result(await discovery.query(input, identity)));

  const listSchema = { cursor: z.string().max(100).optional(), limit: z.number().int().min(1).max(100).optional() };
  server.registerTool("list_opportunities", {
    description: "List opportunities owned by the authenticated profile.", inputSchema: listSchema,
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ cursor, limit }) => result(page(service.list("opportunities", identity.profileId), cursor, limit)));
  server.registerTool("list_applications", {
    description: "List applications owned by the authenticated profile.", inputSchema: listSchema,
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ cursor, limit }) => result(page(service.applicationLog(identity.profileId), cursor, limit)));
  server.registerTool("get_application", {
    description: "Get one application owned by the authenticated profile.",
    inputSchema: { applicationId: z.string().uuid() }, annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ applicationId }) => {
    const item = service.applicationLog(identity.profileId).find((entry) => entry.applicationId === applicationId);
    if (!item) throw new Error("application not found");
    return result(item);
  });
  server.registerTool("request_application", {
    description: "Create or return a durable application for a public HTTPS URL.",
    inputSchema: {
      url: z.string().url(), title: z.string().max(300).optional(), company: z.string().max(300).optional(),
      mode: z.enum(["full_time", "freelance"]).optional(), idempotencyKey: z.string().min(8).max(200)
    }, annotations: { openWorldHint: true, destructiveHint: false }
  }, async ({ idempotencyKey, ...input }) => result(await idempotent(
    service, identity, "request_application", idempotencyKey, input, async () => {
      const value = await service.directApplication(input, identity);
      return {
        opportunityId: value.opportunity.id, applicationId: value.application?.id,
        status: value.application?.status, duplicate: value.duplicate === true
      };
    }
  )));
  server.registerTool("list_confirmations", {
    description: "List pending confirmations for the authenticated profile.", inputSchema: listSchema,
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ cursor, limit }) => result(page(service.list("confirmations", identity.profileId)
    .filter((item) => item.status === "pending"), cursor, limit)));
  server.registerTool("resolve_confirmation", {
    description: "Resolve one current confirmation for the authenticated profile; never infers an answer.",
    inputSchema: {
      confirmationId: z.string().uuid(), approved: z.boolean(), answers: z.record(z.string(), z.unknown()).optional(),
      idempotencyKey: z.string().min(8).max(200)
    }, annotations: { openWorldHint: false, destructiveHint: true }
  }, async ({ confirmationId, approved, answers, idempotencyKey }) => result(await idempotent(
    service, identity, "resolve_confirmation", idempotencyKey, { confirmationId, approved, answers },
    async () => {
      const value = await service.resolveConfirmation(confirmationId, { approved, answers }, identity);
      return { applicationId: value.id, status: value.status };
    }
  )));
  server.registerTool("approve_prepared_batch", {
    description: "Approve only the exact complete previews explicitly named by the profile owner.",
    inputSchema: {
      entries: z.array(z.object({ applicationId: z.string().uuid(),
        previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/) })).min(1).max(50),
      idempotencyKey: z.string().min(8).max(200)
    }, annotations: { openWorldHint: false, destructiveHint: true }
  }, async ({ entries, idempotencyKey }) => result(await idempotent(
    service, identity, "approve_prepared_batch", idempotencyKey, { entries },
    async () => service.approvePreparedBatch(entries, identity)
  )));
  server.registerTool("attach_application_research", {
    description: "Attach an official company excerpt to a waiting application and requeue it.",
    inputSchema: { applicationId: z.string().uuid(), url: z.string().url(),
      excerpt: z.string().min(1).max(6000), officialSourceConfirmed: z.literal(true),
      idempotencyKey: z.string().min(8).max(200) },
    annotations: { openWorldHint: true, destructiveHint: false }
  }, async ({ applicationId, idempotencyKey, ...body }) => result(await idempotent(
    service, identity, "attach_application_research", idempotencyKey, { applicationId, body },
    async () => service.attachResearch(applicationId, body, identity)
  )));
  return server;
}

export async function handleMcpRequest(request, response, body, dependencies) {
  const server = createProfileMcpServer(dependencies);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(request, response, body);
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}
