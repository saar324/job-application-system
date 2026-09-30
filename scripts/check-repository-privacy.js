#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

const root = process.env.PRIVACY_REPOSITORY_ROOT
  ? path.resolve(process.env.PRIVACY_REPOSITORY_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root })
  .toString("utf8").split("\0").filter(Boolean);
const failures = [];
const privateDenylist = decodePrivateDenylist(process.env.PRIVACY_DENYLIST_B64);
if (process.env.PRIVACY_DENYLIST_REQUIRED === "true" && privateDenylist.length === 0) {
  failures.push("encrypted private denylist is required but unavailable");
}

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
  inspectContents(file, contents);
}

const historicalPaths = execFileSync("git", ["log", "HEAD", "--name-only", "--format="], { cwd: root })
  .toString("utf8").split(/\r?\n/).filter(Boolean);
for (const file of historicalPaths) {
  if (file === ".env.example") continue;
  if (forbiddenPaths.some((pattern) => pattern.test(file))) {
    failures.push(`${file}: private path exists in Git history`);
  }
}

const commitLines = execFileSync("git", ["log", "HEAD", "--format=%H%x00%an%x00%ae"], { cwd: root })
  .toString("utf8").split(/\r?\n/).filter(Boolean);
for (const line of commitLines) {
  const [commit, authorName, authorEmail] = line.split("\0");
  if (matchesPrivateDenylist(`${authorName ?? ""}\n${authorEmail ?? ""}`)) {
    failures.push(`commit ${commit}: author metadata matches encrypted deployment-specific denylist`);
  }
  const domain = authorEmail?.split("@").at(-1)?.toLowerCase();
  if (authorEmail && domain !== "users.noreply.github.com"
    && !["example.com", "example.org", "example.net", "example.test", "example.invalid"].includes(domain)) {
    failures.push(`commit ${commit}: author email must use a GitHub no-reply or example address`);
  }
}

const objectLines = execFileSync("git", ["rev-list", "--objects", "HEAD"], { cwd: root })
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
  if (matchesPrivateDenylist(contents)) {
    failures.push(`${file}: matches encrypted deployment-specific denylist`);
  }
}

function matchesPrivateDenylist(contents) {
  const normalized = contents.toLocaleLowerCase("en-US");
  return privateDenylist.some((value) => {
    if (!/^[\p{L}\p{N}_-]+$/u.test(value)) return normalized.includes(value);
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, "iu").test(contents);
  });
}

function decodePrivateDenylist(encoded) {
  if (!encoded) return [];
  return [...new Set(Buffer.from(encoded, "base64").toString("utf8")
    .split(/\r?\n/)
    .map((value) => value.trim().toLocaleLowerCase("en-US"))
    .filter((value) => value.length >= 3))];
}

const defaults = JSON.parse(await readFile(path.join(root, "config/default.json"), "utf8"));
for (const [mode, settings] of Object.entries(defaults.modes ?? {})) {
  if ((settings.sources ?? []).length) failures.push(`config/default.json: ${mode} enables sources`);
  if (settings.autoApply || settings.autoApplyDiscovered) {
    failures.push(`config/default.json: ${mode} enables automatic application`);
  }
}

const starterConfig = JSON.parse(await readFile(path.join(root, "config/discovery.example.json"), "utf8"));
const publicFeedIds = ["remoteok", "arbeitnow", "jobicy", "himalayas"];
const expectedStarterConfig = {
  execution: { adapter: "simulation" },
  modes: Object.fromEntries(["full_time", "freelance"].map((mode) => [mode, {
    sources: publicFeedIds, autoApply: false, autoApplyDiscovered: false,
    submissionApproval: "always"
  }]))
};
if (!isDeepStrictEqual(starterConfig, expectedStarterConfig)) {
  failures.push("config/discovery.example.json: starter must contain only neutral public feeds and simulation settings");
}
for (const [provider, settings] of Object.entries(defaults.discovery?.sourceOptions ?? {})) {
  for (const [key, value] of Object.entries(settings)) {
    if (Array.isArray(value) && value.length) {
      failures.push(`config/default.json: ${provider}.${key} contains private source selections`);
    }
  }
}

