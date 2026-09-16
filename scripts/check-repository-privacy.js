#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root })
  .toString("utf8").split("\0").filter(Boolean);
const failures = [];
const personalIdentifiers = [
  ["my", "os"].join(""),
  ["sa", "ar"].join(""),
  ["res", "hef"].join(""),
  ["ev", "a"].join("")
];

const forbiddenPaths = [
  /^\.env(?:\.|$)/,
  /^data\//,
  /^private-documents\//,
  /^config\/(?:local|profiles)\.json$/,
  /^config\/.*(?:private|secret).*\.json$/i,
  /(?:^|\/)\.job-server-(?:token|url)$/,
  /\.(?:pem|key|p12|pfx|db|sqlite|sqlite3|enc\.json)$/i
];
for (const file of tracked) {
  if (file === ".env.example") continue;
  if (forbiddenPaths.some((pattern) => pattern.test(file))) failures.push(`${file}: private path is tracked`);
}

const contentChecks = [
  [/(?:^|\s)-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/m, "private key material"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/, "GitHub token"],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/, "API key"],
  [/https?:\/\/[^\s/]+:[^\s@/]+@/, "credential-bearing URL"],
  [/(?:^|["'\s=])\/Users\/[A-Za-z0-9._-]+\//m, "absolute macOS home path"],
  [/(?:^|["'\s=])\/home\/(?!applicant|jobapp)[A-Za-z0-9._-]+\//m, "absolute user home path"],
  [new RegExp(`\\b(?:${personalIdentifiers.join("|")})\\b`, "i"), "personal identifier"]
];
const emailPattern = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi;

for (const file of tracked) {
  let contents;
  try { contents = await readFile(path.join(root, file), "utf8"); }
  catch { continue; }
  inspectContents(file, contents);
}

const historicalPaths = execFileSync("git", ["log", "--all", "--name-only", "--format="], { cwd: root })
  .toString("utf8").split(/\r?\n/).filter(Boolean);
for (const file of historicalPaths) {
  if (file === ".env.example") continue;
  if (forbiddenPaths.some((pattern) => pattern.test(file))) {
    failures.push(`${file}: private path exists in Git history`);
  }
}

const objectLines = execFileSync("git", ["rev-list", "--objects", "--all"], { cwd: root })
  .toString("utf8").split(/\r?\n/).filter(Boolean);
const objectIds = objectLines.map((line) => line.split(" ", 1)[0]);
const objectTypes = execFileSync(
  "git", ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
  { cwd: root, input: `${objectIds.join("\n")}\n` }
).toString("utf8").split(/\r?\n/).filter(Boolean);
const typeById = new Map(objectTypes.map((line) => line.split(" ")));
for (const line of objectLines) {
  const separator = line.indexOf(" ");
  const objectId = separator === -1 ? line : line.slice(0, separator);
  if (typeById.get(objectId) !== "blob") continue;
  const file = separator === -1 ? objectId : line.slice(separator + 1);
  let contents;
  try {
    const blob = execFileSync("git", ["cat-file", "blob", objectId], { cwd: root, maxBuffer: 50_000_000 });
    if (blob.includes(0)) continue;
    contents = blob.toString("utf8");
  } catch { continue; }
  inspectContents(`history:${file}`, contents);
}

function inspectContents(file, contents) {
  for (const [pattern, label] of contentChecks) {
    if (pattern.test(contents)) failures.push(`${file}: possible ${label}`);
  }
  for (const match of contents.matchAll(emailPattern)) {
    const domain = match[1].toLowerCase();
    if (!["example.com", "example.org", "example.net", "example.test", "example.invalid"].includes(domain)) {
      failures.push(`${file}: non-example email address`);
      break;
    }
  }
}

const defaults = JSON.parse(await readFile(path.join(root, "config/default.json"), "utf8"));
for (const [mode, settings] of Object.entries(defaults.modes ?? {})) {
  if ((settings.sources ?? []).length) failures.push(`config/default.json: ${mode} enables sources`);
  if (settings.autoApply || settings.autoApplyDiscovered) {
    failures.push(`config/default.json: ${mode} enables automatic application`);
  }
}
for (const [provider, settings] of Object.entries(defaults.discovery?.sourceOptions ?? {})) {
  for (const [key, value] of Object.entries(settings)) {
    if (Array.isArray(value) && value.length) {
      failures.push(`config/default.json: ${provider}.${key} contains private source selections`);
    }
  }
}

const catalog = JSON.parse(await readFile(
  path.join(root, "skills/job-application/references/sources.json"), "utf8"
));
const configuredSources = [
  ...(catalog.autonomousDiscovery?.serverAdapters ?? []),
  ...(catalog.autonomousDiscovery?.visibleBrowserSources ?? []),
  ...(catalog.userControlled ?? [])
];
if (configuredSources.length || (catalog.autonomousDiscovery?.priorityOrder ?? []).length) {
  failures.push("skills/job-application/references/sources.json: source catalog is not empty");
}

if (failures.length) {
  console.error(`Repository privacy check failed:\n- ${[...new Set(failures)].join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log(`Repository privacy check passed for ${tracked.length} tracked files.`);
}
