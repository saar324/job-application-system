#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function optionalFile(file) {
  try { return (await readFile(file, "utf8")).trim(); }
  catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

const [command, id] = process.argv.slice(2);
const base = process.env.JOB_SERVER_URL
  || await optionalFile(path.join(skillRoot, ".job-server-url"))
  || "http://127.0.0.1:4310";
const token = process.env.JOB_SERVER_TOKEN
  || await optionalFile(process.env.JOB_SERVER_TOKEN_FILE ?? path.join(skillRoot, ".job-server-token"));

const routes = {
  health: ["GET", "/health"], me: ["GET", "/v1/me"], opportunities: ["GET", "/v1/opportunities"],
  profile: ["GET", "/v1/profile/status"], "profile-update": ["PATCH", "/v1/profile"],
  scan: ["POST", "/v1/discovery/scan"],
  sources: ["GET", "/v1/discovery/sources"], query: ["POST", "/v1/discovery/query"],
  "campaign-start": ["POST", "/v1/campaigns"], "campaigns": ["GET", "/v1/campaigns"],
  "campaign-status": ["GET", `/v1/campaigns/${id}`],
  "campaign-approve": ["POST", `/v1/campaigns/${id}/approve`],
  "campaign-add-source": ["POST", `/v1/campaigns/${id}/source-results`],
  direct: ["POST", "/v1/direct-applications"],
  applications: ["GET", "/v1/applications"], "application-log": ["GET", "/v1/application-log"],
  "application-metrics": ["GET", "/v1/application-metrics"],
  inbox: ["GET", "/v1/confirmations"],
  "approve-batch": ["POST", "/v1/confirmations/approve-batch"],
  research: ["POST", `/v1/applications/${id}/research`],
  "refresh-preview": ["POST", `/v1/applications/${id}/refresh-preview`],
  add: ["POST", "/v1/opportunities"], apply: ["POST", `/v1/opportunities/${id}/apply`],
  "record-submission": ["POST", `/v1/applications/${id}/manual-submission`],
  "record-employer-status": ["POST", `/v1/applications/${id}/employer-status`],
  confirm: ["POST", `/v1/confirmations/${id}`], reject: ["POST", `/v1/confirmations/${id}`]
};
if ((!routes[command] && command !== "callback") || (["apply", "campaign-status", "campaign-approve", "campaign-add-source", "research", "refresh-preview", "record-submission", "record-employer-status", "confirm", "reject", "callback"].includes(command) && !id)) {
  console.error("usage: jobctl <health|me|profile|profile-update|sources|scan|query|campaign-start|campaigns|campaign-status ID|campaign-approve ID|campaign-add-source ID|direct|opportunities|applications|application-log|application-metrics|inbox|approve-batch|research ID|refresh-preview ID|add|apply ID|record-submission ID|record-employer-status ID|confirm ID|reject ID|callback DATA>");
  process.exit(2);
}

async function readStdin() {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const value = Buffer.concat(chunks).toString("utf8").trim();
  return value ? JSON.parse(value) : {};
}

async function request(method, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
  method,
  headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body?.idempotencyKey ? { "idempotency-key": String(body.idempotencyKey) } : {}),
    ...(body ? { "content-type": "application/json" } : {})
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(["scan", "query", "campaign-start"].includes(command) ? 90_000 : 30_000)
  });
  const text = await response.text();
  if (!response.ok) {
    process.stdout.write(text);
    process.exit(1);
  }
  return text ? JSON.parse(text) : {};
}

if (command === "callback") {
  const match = id.match(/^jobapp:([a-f0-9-]{36}):(approve|reject|custom|choose)(?::([0-7]))?$/);
  if (!match) throw new Error("invalid job application callback");
  const [, confirmationId, action, optionIndex] = match;
  const inbox = await request("GET", "/v1/confirmations");
  const confirmation = inbox.items.find((item) => item.id === confirmationId);
  if (!confirmation) throw new Error("confirmation is stale or does not belong to this profile");
  if (action === "custom") {
    process.stdout.write(`${JSON.stringify({ status: "needs_typed_answer", confirmation }, null, 2)}\n`);
    process.exit(0);
  }
  if (action === "reject") {
    process.stdout.write(`${JSON.stringify(await request("POST", `/v1/confirmations/${confirmationId}`, { approved: false }))}\n`);
    process.exit(0);
  }
  let answers = {};
  if (action === "choose") {
    const option = confirmation.options?.[Number(optionIndex)];
    const field = confirmation.fields?.[0];
    if (!option || !field) throw new Error("confirmation option is no longer valid");
    answers = { [field]: option.value };
  }
  process.stdout.write(`${JSON.stringify(await request("POST", `/v1/confirmations/${confirmationId}`, { approved: true, answers }))}\n`);
  process.exit(0);
}

const [method, pathname] = routes[command];
let body;
if (["POST", "PATCH"].includes(method)) {
  body = await readStdin();
  if (command === "confirm") body.approved = true;
  if (command === "reject") body.approved = false;
}
process.stdout.write(`${JSON.stringify(await request(method, pathname, body))}\n`);
