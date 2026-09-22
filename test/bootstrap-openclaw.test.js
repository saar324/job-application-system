import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);

test("OpenClaw refresh preserves private source and writing-style references", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-openclaw-test-"));
  const workspace = path.join(directory, "workspace");
  const installedReferences = path.join(workspace, "skills/job-application/references");
  const fakeBin = path.join(directory, "bin");
  const tokensFile = path.join(directory, "tokens.json");
  await mkdir(installedReferences, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  const privateSources = JSON.stringify({ version: 1, privateSourceMarker: "preserve-source" });
  const privateStyle = JSON.stringify({ version: 1, privateStyleMarker: "preserve-style" });
  await writeFile(path.join(installedReferences, "sources.json"), privateSources);
  await writeFile(path.join(installedReferences, "writing-style.json"), privateStyle);
  await writeFile(tokensFile, "{}\n");

  const fakeOpenClaw = path.join(fakeBin, "openclaw");
  await writeFile(fakeOpenClaw, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "agents" && args[1] === "list") {
  process.stdout.write('[{"id":"applicant-one"}]\\n');
} else if (args[0] === "skills" && args[1] === "install") {
  const target = path.join(process.env.FAKE_WORKSPACE, "skills/job-application");
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.join(target, "references"), { recursive: true });
  fs.writeFileSync(path.join(target, "references/sources.json"), '{"neutral":true}\\n');
  fs.writeFileSync(path.join(target, "references/writing-style.json"), '{"neutral":true}\\n');
}
`);
  await chmod(fakeOpenClaw, 0o755);

  const result = await execute(process.execPath, [
    "scripts/bootstrap-openclaw.js",
    "--agent", "applicant-one",
    "--profile", "applicant-one",
    "--workspace", workspace,
    "--tokens-file", tokensFile
  ], {
    env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`, FAKE_WORKSPACE: workspace }
  });

  assert.deepEqual(
    JSON.parse(await readFile(path.join(installedReferences, "sources.json"), "utf8")),
    JSON.parse(privateSources)
  );
  assert.deepEqual(
    JSON.parse(await readFile(path.join(installedReferences, "writing-style.json"), "utf8")),
    JSON.parse(privateStyle)
  );
  assert.match(result.stdout, /"privateReferencesRestored"/);
  assert.doesNotMatch(result.stdout, /preserve-source|preserve-style/);
});
