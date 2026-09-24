#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const options = argumentsOf(process.argv.slice(2));
if (!options.catalog) {
  console.error("usage: run-all-source-campaign --catalog FILE [--target 10] [--reserve 10] [--reserve-only] [--source-timeout-ms 50000] [--server URL] [--token-file FILE] [--headed]");
  process.exit(2);
}
const catalogPath = path.resolve(options.catalog);
const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const primary = (catalog.autonomousDiscovery?.serverAdapters ?? []).map((source) => source.id);
const fallback = (catalog.autonomousDiscovery?.visibleBrowserSources ?? []).map((source) => source.id);
const server = options.server ?? process.env.JOB_SERVER_URL ?? "http://127.0.0.1:4310";
const token = process.env.JOB_SERVER_TOKEN || (options.tokenFile
  ? (await readFile(path.resolve(options.tokenFile), "utf8")).trim() : "");
const body = { target: number(options.target, 10, 1, 100), reserve: number(options.reserve, 10, 0, 50),
  sources: primary, fallbackSources: fallback, limitPerSource: 10,
  reserveOnly: options.reserveOnly === true, maxRequestsPerSource: 20 };
const response = await fetch(`${server}/v1/campaigns`, {
  method: "POST", headers: { "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    "idempotency-key": `all-sources-${Date.now()}` },
  body: JSON.stringify(body), signal: AbortSignal.timeout(120_000)
});
const campaign = await response.json();
if (!response.ok) throw new Error(campaign.error ?? `HTTP ${response.status}`);
process.stdout.write(`${JSON.stringify({ campaignId: campaign.campaignId, status: campaign.status,
  sources: campaign.sourceCoverage?.plannedCount })}\n`);

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "run-browser-source-campaign.js");
const childArgs = [script, "--campaign", campaign.campaignId, "--catalog", catalogPath, "--server", server];
let privatePlanDirectory;
if (options.queryPlanFile) childArgs.push("--query-plan-file", path.resolve(options.queryPlanFile));
else if (campaign.searchPlanSeed) {
  privatePlanDirectory = await mkdtemp(path.join(os.tmpdir(), "job-search-plan-"));
  const privatePlanFile = path.join(privatePlanDirectory, "plan.json");
  await writeFile(privatePlanFile, JSON.stringify(campaign.searchPlanSeed), { mode: 0o600 });
  childArgs.push("--query-plan-file", privatePlanFile);
}
if (options.tokenFile) childArgs.push("--token-file", path.resolve(options.tokenFile));
if (options.headed) childArgs.push("--headed");
if (options.query) childArgs.push("--query", options.query);
if (options.searchCycle !== undefined) childArgs.push("--search-cycle", options.searchCycle);
if (options.userDataDir) childArgs.push("--user-data-dir", path.resolve(options.userDataDir));
if (options.cdpEndpoint) childArgs.push("--cdp-endpoint", options.cdpEndpoint);
if (options.channel) childArgs.push("--channel", options.channel);
for (const key of ["maxCandidates", "maxListingPages", "maxDetailPages", "maxRequests", "minDelayMs", "navigationTimeoutMs", "sourceTimeoutMs"]) {
  if (options[key] !== undefined) childArgs.push(`--${toKebab(key)}`, options[key]);
}
let exitCode;
try {
  exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, childArgs, { stdio: "inherit",
      env: { ...process.env, ...(token ? { JOB_SERVER_TOKEN: token } : {}) } });
    child.once("error", reject); child.once("exit", (code) => resolve(code ?? 1));
  });
} finally {
  if (privatePlanDirectory) await rm(privatePlanDirectory, { recursive: true, force: true });
}
if (exitCode !== 0) process.exit(exitCode);
const finalResponse = await fetch(`${server}/v1/campaigns/${campaign.campaignId}`, {
  headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(30_000)
});
const final = await finalResponse.json();
if (!finalResponse.ok) throw new Error(final.error ?? `HTTP ${finalResponse.status}`);
process.stdout.write(`${JSON.stringify({ campaignId: final.campaignId, status: final.status,
  candidatePoolSize: final.candidatePoolSize, applications: final.applications.length,
  sourceCoverage: final.sourceCoverage, timing: final.timing })}\n`);

function number(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error("target and reserve are outside their allowed range");
  return parsed;
}
function argumentsOf(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (["--headed", "--reserve-only"].includes(value)) result[toCamel(value.slice(2))] = true;
    else if (value.startsWith("--")) result[toCamel(value.slice(2))] = values[++index];
  }
  return result;
}
function toCamel(value) { return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()); }
function toKebab(value) { return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`); }
