#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashedTokenKey } from "../src/token-keys.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function options(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, "");
    if (!key || argv[index + 1] === undefined) throw new Error(`invalid option: ${argv[index]}`);
    result[key] = argv[index + 1];
  }
  return result;
}

function openclaw(args) {
  const result = spawnSync("openclaw", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `openclaw ${args[0]} failed`);
  return result.stdout;
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function secureWrite(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, value, { mode: 0o600 });
  await rename(temporary, file);
}

const input = options(process.argv.slice(2));
for (const required of ["agent", "profile", "workspace"]) {
  if (!input[required]) throw new Error(`--${required} is required`);
}
if (!/^[a-zA-Z0-9_-]{1,80}$/.test(input.agent) || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.profile)) {
  throw new Error("agent and profile IDs may contain only letters, numbers, underscore, and hyphen");
}

const workspace = path.resolve(input.workspace);
const serverUrl = input["server-url"] ?? "http://127.0.0.1:4310";
const tokensFile = path.resolve(input["tokens-file"] ?? path.join(projectRoot, "data/tokens.json"));
const installedSkill = path.join(workspace, "skills/job-application");
const privateReferences = new Map();
for (const [name, option] of [["sources.json", "sources-file"], ["writing-style.json", "writing-style-file"]]) {
  const source = input[option]
    ? path.resolve(input[option])
    : path.join(installedSkill, "references", name);
  try {
    const contents = await readFile(source, "utf8");
    JSON.parse(contents);
    privateReferences.set(name, contents.endsWith("\n") ? contents : `${contents}\n`);
  } catch (error) {
    if (input[option] || error.code !== "ENOENT") throw error;
  }
}
const agents = JSON.parse(openclaw(["agents", "list", "--json"]));
if (!agents.some((entry) => entry.id === input.agent)) {
  openclaw(["agents", "add", input.agent, "--workspace", workspace, "--non-interactive", "--json"]);
}

openclaw([
  "skills", "install", path.join(projectRoot, "skills/job-application"),
  "--agent", input.agent, "--as", "job-application", "--force"
]);
for (const [name, contents] of privateReferences) {
  await secureWrite(path.join(installedSkill, "references", name), contents);
}
openclaw([
  "config", "set", `channels.telegram.accounts.${input["telegram-account"] ?? input.agent}.capabilities.inlineButtons`,
  JSON.stringify("dm"), "--strict-json"
]);

const token = randomBytes(32).toString("base64url");
const tokenMap = await readJson(tokensFile, {});
for (const [existingToken, identity] of Object.entries(tokenMap)) {
  if (identity.actorId === `${input.agent}-openclaw`
    && !identity.roles?.includes("owner")) {
    delete tokenMap[existingToken];
  }
}
tokenMap[hashedTokenKey(token)] = { actorId: `${input.agent}-openclaw`, profileId: input.profile,
  roles: ["agent"] };
await secureWrite(tokensFile, `${JSON.stringify(tokenMap, null, 2)}\n`);

await secureWrite(path.join(installedSkill, ".job-server-token"), `${token}\n`);
await secureWrite(path.join(installedSkill, ".job-server-url"), `${serverUrl}\n`);

console.log(JSON.stringify({
  agent: input.agent,
  profile: input.profile,
  workspace,
  installedSkill,
  tokensFile,
  privateReferencesRestored: [...privateReferences.keys()],
  credentialRotated: true
}, null, 2));