const exampleProfileDocument = JSON.parse(await readFile(
  path.join(root, "config/profiles.example.json"), "utf8"
));
const exampleProfiles = exampleProfileDocument.profiles ?? [];
if (exampleProfiles.length !== 1) failures.push("config/profiles.example.json: expected one neutral example profile");
for (const profile of exampleProfiles) {
  requireExampleValue("id", profile.id, "applicant-one");
  requireExampleValue("displayName", profile.displayName, "Applicant One");
  requireExampleValue("defaultMode", profile.defaultMode, "full_time");
  for (const field of ["firstName", "lastName", "phone", "location", "city", "country"]) {
    requireExampleValue(`contact.${field}`, profile.contact?.[field], "REPLACE_ME");
  }
  requireExampleValue("contact.email", profile.contact?.email, "applicant@example.test");
  for (const field of ["linkedin", "github", "portfolio"]) {
    requireExampleValue(`links.${field}`, profile.links?.[field], "REPLACE_ME");
  }
  requireExampleValue("documents.resume", profile.documents?.resume, "REPLACE_ME");
  requireEmptyArray("skills", profile.skills);
  requireEmptyArray("preferences.locations", profile.preferences?.locations);
  requireEmptyArray("preferences.fullTime.jobTitles", profile.preferences?.fullTime?.jobTitles);
  requireEmptyArray(
    "preferences.fullTime.automatedDiscoverySources",
    profile.preferences?.fullTime?.automatedDiscoverySources
  );
  requireEmptyArray("preferences.freelance.services", profile.preferences?.freelance?.services);
  requireEmptyArray(
    "preferences.freelance.automatedDiscoverySources",
    profile.preferences?.freelance?.automatedDiscoverySources
  );
  for (const field of [
    "minimumCompensation", "minimumNetCompensation", "minimumUnspecifiedCompensation", "minimumHourlyRate"
  ]) {
    requireExampleValue(`preferences.${field}`, profile.preferences?.[field], 0);
  }
  requireExampleValue("preferences.compensationCurrency", profile.preferences?.compensationCurrency, "REPLACE_ME");
  if (Object.keys(profile.applicationAnswers ?? {}).length) {
    failures.push("config/profiles.example.json: applicationAnswers must stay empty");
  }
}
const expectedProfileDocument = { profiles: [{
  id: "applicant-one",
  displayName: "Applicant One",
  defaultMode: "full_time",
  contact: {
    firstName: "REPLACE_ME", lastName: "REPLACE_ME", email: "applicant@example.test",
    phone: "REPLACE_ME", location: "REPLACE_ME", city: "REPLACE_ME", country: "REPLACE_ME"
  },
  links: { linkedin: "REPLACE_ME", github: "REPLACE_ME", portfolio: "REPLACE_ME" },
  preferences: {
    locations: [], minimumCompensation: 0, minimumNetCompensation: 0,
    minimumUnspecifiedCompensation: 0, compensationCurrency: "REPLACE_ME",
    compensationPeriod: "month", minimumHourlyRate: 0,
    fullTime: { jobTitles: [], automatedDiscoverySources: [] },
    freelance: { services: [], automatedDiscoverySources: [] }
  },
  skills: [], documents: { resume: "REPLACE_ME" }, applicationAnswers: {}
}] };
if (!isDeepStrictEqual(exampleProfileDocument, expectedProfileDocument)) {
  failures.push("config/profiles.example.json: template must match the exact neutral public schema");
}

function requireExampleValue(field, actual, expected) {
  if (actual !== expected) failures.push(`config/profiles.example.json: ${field} must remain neutral`);
}

function requireEmptyArray(field, actual) {
  if (!Array.isArray(actual) || actual.length !== 0) {
    failures.push(`config/profiles.example.json: ${field} must stay empty`);
  }
}

const catalog = JSON.parse(await readFile(
  path.join(root, "skills/job-application/references/sources.json"), "utf8"
));
const expectedCatalog = {
  version: 1,
  purpose: "Private source catalog template. Add sources only in your private deployment copy.",
  tagDefinitions: {
    countries: "Countries or regions with listing coverage; this does not prove applicant eligibility.",
    employmentTypes: ["full_time", "contract", "freelance", "part_time", "internship"],
    fields: [], seniority: [],
    languages: "Languages supported by the source or commonly used in its listings.",
    remoteScopes: ["country", "regional", "worldwide", "country_restricted"]
  },
  searchPolicy: {
    residenceCountry: "", preferredSeniority: [], excludedSeniority: [],
    preferredRemoteScopes: [], targetEmployerRegions: [], priorityEmployerCountries: [],
    acceptableEngagements: [], screeningRules: []
  },
  autonomousDiscovery: { priorityOrder: [], serverAdapters: [], visibleBrowserSources: [] },
  userControlled: []
};
if (!isDeepStrictEqual(catalog, expectedCatalog)) {
  failures.push("skills/job-application/references/sources.json: catalog must match the exact neutral public template");
}
const configuredSources = [
  ...(catalog.autonomousDiscovery?.serverAdapters ?? []),
  ...(catalog.autonomousDiscovery?.visibleBrowserSources ?? []),
  ...(catalog.userControlled ?? [])
];
if (configuredSources.length || (catalog.autonomousDiscovery?.priorityOrder ?? []).length) {
  failures.push("skills/job-application/references/sources.json: source catalog is not empty");
}
for (const [field, value] of Object.entries(catalog.searchPolicy ?? {})) {
  if ((Array.isArray(value) && value.length) || (typeof value === "string" && value)) {
    failures.push(`skills/job-application/references/sources.json: searchPolicy.${field} is personalized`);
  }
}
for (const field of ["fields", "seniority"]) {
  if ((catalog.tagDefinitions?.[field] ?? []).length) {
    failures.push(`skills/job-application/references/sources.json: tagDefinitions.${field} is personalized`);
  }
}

