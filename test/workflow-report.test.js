import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkflowReport, recordWorkflowStage } from "../src/workflow-report.js";

const startedAt = "2026-09-23T10:00:00.000Z";
const endedAt = "2026-09-23T10:10:00.000Z";
const campaign = {
  profileId: "person-one", campaignId: "campaign-one", status: "blocked", startedAt, endedAt,
  scan: { sourceYield: [{ sourceId: "ashby", found: 5, qualifying: 3, excluded: 1,
    handledFiltered: 1, destinationPending: 0, selected: 3 }],
  selectedOpportunityIds: ["role-one", "role-two", "role-three"] },
  sourceCoverage: { coveredCount: 1, scans: [] }
};

function state() {
  return { opportunities: ["one", "two", "three"].map((id) => ({ id: `role-${id}`,
    profileId: "person-one", createdAt: "2026-09-23T10:01:00.000Z" })),
  applications: [
    { id: "app-one", profileId: "person-one", campaignId: "campaign-one", status: "submitted",
      receipt: { submittedAt: endedAt, finalUrl: "https://jobs.ashbyhq.com/example/confirmation" } },
    { id: "app-two", profileId: "person-one", campaignId: "campaign-one", status: "submitted",
      receipt: { submittedAt: endedAt, simulated: true } },
    { id: "app-three", profileId: "person-one", campaignId: "campaign-one", status: "waiting_confirmation" },
    { id: "other", profileId: "person-two", campaignId: "campaign-one", status: "submitted",
      receipt: { submittedAt: endedAt, finalUrl: "https://other.example/confirmation" } }
  ],
  attempts: [
    { profileId: "person-one", applicationId: "app-one", workerMetrics: { activeMs: 4000, draftCalls: 1 } },
    { profileId: "person-one", applicationId: "app-two", workerMetrics: { activeMs: 2000 } },
    { profileId: "person-two", applicationId: "other", workerMetrics: { activeMs: 99999 } }
  ],
  confirmations: [{ profileId: "person-one", applicationId: "app-three", status: "pending",
    createdAt: "2026-09-23T10:09:00.000Z" }],
  audit: [] };
}

test("workflow report counts new employer receipts and spent work separately", () => {
  const report = buildWorkflowReport(state(), campaign, endedAt);
  assert.equal(report.elapsedWallMs, 600_000);
  assert.equal(report.counts.newVerified, 1);
  assert.equal(report.counts.simulated, 1);
  assert.equal(report.counts.blocked, 1);
  assert.equal(report.counts.attemptedApplications, 2);
  assert.equal(report.counts.handledFiltered, 1);
  assert.equal(report.activeWorkerMs, 6000);
  assert.equal(report.openOwnerWaitMs, 60_000);
  assert.equal(report.cost.modelCalls, null);
  assert.equal(report.cost.observedModelCalls, 1);
  assert.equal(report.cost.modelInputTokens, null);
  assert.equal(report.cost.toolCalls, null);
  assert.equal(report.cost.browserSteps, null);
  assert.equal(report.wallMsPerNewVerified, 600_000);
  assert.equal(report.endToEndEligible, true);
  assert.equal(report.target100InOneHourProven, false);
});

test("a preloaded candidate disqualifies an end-to-end throughput claim", () => {
  const snapshot = state();
  snapshot.opportunities[0].createdAt = "2026-09-22T10:00:00.000Z";
  snapshot.opportunities[0].source = "ashby";
  snapshot.audit.push({ profileId: "person-one", action: "reserve.source_completed",
    subjectId: "full_time:ashby", at: "2026-09-23T09:45:00.000Z",
    details: { sourceId: "ashby", durationMs: 2200, requestsMade: 3 } });
  const report = buildWorkflowReport(snapshot, campaign, endedAt);
  assert.equal(report.reserve.selectedBeforeCampaign, 1);
  assert.equal(report.reserve.attributableMaintenanceMs, 2200);
  assert.equal(report.reserve.observedMaintenanceRequests, 3);
  assert.equal(report.measurementKind, "preloaded_or_incomplete");
  assert.equal(report.endToEndEligible, false);
});

test("durable workflow stage events exclude applicant content", () => {
  const snapshot = state();
  recordWorkflowStage(snapshot, { actorId: "agent", profileId: "person-one" },
    "campaign-one", "screening", { campaignId: "campaign-one", sourceId: "ashby",
      durationMs: 12.4, found: 5, outcome: "completed",
      answers: "private@example.test", url: "https://private.example", note: "private@example.test" });
  assert.equal(snapshot.audit[0].details.durationMs, 12);
  assert.equal(snapshot.audit[0].details.found, 5);
  assert.equal(JSON.stringify(snapshot.audit).includes("private@example.test"), false);
  const report = buildWorkflowReport(snapshot, campaign, endedAt);
  assert.deepEqual(report.stages.screening, { events: 1, measuredMs: 12 });
});

test("legacy source fields without measurements remain unknown", () => {
  const old = { ...campaign, scan: { handledFiltered: 2, selectedOpportunityIds: [] },
    sourceCoverage: { coveredCount: 1, scans: [{ sourceId: "browser", found: 3,
      qualifying: 1, handledFiltered: 1 }] } };
  const report = buildWorkflowReport(state(), old, endedAt);
  assert.equal(report.counts.handledFiltered, 3);
  assert.equal(report.sourceYield[0].destinationPending, null);
  assert.equal(report.endToEndEligible, true);
});
