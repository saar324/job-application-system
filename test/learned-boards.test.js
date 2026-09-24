import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sourceConfigWithLearnedBoards, isLearnedBoardRequest,
  learnedBoardRequestsInLastDay } from "../src/discovery/learned-boards.js";
import { DiscoveryService } from "../src/discovery/service.js";
import { ProfileStore } from "../src/profile-store.js";
import { JsonStore } from "../src/store.js";
import { ApplicationService } from "../src/service.js";

const at = Date.parse("2026-09-24T08:00:00.000Z");
function role(board, profileId = "person-one", verifiedAt = "2026-09-23T08:00:00.000Z") {
  return { profileId, company: board, score: 85,
    applyUrl: `https://jobs.ashbyhq.com/${board}/11111111-1111-4111-8111-111111111111/application`,
    applicationDestinationVerified: true, applicationDestinationPending: false,
    discoveryVerification: { sourceId: "ashby", verifiedAt } };
}

test("learned ATS boards are bounded, profile scoped, current and verified", () => {
  const opportunities = [role("configured"), role("new-one"), role("new-two"),
    role("another-person", "person-two"), role("old", "person-one", "2026-07-01T00:00:00Z"),
    { ...role("unverified"), discoveryVerification: undefined },
    { ...role("pending"), applicationDestinationPending: true },
    ...Array.from({ length: 7 }, (_, index) => role(`extra-${index}`))];
  const configured = { boards: [{ slug: "configured", company: "Configured" }] };
  const result = sourceConfigWithLearnedBoards({ opportunities }, "person-one", "ashby", configured,
    { now: at, isBackedOff: (key) => key === "ashby:new-two" });
  assert.equal(result.boards.length, 6);
  assert.equal(result.boards[0].slug, "configured");
  assert.ok(result.boards.some((item) => item.slug === "new-one"));
  assert.ok(!result.boards.some((item) => ["new-two", "another-person", "old", "unverified", "pending"]
    .includes(item.slug)));
  assert.equal(configured.boards.length, 1);
});

test("a mismatched ATS identity cannot seed a different provider", () => {
  const suspicious = { ...role("new-one"),
    applyUrl: "https://jobs.lever.co/new-one/11111111-1111-4111-8111-111111111111" };
  const result = sourceConfigWithLearnedBoards({ opportunities: [suspicious] }, "person-one",
    "ashby", { boards: [] }, { now: at });
  assert.deepEqual(result.boards, []);
});

test("an agent-created role or forged seed metadata cannot add a board", () => {
  const forged = { ...role("forged"), applicationDestinationVerified: false,
    discoveryVerification: { sourceId: "agent", verifiedAt: new Date(at).toISOString() },
    seedProvenance: "owner_curated_official_role" };
  const result = sourceConfigWithLearnedBoards({ opportunities: [forged] },
    "person-one", "ashby", { boards: [] }, { now: at });
  assert.deepEqual(result.boards, []);
});

test("verified submission receipts rotate historical boards without making old roles current", () => {
  const opportunities = Array.from({ length: 12 }, (_, index) => ({
    ...role(`receipt-${index}`), id: `role-${index}`,
    applicationDestinationVerified: undefined, discoveryVerification: undefined
  }));
  const applications = opportunities.map((item, index) => ({
    profileId: "person-one", opportunityId: item.id, status: "submitted",
    receipt: { submittedAt: `2026-09-${String(23 - index).padStart(2, "0")}T08:00:00Z` }
  }));
  const state = { opportunities, applications };
  const first = sourceConfigWithLearnedBoards(state, "person-one", "ashby",
    { boards: [] }, { now: at, cycle: 0 });
  const second = sourceConfigWithLearnedBoards(state, "person-one", "ashby",
    { boards: [] }, { now: at, cycle: 1 });
  assert.equal(first.boards.length, 5);
  assert.equal(second.boards.length, 5);
  assert.equal(first.boards[0].seedProvenance, "verified_submission_receipt");
  assert.deepEqual(first.boards.map((item) => item.slug),
    ["receipt-0", "receipt-1", "receipt-2", "receipt-3", "receipt-4"]);
  assert.deepEqual(second.boards.map((item) => item.slug),
    ["receipt-5", "receipt-6", "receipt-7", "receipt-8", "receipt-9"]);
  assert.equal(opportunities[0].applicationDestinationVerified, undefined);
});

