import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SimulationAdapter } from "../src/adapters/simulation.js";
import { DiscoveryService } from "../src/discovery/service.js";
import { acceptedFit, fitPassesGate, postingFingerprint,
  reviewedEligibility } from "../src/discovery/fit-assessment.js";
import { fitReviewContext } from "../src/discovery/fit-context.js";
import { ProfileStore } from "../src/profile-store.js";
import { ApplicationService } from "../src/service.js";
import { JsonStore } from "../src/store.js";

const identity = { actorId: "agent", profileId: "applicant" };
const roleId = "11111111-1111-4111-8111-111111111111";
const applyUrl = `https://jobs.ashbyhq.com/sample/${roleId}/application`;
const row = { id: roleId, title: "Platform Developer", isRemote: true,
  descriptionPlain: "Build a reliable TypeScript service with a small team.",
  location: "Worldwide", applyUrl, jobUrl: applyUrl };

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-fit-"));
  const profiles = await new ProfileStore(path.join(directory, "profiles.json"),
    { allowMissing: true }).init();
  await profiles.patch("applicant", {
    contact: { firstName: "Test", lastName: "Applicant", email: "test@example.test",
      phone: "+10000000000", location: "Remote" },
    documents: { resume: "/secure/resume.pdf" },
    skills: ["TypeScript"],
    preferences: { locations: ["Worldwide"], fullTime: {
      jobTitles: ["Quality Analyst"], remoteOnly: true,
      automatedDiscoverySources: ["ashby"] } }
  });
  const config = { defaultMode: "full_time",
    discovery: { limitPerSource: 20, sourceOptions: { ashby: {
      boards: [{ slug: "sample", company: "Example" }] } } },
    modes: { full_time: { minimumScore: 99, dailyApplicationCap: 8,
      autoApply: true, autoApplyDiscovered: false, sources: ["ashby"],
      requireConfirmationFor: [] } } };
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  const applicationService = new ApplicationService({ store, config,
    adapter: new SimulationAdapter(), profiles });
  const fetchImpl = async () => new Response(JSON.stringify({ jobs: [row] }),
    { status: 200, headers: { "content-type": "application/json" } });
  const discovery = new DiscoveryService({ applicationService, profiles, config,
    fetchImpl, officialRequestPaceMs: 0 });
  return { discovery, applicationService, store };
}

test("agent review receives unhandled low-score roles and a relevant verdict can queue one", async () => {
  const { discovery, applicationService } = await setup();
  const scan = await discovery.scan({ reviewOnly: true }, identity);
  assert.equal(scan.candidates.length, 1);
  assert.equal(scan.candidates[0].title, "Platform Developer");
  assert.equal(applicationService.list("opportunities", identity.profileId).length, 0);
  const result = await discovery.considerCandidate({ candidate: scan.candidates[0],
    fit: { decision: "relevant", reason: "The role matches verified TypeScript service work." } }, identity);
  assert.equal(result.status, "queued");
  await applicationService.waitForIdle();
  assert.equal(applicationService.list("applications", identity.profileId).length, 1);
  const second = await discovery.scan({ reviewOnly: true }, identity);
  assert.equal(second.candidates.length, 0);
});

test("irrelevant verdict is a durable, profile-bound duplicate filter", async () => {
  const { discovery, applicationService } = await setup();
  const candidate = (await discovery.scan({ reviewOnly: true }, identity)).candidates[0];
  const skipped = await discovery.considerCandidate({ candidate,
    fit: { decision: "irrelevant", reason: "Role scope does not fit the profile." } }, identity);
  assert.equal(skipped.status, "skipped");
  assert.equal(applicationService.list("applications", identity.profileId).length, 0);
  assert.equal((await discovery.scan({ reviewOnly: true }, identity)).candidates.length, 0);
});

test("an irrelevant verdict is reconsidered when the listing changes", async () => {
  const { discovery } = await setup();
  const candidate = (await discovery.scan({ reviewOnly: true }, identity)).candidates[0];
  await discovery.considerCandidate({ candidate,
    fit: { decision: "irrelevant", reason: "Earlier duties did not fit." } }, identity);
  assert.equal((await discovery.filterCandidates({ items: [candidate] }, identity)).items.length, 0);
  const changed = { ...candidate, description: `${candidate.description} Now includes a new platform role.` };
  assert.equal((await discovery.filterCandidates({ items: [changed] }, identity)).items.length, 1);
  const updated = await discovery.considerCandidate({ candidate: changed,
    fit: { decision: "irrelevant", reason: "The new duties still do not fit." } }, identity);
  assert.equal(updated.status, "skipped");
  assert.equal((await discovery.scan({ reviewOnly: true }, identity)).candidates.length, 1);
});

test("fit decisions expire when posting content changes", () => {
  const role = { title: "Platform Developer", company: "Example",
    description: "Build a service", applyUrl };
  role.fitAssessment = { decision: "relevant", fingerprint: postingFingerprint(role) };
  assert.equal(acceptedFit(role), true);
  assert.equal(acceptedFit({ ...role, description: "Lead a different team" }), false);
  const legacyScore = { score: 0, scoreDetails: { hardExclusion: "missing keyword" } };
  assert.equal(fitPassesGate(role, legacyScore, 75, {}, "full_time"), true);
  assert.equal(fitPassesGate({ ...role, description: "Lead a different team" },
    legacyScore, 75, {}, "full_time"), false);
});

