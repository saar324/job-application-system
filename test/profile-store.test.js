import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProfileStore } from "../src/profile-store.js";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-profile-test-"));
  const file = path.join(directory, "profiles.json");
  return { file, store: await new ProfileStore(file, { allowMissing: true }).init() };
}

test("profile status reports only genuinely missing onboarding fields", async () => {
  const { store } = await fixture();
  const before = await store.status("applicant-one");
  assert.equal(before.readyToApply, false);
  assert.ok(before.missingForApplications.includes("contact.email"));

  const after = await store.patch("applicant-one", {
    contact: {
      firstName: "Applicant", lastName: "Example", email: "applicant-one@example.test",
      phone: "+10000000000", location: "Remote"
    },
    documents: { resume: "/secure/resume.pdf" },
    skills: ["TypeScript"],
    preferences: { locations: ["remote"], fullTime: { jobTitles: ["Software Engineer"] } }
  });
  assert.equal(after.readyToApply, true);
  assert.equal(after.readyToSearch, true);
});

test("profile identity cannot be overwritten by profile content", async () => {
  const { file, store } = await fixture();
  await assert.rejects(store.patch("applicant-one", { id: "applicant-two" }), /not allowed/);
  await store.patch("applicant-one", { displayName: "Applicant" });
  const document = JSON.parse(await readFile(file, "utf8"));
  assert.equal(document.profiles[0].id, "applicant-one");
});

test("requested mode controls readiness without changing the stored default", async () => {
  const { store } = await fixture();
  await store.patch("applicant-one", {
    defaultMode: "full_time",
    skills: ["TypeScript"],
    preferences: {
      locations: ["remote"], fullTime: { jobTitles: ["Engineer"] }, freelance: { services: [] }
    }
  });
  assert.equal((await store.status("applicant-one", "full_time")).readyToSearch, true);
  assert.equal((await store.status("applicant-one", "freelance")).readyToSearch, false);
});

test("profile submission approval supports automatic or always only", async () => {
  const { store } = await fixture();
  await store.patch("applicant-one", { preferences: { fullTime: { submissionApproval: "always" } } });
  assert.equal((await store.get("applicant-one")).preferences.fullTime.submissionApproval, "always");
  await assert.rejects(
    store.patch("applicant-one", { preferences: { fullTime: { submissionApproval: "sometimes" } } }),
    /must be automatic or always/
  );
});

test("profile application cap overrides are bounded and zero disables them", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-profile-test-"));
  const file = path.join(directory, "profiles.json");
  await writeFile(file, JSON.stringify({ profiles: [] }));
  const profiles = await new ProfileStore(file).init();
  await profiles.patch("applicant-one", {
    preferences: { maxApplicationsPerDay: 70, fullTime: { dailyApplicationCap: 70 } }
  });
  await profiles.patch("applicant-one", {
    preferences: { maxApplicationsPerDay: 0, fullTime: { dailyApplicationCap: 0 } }
  });
  assert.equal((await profiles.get("applicant-one")).preferences.maxApplicationsPerDay, 0);
  await assert.rejects(
    profiles.patch("applicant-one", { preferences: { maxApplicationsPerDay: 101 } }),
    /must be an integer from 0 to 100/
  );
});
