import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { fitReviewContext } from "./discovery/fit-context.js";

const result = value => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
export function createChromeSessionMcp({ service, discovery, profiles, config, identity }) {
  const server = new McpServer({ name: "job-application-system", version: "2.0.0" });
  const read = (name, description, fn) => server.registerTool(name, { description,
    inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false } }, async () => result(await fn()));
  read("profile_status", "Read application readiness for this applicant.", () => profiles.status(identity.profileId, undefined, config.defaultMode));
  read("fit_review_context", "Read verified applicant fit context.", async () => fitReviewContext(await profiles.get(identity.profileId), config.defaultMode));
  read("chrome_queue", "Read the passive ordered queue, current application and owner blocker.", () => service.chromeQueue.list(identity.profileId));
  read("list_applications", "Read durable application history and receipts.", () => ({ items: service.applicationLog(identity.profileId) }));
  read("describe_job_sources", "Read configured sources and filters.", () => discovery.describeSources(identity));
  server.registerTool("queue_application", { description: "Save an owner URL or reviewed opportunity. Never starts a browser.",
    inputSchema: { url: z.string().url().optional(), opportunityId: z.string().uuid().optional(),
      mode: z.enum(["full_time", "freelance"]).optional() } }, async input => result(await service.chromeQueue.add(input, identity)));
  server.registerTool("next_application", { description: "Claim the next queued role for this chat. A blocker holds the queue.",
    inputSchema: { sessionId: z.string().min(1).max(100) } }, async input => result(await service.chromeQueue.claim(input, identity)));
  server.registerTool("update_current_application", { description: "Save a checkpoint, resume after owner help, review, begin one final action, record its receipt, or skip with evidence. Never operates Chrome.",
    inputSchema: { applicationId: z.string().uuid(), action: z.enum(["checkpoint", "resume", "review", "startSubmission", "receipt", "ownerReceipt", "skip", "validationError", "takeover"]),
      input: z.record(z.string(), z.unknown()) } }, async ({ applicationId, action, input }) => result(await service.chromeQueue[action](applicationId, input, identity)));
  return server;
}