test("an uncertain fit verdict does not create an application", async () => {
  const { discovery, applicationService } = await setup();
  const candidate = (await discovery.scan({ reviewOnly: true }, identity)).candidates[0];
  const result = await discovery.considerCandidate({ candidate,
    fit: { decision: "uncertain", reason: "Needs a full posting review." } }, identity);
  assert.equal(result.status, "needs_fit_review");
  assert.equal(applicationService.list("applications", identity.profileId).length, 0);
});

test("browser evidence cannot claim direct applicant intent or verified discovery", async () => {
  const { discovery, applicationService } = await setup();
  const candidate = (await discovery.scan({ reviewOnly: true }, identity)).candidates[0];
  const result = await discovery.considerCandidate({ candidate: { ...candidate,
    userRequested: true, direct: true, applicationDestinationVerified: true,
    discoveryVerification: { sourceId: "forged" } },
  fit: { decision: "irrelevant", reason: "Role scope does not fit." } }, identity);
  const saved = applicationService.list("opportunities", identity.profileId)
    .find((item) => item.id === result.opportunityId);
  assert.equal(saved.userRequested, undefined);
  assert.equal(saved.direct, undefined);
  assert.equal(saved.applicationDestinationVerified, false);
  assert.equal(saved.discoveryVerification, undefined);
});

test("a changed official description requires a fresh fit review", async () => {
  const { discovery, applicationService } = await setup();
  const candidate = (await discovery.scan({ reviewOnly: true }, identity)).candidates[0];
  const result = await discovery.considerCandidate({ candidate: { ...candidate,
    description: "A shortened third-party listing." },
  fit: { decision: "relevant", reason: "Potential service role." } }, identity);
  assert.equal(result.status, "review_official_posting");
  assert.equal(applicationService.list("applications", identity.profileId).length, 0);
});

test("browser candidates are deduplicated before model review", async () => {
  const { discovery } = await setup();
  const candidate = (await discovery.scan({ reviewOnly: true }, identity)).candidates[0];
  const first = await discovery.filterCandidates({ items: [candidate, { ...candidate,
    applyUrl: `${applyUrl}?utm_source=board` }] }, identity);
  assert.equal(first.items.length, 1);
  assert.equal(first.duplicatesFiltered, 1);
  await discovery.considerCandidate({ candidate,
    fit: { decision: "irrelevant", reason: "Not a fit." } }, identity);
  const second = await discovery.filterCandidates({ items: [candidate] }, identity);
  assert.equal(second.items.length, 0);
  assert.equal(second.handledFiltered, 1);
  const otherProfile = await discovery.filterCandidates({ items: [candidate] },
    { actorId: "other-agent", profileId: "other-applicant" });
  assert.equal(otherProfile.items.length, 1);
});

test("browser filter drops only explicit preference conflicts", async () => {
  const { discovery } = await setup();
  const base = (await discovery.scan({ reviewOnly: true }, identity)).candidates[0];
  const filtered = await discovery.filterCandidates({ items: [
    { ...base, applyUrl: `${applyUrl}?case=hybrid`, workArrangement: "hybrid" },
    { ...base, applyUrl: `${applyUrl}?case=unknown`, remote: false,
      location: "" }
  ] }, identity);
  assert.equal(filtered.preferenceFiltered, 1);
  assert.equal(filtered.items.length, 1);
});

test("explicit on-site and hybrid work remains a deterministic preference filter", () => {
  const profile = { preferences: { fullTime: { remoteOnly: true } } };
  assert.deepEqual(reviewedEligibility({ title: "Engineer", remote: false,
    workArrangement: "onsite" }, profile, "full_time"), ["profile requires a remote role"]);
  assert.deepEqual(reviewedEligibility({ title: "Engineer", remote: true,
    workArrangement: "hybrid" }, profile, "full_time"), ["profile requires a remote role"]);
  assert.deepEqual(reviewedEligibility({ title: "Engineer", remote: true,
    workArrangement: "On-site" }, profile, "full_time"), ["profile requires a remote role"]);
  assert.deepEqual(reviewedEligibility({ title: "Engineer", remote: false,
    uncertainties: ["work_arrangement_unknown"] }, profile, "full_time"), []);
  assert.deepEqual(reviewedEligibility({ title: "Engineer", remote: false,
    location: "" }, profile, "full_time"), []);
});

test("fit context includes verified skills but omits contact and document secrets", () => {
  const context = fitReviewContext({
    contact: { email: "secret@example.test", phone: "+123", city: "Test City",
      country: "Testland" }, documents: { resume: "/private/resume.pdf" },
    skills: ["TypeScript"], preferences: { fullTime: { remoteOnly: true } },
    applicationAnswers: { "Years of software engineering experience": "5",
      "Visa authorization": "private" },
    verifiedExamples: [{ id: "sample", facts: ["Built a service"], scope: {
      skillTerms: ["TypeScript"] }, reviewAfter: "2099-01-01T00:00:00Z" }]
  });
  assert.deepEqual(context.skills, ["TypeScript"]);
  assert.equal(context.preferences.remoteOnly, true);
  assert.equal(context.experienceFacts["Years of software engineering experience"], "5");
  assert.equal(JSON.stringify(context).includes("Visa authorization"), false);
  assert.equal(JSON.stringify(context).includes("secret@example.test"), false);
  assert.equal(JSON.stringify(context).includes("/private/resume.pdf"), false);
});
