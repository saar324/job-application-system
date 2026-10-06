import { ChromeQueue } from "./chrome-queue.js";
import { AccountAccess } from './account-access.js';
import { normalizeRecruiterOutreach } from "./recruiter-outreach.js";
import { randomUUID } from "node:crypto";
import { roleKeys } from "./discovery/handled-roles.js";
import { CLOSED_RETRY_MS, PENDING_RETRY_MS, PENDING_TTL_MS, retryDelay } from "./discovery/candidate-state.js";
const now = () => new Date().toISOString();
const inactive = item => ["skipped", "rejected", "failed"].includes(item.status);

export class ApplicationService {
  constructor({ store, config, profiles, credentialVault }) {
    this.store = store; this.config = config; this.profiles = profiles;
    this.adapter = { name: "chrome_session" };
    this.sessionControlled = true;
    this.chromeQueue = new ChromeQueue(this);
    this.accountAccess = new AccountAccess(this, credentialVault);
  }
  executionHealth() { return { active: 0, waitingForCapacity: 0, queued: 0 }; }
  list(collection, profileId) {
    return this.store.snapshot()[collection].filter((item) => item.profileId === profileId);
  }

  applicationLog(profileId) {
    const state = this.store.snapshot();
    const opportunities = new Map(
      state.opportunities
        .filter((item) => item.profileId === profileId)
        .map((item) => [item.id, item])
    );
    const confirmations = new Map();
    for (const item of state.confirmations.filter((entry) => entry.profileId === profileId)) {
      const related = confirmations.get(item.applicationId) ?? [];
      related.push(item);
      confirmations.set(item.applicationId, related);
    }
    return state.applications
      .filter((item) => item.profileId === profileId)
      .map((application) => buildApplicationLogEntry(
        application,
        opportunities.get(application.opportunityId),
        confirmations.get(application.id) ?? []
      ))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  applicationMetrics(profileId) {
    const state = this.store.snapshot();
    const attempts = (state.attempts ?? []).filter((item) => item.profileId === profileId);
    const confirmations = state.confirmations.filter((item) => item.profileId === profileId);
    const durations = (values) => {
      const sorted = values.filter((value) => Number.isFinite(value) && value >= 0)
        .sort((left, right) => left - right);
      return { samples: sorted.length,
        medianMs: sorted.length ? sorted[Math.ceil(sorted.length * 0.5) - 1] : null,
        p95Ms: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null };
    };
    const elapsed = (start, end) => start && end
      ? Date.parse(end) - Date.parse(start) : null;
    const workerKeys = ["loadMs", "planFillMs", "draftMs", "transitionMs", "receiptMs", "activeMs"];
    return {
      schemaVersion: 1,
      attempts: attempts.length,
      outcomes: Object.fromEntries([...new Set(attempts.map((item) => item.status))]
        .map((status) => [status, attempts.filter((item) => item.status === status).length])),
      queue: durations(attempts.map((item) => item.queueMs)),
      execution: durations(attempts.map((item) => elapsed(item.executionStartedAt, item.completedAt))),
      ownerWait: durations(confirmations.map((item) => elapsed(item.createdAt, item.resolvedAt))),
      worker: Object.fromEntries(workerKeys.map((key) => [key,
        durations(attempts.map((item) => item.workerMetrics?.[key]))])),
      draftCalls: {
        samples: attempts.filter((item) => Number.isInteger(item.workerMetrics?.draftCalls)).length,
        total: attempts.some((item) => Number.isInteger(item.workerMetrics?.draftCalls))
          ? attempts.reduce((sum, item) => sum + (item.workerMetrics?.draftCalls ?? 0), 0) : null
      },
      modelInputTokens: null,
      modelOutputTokens: null,
      coordinatorTokens: null
    };
  }

  async addOpportunity(input, identity, { serverVerifiedDiscovery = false,
    reviewedDiscovery = false, advisoryDiscovery = null } = {}) {
    if (!input.title || !input.company || !input.applyUrl) {
      throw new ClientError(400, "title, company, and applyUrl are required");
    }
    // Client-supplied score/source/provenance is useful for review but cannot
    // establish authorization for an automatic final action.
    const candidate = { ...input };
    if (!reviewedDiscovery) delete candidate.fitAssessment;
    for (const field of ["discoveryVerification", "discoveryState", "destinationFirstObservedAt",
      "discoveryRelease",
      "destinationRetryAfter", "destinationExpiresAt", "destinationRetryCount",
      "closedObservedAt", "closedRetryAfter", "closedRetryCount", "closedOrigin"]) {
      delete candidate[field];
    }
    const dedupKey = candidate.dedupKey ?? buildDedupKey(candidate);
    const applicationUrl = normalizedApplicationUrl(input.applyUrl);
    return this.store.mutate(async (state) => {
      const incomingKeys = roleKeys(candidate);
      const sameRole = (entry) => {
        if ([...roleKeys(entry)].some((key) => !key.startsWith("role:") && incomingKeys.has(key))) return true;
        return state.applications.some((application) => application.profileId === identity.profileId
          && application.opportunityId === entry.id && application.receipt?.finalUrl
          && [...roleKeys({ applyUrl: application.receipt.finalUrl })]
            .some((key) => !key.startsWith("role:") && incomingKeys.has(key)));
      };
      const existing = state.opportunities.find(
        (entry) => entry.profileId === identity.profileId
          && (entry.dedupKey === dedupKey || normalizedApplicationUrl(entry.applyUrl) === applicationUrl
            || sameRole(entry))
      );
      if (existing) {
        const sameOfficialRole = [...roleKeys(existing)].some((key) =>
          /^(?:ashby|greenhouse|lever):/.test(key) && incomingKeys.has(key));
        const priorApplications = state.applications.filter((application) =>
          application.profileId === identity.profileId && application.opportunityId === existing.id);
        const safeClosedRetry = existing.discoveryState === "closed"
          && ["posting_unavailable", "reviewed_skip"].includes(existing.closedOrigin)
          && priorApplications.every((application) => application.status === "skipped"
            && !application.receipt?.submittedAt
            && application.skip?.submissionOutcome !== "unverified"
            && application.finalSubmissionDecision?.status !== "consumed");
        const safeExpiredRetry = existing.discoveryState === "expired"
          && priorApplications.every((application) => application.status === "skipped"
            && !application.receipt?.submittedAt
            && application.skip?.submissionOutcome !== "unverified"
            && application.finalSubmissionDecision?.status !== "consumed");
        const canPromote = (existing.applicationDestinationPending === true
          && priorApplications.length === 0)
          || ((safeClosedRetry || safeExpiredRetry) && sameOfficialRole);
        if (serverVerifiedDiscovery && canPromote
          && candidate.applicationDestinationPending !== true
          && candidate.applicationDestinationVerified === true
          && (sameOfficialRole || (candidate.source === existing.source
            && candidate.externalId === existing.externalId))
          && /^https:\/\//i.test(candidate.applyUrl)) {
          Object.assign(existing, candidate, {
            discoveryState: "ready", applicationDestinationPending: false,
            destinationFirstObservedAt: undefined, destinationRetryAfter: undefined,
            destinationExpiresAt: undefined, destinationRetryCount: undefined,
            closedObservedAt: undefined, closedRetryAfter: undefined,
            closedRetryCount: undefined, closedOrigin: undefined,
            updatedAt: now(), discoveryVerification: candidate.applicationDestinationVerified === true
              ? { sourceId: candidate.source ?? "agent", verifiedAt: now(),
                score: Number(candidate.score ?? 0) } : undefined
          });
          if (advisoryDiscovery?.stage === "advisory") {
            existing.discoveryRelease = { stage: "advisory", sourceId: advisoryDiscovery.sourceId,
              reason: advisoryDiscovery.reason };
          }
          audit(state, identity, "opportunity.destination_resolved", existing.id, {
            source: candidate.source ?? "agent"
          });
        } else if (candidate.applicationDestinationPending === true
          && existing.applicationDestinationPending === true
          && !priorApplications.length && existing.discoveryState !== "expired") {
          const at = Date.now();
          const first = Date.parse(existing.destinationFirstObservedAt ?? existing.createdAt ?? "");
          existing.destinationFirstObservedAt = new Date(Number.isFinite(first) ? first : at).toISOString();
          existing.destinationExpiresAt = new Date(Date.parse(existing.destinationFirstObservedAt)
            + PENDING_TTL_MS).toISOString();
          existing.destinationRetryCount = Number(existing.destinationRetryCount ?? 1) + 1;
          existing.destinationRetryAfter = new Date(at + retryDelay(PENDING_RETRY_MS,
            existing.destinationRetryCount, CLOSED_RETRY_MS)).toISOString();
          existing.discoveryState = "pending_destination";
          existing.updatedAt = new Date(at).toISOString();
        } else if (candidate.applicationDestinationPending === true && safeClosedRetry) {
          const attempt = Number(existing.closedRetryCount ?? 1) + 1;
          existing.closedRetryCount = attempt;
          existing.closedRetryAfter = new Date(Date.now()
            + retryDelay(CLOSED_RETRY_MS, attempt, 7 * CLOSED_RETRY_MS)).toISOString();
          existing.updatedAt = now();
        }
        if (input.userRequested === true) {
          existing.userRequested = true;
          existing.direct = true;
          existing.score = Math.max(100, Number(existing.score ?? 0));
          existing.sourceHistory = [...new Set([...(existing.sourceHistory ?? []), existing.source, input.source]
            .filter(Boolean))];
          existing.directRequestedAt = now();
          existing.updatedAt = now();
          audit(state, identity, "opportunity.direct_intent_recorded", existing.id, {
            priorSource: existing.source, normalizedUrl: applicationUrl
          });
        }
        if (reviewedDiscovery && candidate.fitAssessment && !priorApplications.length) {
          if (serverVerifiedDiscovery && sameOfficialRole
            && candidate.applicationDestinationVerified === true
            && candidate.applicationDestinationPending !== true) {
            Object.assign(existing, candidate, { discoveryState: "ready",
              discoveryVerification: { sourceId: candidate.source ?? "agent",
                verifiedAt: now(), score: Number(candidate.score ?? 0) } });
          }
          existing.fitAssessment = candidate.fitAssessment;
          existing.updatedAt = now();
        }
        return existing;
      }
      const item = {
        ...candidate, id: randomUUID(), profileId: identity.profileId, dedupKey,
        ...(serverVerifiedDiscovery && advisoryDiscovery?.stage === "advisory"
          ? { discoveryRelease: { stage: "advisory", sourceId: advisoryDiscovery.sourceId,
            reason: advisoryDiscovery.reason } } : {}),
        mode: candidate.mode ?? this.config.defaultMode, source: candidate.source ?? "agent",
        score: Number(candidate.score ?? 0), status: "discovered", createdAt: now(),
        ...(candidate.applicationDestinationPending === true ? {
          discoveryState: "pending_destination", destinationFirstObservedAt: now(),
          destinationRetryAfter: new Date(Date.now() + PENDING_RETRY_MS).toISOString(),
          destinationExpiresAt: new Date(Date.now() + PENDING_TTL_MS).toISOString(),
          destinationRetryCount: 1 } : serverVerifiedDiscovery
          && candidate.applicationDestinationVerified === true ? { discoveryState: "ready" } : {}),
        ...(serverVerifiedDiscovery && candidate.applicationDestinationVerified === true
          && candidate.applicationDestinationPending !== true && candidate.userRequested !== true
          ? { discoveryVerification: { sourceId: candidate.source ?? "agent", verifiedAt: now(),
            score: Number(candidate.score ?? 0) } } : {})
      };
      if (!this.config.modes[item.mode]) throw new ClientError(400, `unknown mode: ${item.mode}`);
      state.opportunities.push(item);
      audit(state, identity, "opportunity.created", item.id, { mode: item.mode });
      return item;
    });
  }

  async markDiscoveryLeadExpired(opportunityId, identity) {
    return this.store.mutate((state) => {
      const item = state.opportunities.find((entry) => entry.id === opportunityId
        && entry.profileId === identity.profileId);
      if (!item || item.discoveryState !== "pending_destination") return item ?? null;
      if (state.applications.some((application) => application.profileId === identity.profileId
        && application.opportunityId === item.id)) return item;
      item.discoveryState = "expired";
      item.updatedAt = now();
      audit(state, identity, "opportunity.pending_expired", item.id, {});
      return item;
    });
  }

  async directApplication(input, identity) {
    const url = validateDirectUrl(input.url ?? input.applyUrl);
    const parsed = new URL(url);
    const opportunity = await this.addOpportunity({
      title: input.title ?? "Direct application",
      company: input.company ?? parsed.hostname,
      applyUrl: url,
      listingUrl: url,
      mode: input.mode ?? this.config.defaultMode,
      source: "direct",
      score: 100,
      direct: true,
      userRequested: true
    }, identity);
    try {
      return { opportunity, application: await this.requestApplication(opportunity.id, input, identity) };
    } catch (error) {
      if (error.status !== 409) throw error;
      const application = this.list("applications", identity.profileId)
        .find((item) => item.opportunityId === opportunity.id && !inactive(item));
      return { opportunity, application, duplicate: true };
    }
  }

  async requestApplication(opportunityId, input, identity) {
    return (await this.chromeQueue.add({ opportunityId }, identity)).application;
  }
  async recordRecruiterOutreach(applicationId, input, identity) {
    let update;
    try { update = normalizeRecruiterOutreach(input); }
    catch (error) { throw new ClientError(400, error.message); }
    return this.store.mutate(async (state) => {
      const application = state.applications.find(item => item.id === applicationId && item.profileId === identity.profileId);
      if (!application) throw new ClientError(404, "application not found");
      const opportunity = state.opportunities.find(item => item.id === application.opportunityId && item.profileId === identity.profileId);
      if (!opportunity) throw new ClientError(404, "opportunity not found");
      application.recruiter = update.recruiter;
      if (update.outreach) application.outreach = { ...update.outreach, updatedAt: now() };
      application.updatedAt = now();
      audit(state, identity, "application.recruiter_outreach_recorded", application.id, { hasDraft: !!update.outreach });
      return buildApplicationLogEntry(application, opportunity, state.confirmations.filter(item => item.applicationId === application.id));
    });
  }

  async recordEmployerStatus(applicationId, input, identity) {
    const state = requiredEmployerStatus(input.status);
    const observedAt = requiredTimestamp(input.observedAt, "observedAt");
    const source = optionalLogText(input.source ?? "email", "source", 80);
    const sourceId = optionalLogText(input.sourceId, "sourceId", 300);
    const subject = optionalLogText(input.subject, "subject", 500);
    const sender = optionalLogText(input.sender, "sender", 500);
    const note = optionalLogText(input.note, "note", 1000);
    return this.store.mutate(async (storeState) => {
      const application = storeState.applications.find(
        (item) => item.id === applicationId && item.profileId === identity.profileId
      );
      if (!application) throw new ClientError(404, "application not found");
      const opportunity = storeState.opportunities.find(
        (item) => item.id === application.opportunityId && item.profileId === identity.profileId
      );
      if (!opportunity) throw new ClientError(404, "opportunity not found");

      const current = application.employerStatus;
      if (current?.sourceId && sourceId && current.sourceId === sourceId) {
        return buildApplicationLogEntry(
          application,
          opportunity,
          storeState.confirmations.filter((item) => item.applicationId === application.id)
        );
      }
      if (current?.observedAt && observedAt < current.observedAt) {
        throw new ClientError(409, "employer status evidence is older than the current status");
      }

      application.employerStatus = {
        status: state,
        observedAt,
        recordedAt: now(),
        source,
        ...(sourceId ? { sourceId } : {}),
        ...(subject ? { subject } : {}),
        ...(sender ? { sender } : {}),
        ...(note ? { note } : {})
      };
      application.updatedAt = now();
      audit(storeState, identity, "application.employer_status_recorded", application.id, {
        status: state, observedAt, source, sourceId
      });
      return buildApplicationLogEntry(
        application,
        opportunity,
        storeState.confirmations.filter((item) => item.applicationId === application.id)
      );
    });
  }

  async recover() { return this.chromeQueue.recover(); }
}

function audit(state, identity, action, subjectId, details) {
  state.audit.push({
    id: randomUUID(), at: now(), actorId: identity.actorId, profileId: identity.profileId,
    action, subjectId, details
  });
}

const CONTROL_ANSWER_KEYS = new Set(["retry", "submitted", "finalUrl", "externalId"]);
const SENSITIVE_KEY = /(?:^|[_-])(?:password|passwd|passcode|secret|token|api[_-]?key|otp|cookie|session)(?:$|[_-])/i;
const CREDENTIAL_INPUT_KEY = /(?:^|[_-])(?:password|passwd|passcode|secret|token|api[_-]?key|otp|cookie)(?:$|[_-])/i;
function sensitiveFormField(key, label) {
  return /password|passwd|passcode|one.?time|otp|verification code|security code|secret|token|api.?key|access.?key|session|cookie/i
    .test(`${key} ${label}`);
}

function buildApplicationLogEntry(application, opportunity = {}, confirmations = []) {
  const answered = new Map();
  for (const confirmation of confirmations) {
    const response = confirmation.response ?? {};
    for (const field of confirmation.fields ?? []) {
      if (!Object.hasOwn(response, field)) continue;
      answered.set(field, {
        field,
        question: confirmation.message ?? field,
        answer: sanitizeLoggedValue(field, response[field]),
        answeredAt: confirmation.resolvedAt
      });
    }
  }
  for (const [field, value] of Object.entries(application.answers ?? {})) {
    if (CONTROL_ANSWER_KEYS.has(field) || answered.has(field)) continue;
    answered.set(field, {
      field,
      question: field,
      answer: sanitizeLoggedValue(field, value)
    });
  }
  for (const item of application.recordedQuestionAnswers ?? []) {
    answered.set(item.field ?? item.question, {
      field: item.field,
      question: item.question,
      answer: sanitizeLoggedValue(item.field ?? item.question, item.answer),
      answeredAt: item.answeredAt
    });
  }
  const finalPreview = application.review?.preview ?? confirmations
    .filter((item) => item.kind === "final_submission_approval" && item.preview)
    .at(-1)?.preview;
  const paused = ["waiting_owner", "submission_started", "submission_unverified", "waiting_confirmation", "waiting_research"].includes(application.status);
  const checkpoint = paused ? application.checkpoint : undefined;
  return {
    applicationId: application.id,
    opportunityId: application.opportunityId,
    company: opportunity.company,
    title: opportunity.title,
    url: opportunity.applyUrl ?? opportunity.listingUrl ?? application.receipt?.finalUrl,
    applyUrl: opportunity.applyUrl,
    listingUrl: opportunity.listingUrl,
    source: opportunity.source,
    mode: application.mode,
    campaignId: application.campaignId,
    status: application.status,
    queuePosition: application.queuePosition,
    blocker: application.blocker,
    resolutions: application.resolutions,
    createdAt: application.createdAt,
    updatedAt: application.updatedAt,
    submittedAt: application.receipt?.submittedAt,
    questionsAndAnswers: [...answered.values()],
    ...(paused ? {
      pause: checkpoint ? { step: checkpoint.step, origin: checkpoint.origin,
        phase: checkpoint.phase ?? "before_final_action", truncated: checkpoint.truncated === true } : null,
      ...(application.status === "waiting_research" ? {
        researchQuestions: application.researchQuestions ?? [] } : {}),
      pausedFields: (checkpoint?.fields ?? []).map((field) => ({
        step: field.step, key: field.key, label: field.label,
        type: field.type, required: field.required, status: field.status,
        source: field.source,
        ...(Object.hasOwn(field, "value") ? { value: (sensitiveFormField(field.key, field.label)
          || field.type === "password") ? "[redacted]" : sanitizeLoggedValue(field.key, field.value) } : {}),
        ...(field.truncated === true ? { truncated: true } : {})
      })),
      pendingReview: confirmations.filter((item) => item.status === "pending")
        .map((item) => ({ id: item.id, kind: item.kind, message: item.message,
          fields: item.fields ?? [] }))
    } : {}),
    submittedFields: (finalPreview?.filled ?? []).map((field) => ({
      label: field.label,
      value: sanitizeLoggedValue(field.label, field.value),
      source: field.source
    })),
    decision: application.decision,
    error: application.error,
    employerStatus: application.employerStatus,
    recruiter: application.recruiter,
    outreach: application.outreach,
    skip: application.skip,
    receipt: application.receipt
  };
}

const EMPLOYER_STATUSES = new Set([
  "application_received", "under_review", "action_required", "awaiting_response", "assessment",
  "interview", "rejected", "withdrawn", "offer", "hired", "closed"
]);

function requiredEmployerStatus(value) {
  if (typeof value !== "string" || !EMPLOYER_STATUSES.has(value)) {
    throw new ClientError(400, `status must be one of: ${[...EMPLOYER_STATUSES].join(", ")}`);
  }
  return value;
}

function requiredTimestamp(value, field) {
  if (typeof value !== "string" || !value.trim() || Number.isNaN(Date.parse(value))) {
    throw new ClientError(400, `${field} must be a valid timestamp`);
  }
  return new Date(value).toISOString();
}

function optionalLogText(value, field, maximum) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > maximum) {
    throw new ClientError(400, `${field} must be a string with at most ${maximum} characters`);
  }
  return value.trim() || undefined;
}

