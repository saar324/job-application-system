#!/usr/bin/env node
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from 'node:os';
import { readPrivateAccountFile } from './account-file.js';
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

if (command === "resume-download") {
  if (!id || !path.isAbsolute(id)) throw new Error("resume-download requires an absolute local output path");
  const response = await fetch(`${base}/v1/session-resume`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error("Current authenticated resume download failed; check server readiness and document roots");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 10 * 1024 * 1024) throw new Error("Resume exceeds size limit");
  await mkdir(path.dirname(id), {recursive:true,mode:0o700});
  await writeFile(id, bytes, {mode:0o600,flag:"wx"});
  process.stdout.write(JSON.stringify({path:id,bytes:bytes.length})+"\n");
  process.exit(0);
}

const routes = {
  "search-status": ["GET", "/v1/discovery/search"],
  "draft-context": ["GET", "/v1/draft-context"],
  "queue-draft": ["GET", `/v1/chrome-queue/${id}/draft`],
  "queue-draft-review": ["POST", `/v1/chrome-queue/${id}/draft/review`],
  ...Object.fromEntries(["start", "claim", "control", "prepare-claim", "prepare-save", "progress", "finish", "stop", "enqueue", "scan", "query"].map(action =>
    [`search-${action}`, ["POST", `/v1/discovery/search/${action}`]])),
  config: ["GET", "/v1/config"], "standing-policy": ["GET", "/v1/standing-submission-policy"],
  "record-external-submission": ["POST", "/v1/external-submissions"],
  queue: ["GET", "/v1/chrome-queue"], "queue-add": ["POST", "/v1/chrome-queue"],
  "queue-next": ["POST", "/v1/chrome-queue/next"], "session-context": ["GET", "/v1/session-context"],
  ...Object.fromEntries(["checkpoint", "resume", "review", "submit-start", "receipt", "owner-receipt", "skip", "validation-error", "takeover"].map(action =>
    [`queue-${action}`, ["POST", `/v1/chrome-queue/${id}/${action}`]])),
  health: ["GET", "/health"], me: ["GET", "/v1/me"], opportunities: ["GET", "/v1/opportunities"],
  profile: ["GET", "/v1/profile/status"], "profile-update": ["PATCH", "/v1/profile"],
  "fit-context": ["GET", `/v1/profile/fit-context${id ? `?mode=${encodeURIComponent(id)}` : ""}`],
  scan: ["POST", "/v1/discovery/scan"],
  consider: ["POST", "/v1/discovery/consider"],
  filter: ["POST", "/v1/discovery/filter"],
  sources: ["GET", "/v1/discovery/sources"], query: ["POST", "/v1/discovery/query"],
  direct: ["POST", "/v1/direct-applications"],
  applications: ["GET", "/v1/applications"], "application-log": ["GET", "/v1/application-log"],
  "application-metrics": ["GET", "/v1/application-metrics"],
  inbox: ["GET", "/v1/confirmations"],
  add: ["POST", "/v1/opportunities"], apply: ["POST", `/v1/opportunities/${id}/apply`],
  "record-recruiter": ["POST", `/v1/applications/${id}/recruiter-outreach`],
  "record-employer-status": ["POST", `/v1/applications/${id}/employer-status`],

};
if ((!routes[command] && !["backlog", "handoff", "account-status", "account-download", "account-store"].includes(command))
  || ((command.startsWith("queue-") && !["queue-add", "queue-next"].includes(command)
    || ["apply", "record-employer-status", "record-recruiter", "handoff", "account-status", "account-download", "account-store"].includes(command)) && !id)) {
  console.error("usage: jobctl <queue|queue-add|queue-next|queue-checkpoint ID|queue-resume ID|queue-review ID|queue-submit-start ID|queue-receipt ID|queue-skip ID|session-context|health|profile|fit-context|profile-update|sources|scan|filter|consider|query|direct|applications|application-log|backlog|handoff ID|config|standing-policy|record-recruiter ID|record-employer-status ID>");
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
    signal: AbortSignal.timeout(["scan", "query", "search-scan", "search-query", "search-enqueue"].includes(command) ? 90_000 : 30_000)
  });
  const text = await response.text();
  if (!response.ok) {
    // Do not echo an account response body, including on an unexpected server failure.
    if (command.startsWith('account-')) {
      let message = 'account request failed';
      const safeErrors = new Set(['current applicant application not found', 'session does not own this application',
        'account origin does not match the current official application', 'account origin must be public HTTPS',
        'encrypted account vault is not configured for this applicant', 'encrypted account vault could not be unlocked',
        'no saved account credential for this origin', 'explicit owner storage authorization is required',
        'existing account credential requires owner-managed update', 'account access cannot clear an uncertain application outcome']);
      try { const e = JSON.parse(text).error; if (safeErrors.has(e)) message = e; } catch {}
      process.stdout.write(JSON.stringify({ error: message, status: response.status }) + '\n');
    } else process.stdout.write(text);
    process.exit(1);
  }
  return text ? JSON.parse(text) : {};
}

