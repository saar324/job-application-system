#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, values) => {
  if (value.startsWith("--")) pairs.push([value.slice(2), values[index + 1]]);
  return pairs;
}, []));
const server = args.server ?? process.env.JOB_SERVER_URL ?? "http://127.0.0.1:4310";
const token = process.env.JOB_SERVER_TOKEN || (args["token-file"]
  ? (await readFile(args["token-file"], "utf8")).trim() : "");
if (!token) throw new Error("a profile-bound reserve refresh token is required");
const body = { ...(args.mode ? { mode: args.mode } : {}),
  ...(args.sources ? { sources: args.sources.split(",").map((item) => item.trim()).filter(Boolean) } : {}) };
const response = await fetch(new URL("/v1/discovery/reserve/refresh", server), {
  method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json",
    "idempotency-key": `reserve-refresh-${Date.now()}` },
  body: JSON.stringify(body), signal: AbortSignal.timeout(900_000)
});
const result = await response.json();
if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
process.stdout.write(`${JSON.stringify(result)}\n`);
