#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root })
  .toString("utf8").split("\0").filter(Boolean);
const failures = [];

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
  [/(?:^|["'\s=])\/home\/(?!applicant|jobapp)[A-Za-z0-9._-]+\//m, "absolute user home path"]
];
const emailPattern = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi;

for (const file of tracked) {
  let contents;
  try { contents = await readFile(path.join(root, file), "utf8"); }
  catch { continue; }
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