test("foreign, simulated, stale and non-ATS receipts never introduce boards", () => {
  const opportunities = [role("foreign", "person-two"), role("simulated"),
    role("stale"), { ...role("not-official"),
      applyUrl: "https://jobs.example.test/not-official" }]
    .map((item, index) => ({ ...item, id: `role-${index}`,
      discoveryVerification: undefined }));
  const applications = opportunities.map((item) => ({ profileId: item.profileId,
    opportunityId: item.id, status: "submitted",
    receipt: { submittedAt: "2026-09-23T08:00:00Z" } }));
  applications[1].receipt.simulated = true;
  applications[2].receipt.submittedAt = "2026-07-01T08:00:00Z";
  const result = sourceConfigWithLearnedBoards({ opportunities, applications }, "person-one",
    "ashby", { boards: [] }, { now: at });
  assert.deepEqual(result.boards, []);
});

test("an active board cooldown suppresses a configured board too", () => {
  const configured = { boards: [{ slug: "blocked" }, { slug: "available" }] };
  const result = sourceConfigWithLearnedBoards({ opportunities: [], applications: [] },
    "person-one", "ashby", configured,
    { now: at, isBackedOff: (key) => key === "ashby:blocked" });
  assert.deepEqual(result.boards, [{ slug: "available" }]);
  assert.equal(configured.boards.length, 2);
});

test("owner-curated official-role seeds are profile scoped, recent and reversible", () => {
  const officialRoleUrl = "https://jobs.ashbyhq.com/curated/11111111-1111-4111-8111-111111111111/application";
  const seed = { profileId: "person-one", officialRoleUrl, company: "Firm Alpha",
    reviewedAt: "2026-09-23T08:00:00Z" };
  const configured = { boards: [], ownerCuratedBoards: [seed,
    { ...seed, profileId: "person-two", officialRoleUrl: officialRoleUrl.replace("curated", "foreign") },
    { ...seed, reviewedAt: "2026-09-01T08:00:00Z",
      officialRoleUrl: officialRoleUrl.replace("curated", "stale") },
    { ...seed, officialRoleUrl: "https://example.test/role" },
    { ...seed, enabled: false, officialRoleUrl: officialRoleUrl.replace("curated", "disabled") }] };
  const result = sourceConfigWithLearnedBoards({}, "person-one", "ashby", configured, { now: at });
  assert.deepEqual(result.boards.map((item) => item.slug), ["curated"]);
  assert.equal(result.boards[0].seedProvenance, "owner_curated_official_role");
  assert.equal(result.boards[0].seedProfileId, "person-one");
  assert.deepEqual(sourceConfigWithLearnedBoards({}, "person-two", "ashby",
    { boards: [], ownerCuratedBoards: [seed] }, { now: at }).boards, []);
  assert.deepEqual(sourceConfigWithLearnedBoards({}, "person-one", "ashby",
    { ...configured, disabledBoardKeys: ["ashby:curated"] }, { now: at }).boards, []);
  assert.deepEqual(sourceConfigWithLearnedBoards({}, "person-one", "ashby", configured,
    { now: at, isAtRequestBudget: (key) => key === "ashby:curated" }).boards, []);
});