const publicCatalog = JSON.parse(await readFile(
  path.join(root, "skills/job-application/references/public-sources.json"), "utf8"
));
const expectedPublicCatalog = {
  version: 1,
  purpose: "Public starter sources only. Choose applicant preferences, regions, and employer boards in private configuration.",
  searchPolicy: expectedCatalog.searchPolicy,
  autonomousDiscovery: {
    priorityOrder: [],
    serverAdapters: [
      ["remoteok", "Remote OK", "https://remoteok.com/"],
      ["arbeitnow", "Arbeitnow", "https://www.arbeitnow.com/"],
      ["jobicy", "Jobicy", "https://jobicy.com/"],
      ["himalayas", "Himalayas", "https://himalayas.app/jobs"],
      ["ashby", "Ashby", "https://jobs.ashbyhq.com/"],
      ["greenhouse", "Greenhouse", "https://job-boards.greenhouse.io/"],
      ["lever", "Lever", "https://jobs.lever.co/"],
      ["workable", "Workable", "https://apply.workable.com/"]
    ].map(([id, name, url]) => ({ id, name, url })),
    visibleBrowserSources: [
      ["jobgether", "Jobgether", "https://jobgether.com/"],
      ["remotive", "Remotive", "https://remotive.com/remote-jobs"],
      ["weworkremotely", "We Work Remotely", "https://weworkremotely.com/remote-jobs"],
      ["workingnomads", "Working Nomads", "https://www.workingnomads.com/"],
      ["wellfound", "Wellfound", "https://wellfound.com/jobs"],
      ["ycombinator", "Y Combinator Work at a Startup", "https://www.ycombinator.com/jobs/role/all"]
    ].map(([id, name, url]) => ({ id, name, url }))
  },
  userControlled: []
};
if (!isDeepStrictEqual(publicCatalog, expectedPublicCatalog)) {
  failures.push("skills/job-application/references/public-sources.json: only reviewed public source definitions are allowed");
}

const writingStyle = JSON.parse(await readFile(
  path.join(root, "skills/job-application/references/writing-style.json"), "utf8"
));
const expectedWritingStyle = {
  version: 1,
  purpose: "Neutral default. Replace this file only in a private deployment to reflect an applicant's own voice.",
  scope: ["job application free-text fields", "cover letters", "important application messages"],
  voice: {
    person: "first person", tone: ["clear", "specific", "professional"],
    evidence: "Use only truthful facts from the applicant's profile, resume, portfolio, saved answers, and the job listing.",
    claims: "Do not invent experience, skills, metrics, credentials, dates, work rights, or motivation."
  },
  qualityChecks: [
    "Answer the exact prompt.", "Remove unsupported claims and placeholders.",
    "Check grammar and required length.", "Request the applicant's approval at the final submission step."
  ]
};
if (!isDeepStrictEqual(writingStyle, expectedWritingStyle)) {
  failures.push("skills/job-application/references/writing-style.json: file must match the exact neutral public template");
}
if (writingStyle.purpose !== "Neutral default. Replace this file only in a private deployment to reflect an applicant's own voice.") {
  failures.push("skills/job-application/references/writing-style.json: purpose must describe the neutral template");
}
if (JSON.stringify(writingStyle.voice?.tone) !== JSON.stringify(["clear", "specific", "professional"])) {
  failures.push("skills/job-application/references/writing-style.json: tone must remain neutral");
}

if (failures.length) {
  console.error(`Repository privacy check failed:\n- ${[...new Set(failures)].join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log(`Repository privacy check passed for ${tracked.length} tracked files.`);
}
