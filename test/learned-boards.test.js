import assert from "node:assert/strict";
import test from "node:test";
import { sourceConfigWithLearnedBoards } from "../src/discovery/learned-boards.js";

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
