import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
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
