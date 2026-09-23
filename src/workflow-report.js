const STAGES = new Set(["discovery", "screening", "destination", "preparation", "owner_hold",
  "worker", "final_decision", "final_action", "receipt", "recovery", "terminal_failure"]);

// Keep stage events deliberately narrower than the general audit log. No
// labels, URLs, answers, excerpts, or employer text enter this trace.
export function recordWorkflowStage(state, identity, subjectId, stage, values = {}) {
  if (!STAGES.has(stage)) throw new Error(`unknown workflow stage: ${stage}`);
  const details = { stage };
  for (const key of ["campaignId", "applicationId", "attemptId", "sourceId"]) {
    if (typeof values[key] === "string" && /^[a-z0-9_-]{1,100}$/i.test(values[key])) details[key] = values[key];
  }
  if (typeof values.outcome === "string" && /^[a-z0-9_]{1,60}$/i.test(values.outcome)) {
    details.outcome = values.outcome;
  }
  for (const key of ["durationMs", "count", "found", "qualifying", "excluded", "handledFiltered",
    "destinationPending", "modelCalls", "browserSteps"]) {
    if (Number.isFinite(values[key]) && values[key] >= 0) details[key] = Math.round(values[key]);
  }
  state.audit.push({ id: randomUUID(), at: new Date().toISOString(),
    actorId: identity.actorId, profileId: identity.profileId,
    action: "workflow.stage", subjectId, details });
}