test("learned-board request classification and rolling count are exact and scoped", () => {
  const keys = new Set(["ashby:curated", "greenhouse:curated", "lever:curated"]);
  assert.equal(isLearnedBoardRequest("ashby",
    "https://api.ashbyhq.com/posting-api/job-board/CURATED", keys), "ashby:curated");
  assert.equal(isLearnedBoardRequest("greenhouse",
    "https://boards-api.greenhouse.io/v1/boards/curated/jobs?content=true", keys),
  "greenhouse:curated");
  assert.equal(isLearnedBoardRequest("lever",
    "https://api.lever.co/v0/postings/curated?mode=json", keys), "lever:curated");
  assert.equal(isLearnedBoardRequest("greenhouse",
    "https://boards-api.greenhouse.io/v1/boards/curated/jobs/123", keys), null);
  assert.equal(isLearnedBoardRequest("ashby",
    "https://attacker.example/posting-api/job-board/curated", keys), null);
  const audit = [
    { profileId: "person-one", action: "discovery.ats_learned_board_request",
      subjectId: "ashby:curated", at: "2026-09-23T09:00:00Z" },
    { profileId: "person-two", action: "discovery.ats_learned_board_request",
      subjectId: "ashby:curated", at: "2026-09-23T10:00:00Z" },
    { profileId: "person-one", action: "discovery.ats_learned_board_request",
      subjectId: "ashby:curated", at: "2026-09-22T07:00:00Z" }
  ];
  assert.equal(learnedBoardRequestsInLastDay(audit, "person-one", "ashby:curated", at), 1);
});

test("a learned board makes at most two list requests per day across scans", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "learned-board-budget-"));
  const identity = { actorId: "owner", profileId: "owner" };
  const profiles = await new ProfileStore(path.join(directory, "profiles.json"),
    { allowMissing: true }).init();
  await profiles.patch("owner", { skills: ["TypeScript", "Node.js"],
    preferences: { locations: ["Worldwide"], fullTime: { jobTitles: ["Software Developer Alpha"],
      allowedLocations: ["Worldwide"], remoteOnly: true,
      automatedDiscoverySources: ["ashby"] } } });
  const config = { defaultMode: "full_time", discovery: { broadenedSources: { ashby: true }, sourceOptions: { ashby: {
    boards: [], ownerCuratedBoards: [{ profileId: "owner", company: "Example",
      officialRoleUrl: "https://jobs.ashbyhq.com/curated/11111111-1111-4111-8111-111111111111/application",
      reviewedAt: new Date().toISOString() }] } } },
  modes: { full_time: { minimumScore: 0, sources: ["ashby"],
    autoApplyDiscovered: false, requireConfirmationFor: [] } } };
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  const applicationService = new ApplicationService({ store, config, profiles,
    adapter: { name: "unused", async submit() {} } });
  let requests = 0;
  const discovery = new DiscoveryService({ applicationService, profiles, config,
    officialRequestPaceMs: 0, fetchImpl: async () => {
      requests += 1;
      return new Response(JSON.stringify({ jobs: [{
        id: "22222222-2222-4222-8222-222222222222",
        title: "Software Developer Alpha", isRemote: true, location: "Worldwide",
        descriptionPlain: "TypeScript Node.js", publishedAt: new Date().toISOString(),
        applyUrl: "https://jobs.ashbyhq.com/curated/22222222-2222-4222-8222-222222222222/application",
        jobUrl: "https://jobs.ashbyhq.com/curated/22222222-2222-4222-8222-222222222222"
      }] }), { status: 200 });
    } });
  const first = await discovery.scan({ sources: ["ashby"], prepareApplications: false }, identity);
  assert.deepEqual(first.learnedBoardYield, [{ sourceId: "ashby", board: "curated",
    seedProvenance: "owner_curated_official_role",
    seedVerifiedAt: config.discovery.sourceOptions.ashby.ownerCuratedBoards[0].reviewedAt,
    requestsMade: 1, eligibleUnhandled: 1 }]);
  await discovery.scan({ sources: ["ashby"], prepareApplications: false }, identity);
  assert.equal(requests, 2);
  assert.equal(learnedBoardRequestsInLastDay(store.snapshot().audit, "owner",
    "ashby:curated"), 2);
  const available = await discovery.describeSources(identity, "full_time");
  assert.deepEqual(available.sources[0].configuredBoards, []);
  const third = await discovery.scan({ sources: ["ashby"], prepareApplications: false }, identity);
  assert.equal(requests, 2);
  assert.equal(third.requestsMade, 0);
});