if (command === "backlog" || command === "handoff") {
  const log = await request("GET", "/v1/application-log");
  const pending = log.items.filter((item) => ["waiting_owner", "submission_started", "submission_unverified", "waiting_confirmation", "waiting_research"].includes(item.status))
    .sort((left, right) => String(left.updatedAt).localeCompare(String(right.updatedAt)));
  const needsOutcomeCheck = (item) => ["submission_started", "submission_unverified"].includes(item.status)
    || item.pause?.phase === "final_action_started"
    || item.pendingReview?.some((review) => /submission_unverified|submission_recovery|submission_email_verification|submission_blocked/.test(review.kind));
  if (command === "backlog") {
    process.stdout.write(`${JSON.stringify({ total: pending.length,
      items: pending.map((item) => ({ applicationId: item.applicationId,
        company: item.company, title: item.title, status: item.status, updatedAt: item.updatedAt,
        reviewKinds: item.pendingReview?.map((review) => review.kind) ?? [],
        savedFieldCount: item.pausedFields?.filter((field) => field.status === "filled").length ?? 0,
        requiresOutcomeCheck: Boolean(needsOutcomeCheck(item)) })) })}\n`);
    process.exit(0);
  }
  const item = pending.find((entry) => entry.applicationId === id);
  if (!item) throw new Error("application is not in this profile's review backlog");
  process.stdout.write(`${JSON.stringify({ ...item,
    requiresOutcomeCheck: Boolean(needsOutcomeCheck(item)) })}\n`);
  process.exit(0);
}

if (command.startsWith('account-')) {
  const input = await readStdin();
  if (command === 'account-status') {
    const result = await request('POST', `/v1/chrome-queue/${id}/account/status`, input);
    process.stdout.write(JSON.stringify(result) + '\n');
  } else if (command === 'account-download') {
    const result = await request('POST', `/v1/chrome-queue/${id}/account/access`, input);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'job-account-'));
    const file = path.join(dir, 'login.json');
    await writeFile(file, JSON.stringify(result), { mode: 0o600, flag: 'wx' });
    process.stdout.write(JSON.stringify({ path: file, origin: result.origin, expiresAt: result.expiresAt }) + '\n');
  } else {
    const { credentialFile, ...scope } = input;
    const value = await readPrivateAccountFile(credentialFile);
    const result = await request('POST', `/v1/chrome-queue/${id}/account/store`, {
      ...scope, username: value.username, password: value.password
    });
    await rm(credentialFile);
    process.stdout.write(JSON.stringify(result) + '\n');
  }
  process.exit(0);
}

const [method, pathname] = routes[command];
let body;
if (["POST", "PATCH"].includes(method)) {
  body = await readStdin();
}
process.stdout.write(`${JSON.stringify(await request(method, pathname, body))}\n`);