function sanitizeLoggedValue(key, value) {
  if (SENSITIVE_KEY.test(key)) return "[redacted]";
  if (Array.isArray(value)) return value.map((item) => sanitizeLoggedValue(key, item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([nestedKey, nestedValue]) => [nestedKey, sanitizeLoggedValue(nestedKey, nestedValue)])
  );
}

function buildDedupKey(input) {
  if (input.externalId) return `${input.source ?? "unknown"}:${input.externalId}`;
  try {
    const url = new URL(input.applyUrl);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith("utm_") || ["ref", "refId", "trackingId"].includes(key)) url.searchParams.delete(key);
    }
    url.pathname = url.pathname.replace(/\/$/, "");
    return `url:${url.toString()}`;
  } catch { return `url:${input.applyUrl}`; }
}

function normalizedApplicationUrl(raw) {
  try {
    const url = new URL(raw);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith("utm_") || ["ref", "refId", "trackingId", "source"].includes(key)) url.searchParams.delete(key);
    }
    url.pathname = url.pathname.replace(/\/$/, "");
    return url.toString();
  } catch { return String(raw ?? "").replace(/\/$/, ""); }
}

export function manualDailyCaps(config, profile, mode) {
  const preferences = mode === "freelance" ? profile?.preferences?.freelance : profile?.preferences?.fullTime;
  const bounded = (configured, preferred) => {
    const ceiling = Number.isInteger(configured) && configured > 0 ? configured : Infinity;
    return Number.isInteger(preferred) && preferred > 0 ? Math.min(ceiling, preferred) : ceiling;
  };
  const profileCap = bounded(profile?.preferences?.maxApplicationsPerDay, profile?.standingSubmissionPolicy?.dailyCap);
  return { globalCap: Math.min(bounded(config.execution?.maxApplicationsPerDay, undefined), profileCap),
  modeCap: bounded(config.modes[mode]?.dailyApplicationCap, preferences?.dailyApplicationCap) };
}

function validateDirectUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new ClientError(400, "a valid application URL is required"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
    throw new ClientError(400, "direct application URLs must use public HTTPS without embedded credentials");
  }
  if (url.hostname === "localhost" || url.hostname.endsWith(".local") || /^\d+(?:\.\d+){3}$/.test(url.hostname)) {
    throw new ClientError(400, "local and IP-address application URLs are not allowed");
  }
  url.hash = "";
  return url.toString();
}

export class ClientError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
