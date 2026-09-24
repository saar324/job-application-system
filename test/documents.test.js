import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DocumentStager } from "../src/documents.js";
import { NeedsInputError } from "../src/adapters/errors.js";
import { validateWorkerPayload } from "../worker/document-policy.js";

async function fixture(maxBytes = 100) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-documents-test-"));
  const source = path.join(directory, "source");
  const staging = path.join(directory, "staging");
  await Promise.all([mkdir(source), mkdir(staging)]);
  return { directory, source, staging, stager: new DocumentStager({ sourceRoots: [source], stagingRoot: staging, maxBytes }) };
}

test("document stager copies an approved regular resume to a fixed name", async () => {
  const { source, staging, stager } = await fixture();
  const resume = path.join(source, "candidate.pdf");
  await writeFile(resume, "resume");
  const profile = await stager.stage({ id: "application-one" }, { id: "person-one", documents: { resume } });
  assert.equal(profile.documents.resume, path.join(staging, "application-one", "resume.pdf"));
  await validateWorkerPayload({
    application: { id: "application-one", profileId: "person-one" },
    profile, opportunity: { applyUrl: "https://example.test" }
  }, staging);
});

test("document stager grants the worker group read access to private source documents", async () => {
  const { source, staging, stager } = await fixture();
  const resume = path.join(source, "private.pdf");
  await writeFile(resume, "resume", { mode: 0o600 });
  await chmod(resume, 0o600);
  const profile = await stager.stage({ id: "application-one" },
    { id: "person-one", documents: { resume } });
  const [root, directory, staged] = await Promise.all([
    stat(staging), stat(path.dirname(profile.documents.resume)), stat(profile.documents.resume)
  ]);
  assert.equal(staged.gid, root.gid);
  assert.equal(staged.mode & 0o777, 0o640);
  assert.equal(directory.gid, root.gid);
  assert.equal(directory.mode & 0o7777, 0o750);
  assert.equal((await stat(resume)).mode & 0o777, 0o600);
});

test("document stager clears a previous setgid application directory", async () => {
  const { source, staging, stager } = await fixture();
  const directory = path.join(staging, "application-one");
  await mkdir(directory, { mode: 0o750 });
  await chmod(directory, 0o2750);
  const resume = path.join(source, "candidate.pdf");
  await writeFile(resume, "resume", { mode: 0o600 });
  await stager.stage({ id: "application-one" },
    { id: "person-one", documents: { resume } });
  assert.equal((await stat(directory)).mode & 0o7777, 0o750);
});

test("document stager rejects escape symlinks, unsupported files, and oversized files", async () => {
  const { directory, source, stager } = await fixture(8);
  const outside = path.join(directory, "outside.pdf");
  await writeFile(outside, "outside");
  const link = path.join(source, "escape.pdf");
  await symlink(outside, link);
  await assert.rejects(stager.stage({ id: "application-one" }, { documents: { resume: link } }), NeedsInputError);
  const script = path.join(source, "resume.sh");
  await writeFile(script, "echo hi");
  await assert.rejects(stager.stage({ id: "application-two" }, { documents: { resume: script } }),
    (error) => error.requirements?.[0]?.message.includes("unsupported file extension"));
  const large = path.join(source, "large.pdf");
  await writeFile(large, "123456789");
  await assert.rejects(stager.stage({ id: "application-three" }, { documents: { resume: large } }),
    (error) => error.requirements?.[0]?.message.includes("exceeds"));
});

test("worker document policy rejects arbitrary and cross-application paths", async () => {
  const { staging } = await fixture();
  await mkdir(path.join(staging, "application-one"));
  const payload = {
    application: { id: "application-one", profileId: "person-one" },
    profile: { id: "person-one", documents: { resume: "/etc/passwd" } },
    opportunity: { applyUrl: "https://example.test" }
  };
  await assert.rejects(validateWorkerPayload(payload, staging), /outside its application boundary/);
});

test("worker document policy rejects unreadable staged files before browser entry",
  { skip: process.getuid?.() === 0 }, async () => {
    const { source, staging, stager } = await fixture();
    const resume = path.join(source, "candidate.pdf");
    await writeFile(resume, "resume");
    const profile = await stager.stage({ id: "application-one" },
      { id: "person-one", documents: { resume } });
    await chmod(profile.documents.resume, 0o000);
    await assert.rejects(validateWorkerPayload({
      application: { id: "application-one", profileId: "person-one" },
      profile, opportunity: { applyUrl: "https://example.test" }
    }, staging), /not readable by the worker/);
  });