export function buildWorkflowReport(state, campaign, at = new Date().toISOString()) {
  const { campaignId, startedAt, endedAt, scan, sourceCoverage } = campaign;
  const applications = (state.applications ?? []).filter((item) => item.profileId === campaign.profileId
    && item.campaignId === campaignId);
  const ids = new Set(applications.map((item) => item.id));
  const attempts = (state.attempts ?? []).filter((item) => item.profileId === campaign.profileId
    && ids.has(item.applicationId));
  const confirmations = (state.confirmations ?? []).filter((item) => item.profileId === campaign.profileId
    && ids.has(item.applicationId));
  const events = (state.audit ?? []).filter((item) => item.profileId === campaign.profileId
    && item.action === "workflow.stage" && (item.subjectId === campaignId
      || ids.has(item.subjectId)));
  const wallClockMs = Math.max(0, Date.parse(endedAt ?? at) - Date.parse(startedAt));
  const activeSamples = attempts.map((item) => item.workerMetrics?.activeMs)
    .filter((value) => Number.isFinite(value) && value >= 0);
  const ownerWaitSamples = confirmations.filter((item) => item.resolvedAt)
    .map((item) => Date.parse(item.resolvedAt) - Date.parse(item.createdAt))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const openOwnerWaitMs = confirmations.filter((item) => item.status === "pending")
    .map((item) => Date.parse(at) - Date.parse(item.createdAt))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .reduce((sum, value) => sum + value, 0);
  const verified = applications.filter((item) => item.status === "submitted"
    && item.receipt?.submittedAt && item.receipt?.finalUrl
    && item.receipt.simulated !== true && item.receipt.manuallyVerified !== true);
  const manualReceipts = applications.filter((item) => item.status === "submitted"
    && item.receipt?.manuallyVerified === true).length;
  const simulated = applications.filter((item) => item.status === "submitted"
    && item.receipt?.simulated === true).length;
  const sourceYield = mergeSourceYield(scan?.sourceYield ?? [], sourceCoverage.scans ?? []);
  const handledFiltered = Number(scan?.handledFiltered
    ?? (scan?.sourceYield ?? []).reduce((sum, item) => sum + Number(item.handledFiltered ?? 0), 0))
    + sourceCoverage.scans.reduce((sum, item) => sum + Number(item.handledFiltered ?? 0), 0);
  const selected = new Set([...(scan?.selectedOpportunityIds ?? []),
    ...sourceCoverage.scans.flatMap((item) => item.opportunityIds ?? [])]);
  const opportunities = new Map((state.opportunities ?? []).filter((item) => item.profileId === campaign.profileId)
    .map((item) => [item.id, item]));
  const preloadedCandidates = [...selected].filter((id) => {
    const created = opportunities.get(id)?.createdAt;
    return !created || Date.parse(created) < Date.parse(startedAt);
  }).length;
  const hasAcquisition = Boolean(scan) && sourceCoverage.coveredCount > 0;
  const measurementKind = hasAcquisition && preloadedCandidates === 0
    ? "fresh_campaign" : "preloaded_or_incomplete";
  const stageSummary = Object.fromEntries([...STAGES].map((stage) => {
    const rows = events.filter((event) => event.details?.stage === stage);
    const samples = rows.map((event) => event.details.durationMs)
      .filter((value) => Number.isFinite(value));
    return [stage, { events: rows.length, measuredMs: samples.length
      ? samples.reduce((sum, value) => sum + value, 0) : null }];
  }));
  const draftSamples = attempts.map((item) => item.workerMetrics?.draftCalls)
    .filter((value) => Number.isInteger(value) && value >= 0);
  return {
    schemaVersion: 1, campaignId, status: campaign.status,
    measurementKind, endToEndEligible: measurementKind === "fresh_campaign",
    startedAt, endedAt: endedAt ?? null, elapsedWallMs: wallClockMs,
    activeWorkerMs: attempts.length && activeSamples.length === attempts.length
      ? activeSamples.reduce((sum, value) => sum + value, 0) : null,
    observedActiveWorkerMs: activeSamples.length
      ? activeSamples.reduce((sum, value) => sum + value, 0) : null,
    activeWorkerSamples: activeSamples.length,
    ownerWaitMs: ownerWaitSamples.length ? ownerWaitSamples.reduce((sum, value) => sum + value, 0) : null,
    openOwnerWaitMs,
    reserve: { selectedBeforeCampaign: preloadedCandidates, attributableMaintenanceMs: null },
    counts: { newVerified: verified.length, manualReceipts, simulated,
      attemptedApplications: new Set(attempts.map((item) => item.applicationId)).size,
      attempts: attempts.length, handledFiltered,
      blocked: applications.filter((item) => ["waiting_confirmation", "waiting_research"].includes(item.status)).length,
      skipped: applications.filter((item) => item.status === "skipped").length,
      rejected: applications.filter((item) => item.status === "rejected").length,
      failed: applications.filter((item) => item.status === "failed").length },
    sourceYield, sourceHealth: sourceCoverage.health ?? [], stages: stageSummary,
    cost: { modelCalls: attempts.length && draftSamples.length === attempts.length
      ? draftSamples.reduce((sum, value) => sum + value, 0) : null,
      observedModelCalls: draftSamples.length ? draftSamples.reduce((sum, value) => sum + value, 0) : null,
      modelCallSamples: draftSamples.length,
      modelInputTokens: null, modelOutputTokens: null, coordinatorTokens: null, toolCalls: null },
    verifiedReceiptRatePerHour: verified.length && wallClockMs > 0
      ? verified.length * 3_600_000 / wallClockMs : null,
    wallMsPerNewVerified: verified.length ? wallClockMs / verified.length : null,
    target100InOneHourProven: false
  };
}

function mergeSourceYield(primary, fallbacks) {
  const bySource = new Map();
  for (const row of [...primary, ...fallbacks]) {
    const sourceId = row.sourceId;
    if (typeof sourceId !== "string") continue;
    const current = bySource.get(sourceId) ?? { sourceId, found: null, qualifying: null,
      excluded: null, handledFiltered: null, destinationPending: null, selected: null };
    for (const key of ["found", "qualifying", "excluded", "handledFiltered", "destinationPending", "selected"]) {
      if (Number.isFinite(row[key])) current[key] = (current[key] ?? 0) + row[key];
    }
    bySource.set(sourceId, current);
  }
  return [...bySource.values()].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}
import { randomUUID } from "node:crypto";
