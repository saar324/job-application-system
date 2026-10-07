import { ownerSubmissionSentAt, explicitApplicationReceipt } from '../dashboard/owner-submission.mjs';
import { roleKeys } from './discovery/handled-roles.js';
import { createHash, randomUUID } from "node:crypto";
import { ClientError, manualDailyCaps } from "./service.js";
import { createFieldReview, requiresLegalReview } from "./reviewed-fields.js";
import { receiptDestinationMatches } from '../dashboard/receipt-destination.mjs';
import { verifyEmployerReceiptRedirect } from './receipt-destination.js';

const timestamp = () => new Date().toISOString();
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const terminal = item => ["submitted", "owner_reported_submitted", "skipped", "rejected"].includes(item.status);
const owned = item => item.executionMode === "chrome_session";
const active = item => owned(item) && !terminal(item) && item.status !== "pending";
const secret = /password|passwd|verification.?code|security.?code|one.?time.?code|\botp\b|secret|token|cookie|session.?cookie/i;
const fail = (status, message) => { throw new ClientError(status, message); };

function text(value, name, limit = 1000) {
  if (typeof value !== "string" || !value.trim() || value.length > limit) fail(400, `${name} is required and must be bounded text`);
  return value.trim();
}
function safe(value) {
  if (value === undefined) return undefined;
  if (JSON.stringify(value).length > 100_000) fail(400, "checkpoint or review is too large");
  const inspect = item => {
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      if (secret.test(key) || ["key", "label"].includes(key) && typeof child === "string" && secret.test(child)) {
        fail(400, "credentials and verification codes must not enter durable queue state");
      }
      inspect(child);
    }
  };
  inspect(value);
  return structuredClone(value);
}
function https(raw) {
  let url;
  try { url = new URL(raw); } catch { fail(400, "public HTTPS URL required"); }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname
    || url.hostname === "localhost" || url.hostname.endsWith(".local")
    || url.hostname.includes(":") || /^\d+(?:\.\d+){3}$/.test(url.hostname)) fail(400, "public HTTPS URL required");
  url.hash = "";
  return url.toString();
}
function event(state, identity, action, item, details = {}) {
  state.audit.push({ id: randomUUID(), profileId: identity.profileId, actorId: identity.actorId,
    action: `chrome_queue.${action}`, subjectId: item.id, at: timestamp(), details });
}
function authority(profile) {
  return hash({ contact: profile?.contact, links: profile?.links, documents: profile?.documents,
    applicationAnswers: profile?.applicationAnswers, standingSubmissionPolicy: profile?.standingSubmissionPolicy,
    preferences: profile?.preferences, experience: profile?.experience, workHistory: profile?.workHistory, verifiedExamples: profile?.verifiedExamples });
}

/** Passive durable state. No browser, background runners, or automatic queue advancement. */
export class ChromeQueue {
  constructor(service, { receiptFetchImpl = fetch } = {}) {
    this.service = service; this.store = service.store; this.receiptFetchImpl = receiptFetchImpl;
  }

  list(profileId) {
    const state = this.store.snapshot();
    const jobs = new Map(state.opportunities.filter(item => item.profileId === profileId).map(item => [item.id, item]));
    const items = state.applications.filter(item => item.profileId === profileId && owned(item))
      .sort((a, b) => a.queuePosition - b.queuePosition)
      .map(item => ({ ...item, ...(item.preparation ? { preparation: {
        status: item.preparation.status, revision: item.preparation.revision, createdAt: item.preparation.createdAt,
        writer: item.preparation.writer, reviewedAt: item.preparation.review?.reviewedAt
      } } : {}), opportunity: jobs.get(item.opportunityId) }));
    const current = items.find(active) ?? null;
    return { workflow: "chrome_session", current, waiting: current?.status === "waiting_owner"
      || ["submission_started", "submission_unverified"].includes(current?.status),
    pending: items.filter(item => item.status === "pending").length,
    submitted: items.filter(item => item.status === "submitted" && item.receipt?.simulated !== true || ownerSubmissionSentAt(item)).length, items };
  }

  async add(input, identity, { authorize, prepare } = {}) {
    let opportunity;
    if (input.opportunityId) {
      opportunity = this.store.snapshot().opportunities.find(item => item.id === input.opportunityId && item.profileId === identity.profileId);
      if (!opportunity) fail(404, "opportunity not found");
    } else {
      const url = https(input.url);
      opportunity = await this.service.addOpportunity({ title: input.title ?? "Queued application",
        company: input.company ?? new URL(url).hostname, applyUrl: url, listingUrl: url,
        mode: input.mode ?? this.service.config.defaultMode, source: "direct", direct: true, userRequested: true }, identity);
    }
    const closed = opportunity.userRequested !== true && (
      opportunity.validThrough && Date.parse(opportunity.validThrough) <= Date.now() ? "posting_expired"
        : opportunity.postingStatus && opportunity.postingStatus !== "active" ? "posting_closed" : null);
    if (closed) {
      await this.store.mutate(state => state.audit.push({ id: randomUUID(), at: timestamp(), actorId: identity.actorId,
        profileId: identity.profileId, action: "application.blocked", subjectId: opportunity.id, details: { reason: closed } }));
      throw Object.assign(new ClientError(409, closed), { code: closed });
    }
    return this.store.mutate(state => {
      authorize?.(state);
      const previous = state.applications.find(item => item.profileId === identity.profileId && item.opportunityId === opportunity.id);
      if (previous) {
        if (!owned(previous) && !["submitted", "skipped", "rejected"].includes(previous.status)) {
          const uncertain = previous.pause?.phase === "final_action_started" || previous.finalSubmissionDecision?.status === "consumed"
            || ["claimed", "submitting"].includes(previous.status)
            || state.confirmations.some(c => c.applicationId === previous.id && c.status === "pending"
              && /submission_unverified|submission_recovery|submission_email_verification|submission_blocked/.test(c.kind));
          previous.legacyState = { status: previous.status, pause: previous.pause };
          previous.executionMode = "chrome_session";
          previous.queuePosition = 1 + Math.max(0, ...state.applications.filter(i => i.profileId === identity.profileId).map(i => i.queuePosition ?? 0));
          previous.status = "pending";
          if (uncertain) previous.legacyOutcomeHold = true;
          for (const c of state.confirmations.filter(c => c.applicationId === previous.id && c.status === "pending")) {
            c.status = "superseded"; c.resolvedAt = timestamp(); c.resolvedBy = identity.actorId;
          }
          event(state, identity, "adopted", previous, { uncertain: Boolean(uncertain) });
        }
        prepare?.(state, previous, true);
        return { duplicate: true, application: previous, opportunity };
      }
      const createdAt = timestamp();
      const item = { id: randomUUID(), profileId: identity.profileId, opportunityId: opportunity.id,
        mode: opportunity.mode ?? this.service.config.defaultMode, executionMode: "chrome_session",
        queuePosition: 1 + Math.max(0, ...state.applications.filter(i => i.profileId === identity.profileId).map(i => i.queuePosition ?? 0)),
        status: "pending", answers: {}, requestedBy: identity.actorId, createdAt, updatedAt: createdAt };
      state.applications.push(item);
      prepare?.(state, item, false);
      event(state, identity, "added", item, { queuePosition: item.queuePosition });
      return { duplicate: false, application: item, opportunity };
    });
  }

  async claim(input, identity) {
    const sessionId = text(input.sessionId, "sessionId", 100);
    return this.store.mutate(state => {
      const items = state.applications.filter(item => item.profileId === identity.profileId && owned(item));
      const current = items.find(active);
      if (current) {
        if (current.sessionId !== sessionId || current.sessionActorId !== identity.actorId) fail(409, "another session owns the current application; recover it explicitly");
        return { application: current, waiting: current.status !== "in_progress" };
      }
      // A server worker or unknown legacy final outcome must not run beside Chrome.
      if (state.applications.some(item => item.profileId === identity.profileId && !owned(item)
        && ["queued", "claimed", "submitting"].includes(item.status))) fail(409, "recover existing server execution before starting Chrome");
      const item = items.filter(i => i.status === "pending").sort((a, b) => a.queuePosition - b.queuePosition)[0];
      if (!item) return { application: null, waiting: false };
      Object.assign(item, { status: "in_progress", sessionId, sessionActorId: identity.actorId, updatedAt: timestamp() });
      if (item.legacyOutcomeHold) {
        item.status = "submission_unverified";
        item.blocker = { kind: "outcome_check", message: "Prior submission outcome is unknown. Inspect the original employer evidence; do not Submit again." };
      }
      event(state, identity, "claimed", item);
      return { application: item, waiting: item.status !== "in_progress" };
    });
  }

  #item(state, id, input, identity) {
    const item = state.applications.find(i => i.id === id && i.profileId === identity.profileId && owned(i));
    if (!item) fail(404, "Chrome application not found");
    if (!input.sessionId || item.sessionId !== input.sessionId || item.sessionActorId !== identity.actorId) fail(409, "session does not own this application");
    if (terminal(item)) fail(409, "application is already terminal");
    return item;
  }

  async checkpoint(id, input, identity) {
    const checkpoint = safe(input.checkpoint ?? {});
    const kind = text(input.kind, "blocker kind", 80);
    const message = text(input.message, "blocker message", 3000);
    return this.store.mutate(state => {
      const item = this.#item(state, id, input, identity);
      item.checkpoint = checkpoint;
      item.blocker = { kind, message, recordedAt: timestamp() };
      item.status = item.finalAction || item.legacyOutcomeHold ? "submission_unverified" : "waiting_owner";
      if (!item.finalAction) delete item.review;
      item.updatedAt = timestamp();
      event(state, identity, "waiting", item, { kind, status: item.status });
      return item;
    });
  }

  async resume(id, input, identity) {
    const ownerAnswers = safe(input.ownerAnswers ?? []);
    if (!Array.isArray(ownerAnswers) || ownerAnswers.length > 200 || ownerAnswers.some(field => !field || typeof field !== 'object'
      || !field.key || !field.label || field.value === undefined || typeof field.sourceReference !== 'string' || !field.sourceReference.trim())) fail(400, "exact owner answers and source references required");
    const answerKeys = new Set();
    for (const field of ownerAnswers) {
      text(field.key, "owner answer field key", 300); text(field.label, "owner answer question", 3000);
      text(field.sourceReference, "owner answer source reference", 1000);
      if (!Number.isInteger(field.step ?? 0) || (field.step ?? 0) < 0) fail(400, "owner answer step must be a nonnegative integer");
      const key = `${field.step ?? 0}:${field.key}`;
      if (answerKeys.has(key)) fail(400, "ambiguous duplicate owner answer");
      answerKeys.add(key);
    }
    return this.store.mutate(state => {
      const item = this.#item(state, id, input, identity);
      if (item.finalAction || item.legacyOutcomeHold || ["submission_started", "submission_unverified"].includes(item.status)) fail(409, "check the employer outcome; do not repeat Submit");
      if (item.status !== "waiting_owner") fail(409, "application is not waiting for owner input");
      const resolution = text(input.resolution, "owner resolution", 3000);
      item.resolutions ??= [];
      item.resolutions.push({ kind: item.blocker?.kind, resolution, ownerAnswers, at: timestamp() });
      item.status = "in_progress";
      delete item.blocker;
      delete item.review;
      item.updatedAt = timestamp();
      event(state, identity, "resumed", item);
      return item;
    });
  }

  async review(id, input, identity) {
    const preview = safe(input.preview);
    if (!preview || preview.officialPostingReviewed !== true || preview.resumeUploaded !== true
      || preview.fit?.decision !== "relevant" || !preview.fit.reason
      || !Array.isArray(preview.filled) || !Array.isArray(preview.unfilled)
      || preview.unfilled.some(field => !field || typeof field !== "object" || field.required)
        || preview.filled.some(field => !field || typeof field !== "object" || !field.key || !field.label || !field.source || field.value === undefined
        || field.required && (typeof field.value === "string" && !field.value.trim() || field.value === null || Array.isArray(field.value) && !field.value.length))) fail(400, "complete live review, fit, current CV, and all required fields are required");
    if (preview.filled.length + preview.unfilled.length > 200) fail(400, "too many form fields");
    const keys = new Set();
    for (const field of [...preview.filled, ...preview.unfilled]) {
      if (!field || typeof field !== "object" || Array.isArray(field)) fail(400, "invalid form field");
      text(field.key, "field key", 300); text(field.label, "field label", 3000);
      const key = (field.step ?? 0) + ":" + field.key;
      if (keys.has(key)) fail(400, "ambiguous duplicate form field");
      keys.add(key);
      if (Object.hasOwn(field, "value") && field.value !== null && typeof field.value === "object"
        && (!Array.isArray(field.value) || field.value.some(value => !["string", "boolean", "number"].includes(typeof value)))) fail(400, "form values must be scalar or arrays of scalar values");
    }
    text(preview.fit.reason, "fit reason", 3000);
    preview.destination = https(preview.destination);
    preview.company = text(preview.company, "company", 200);
    preview.title = text(preview.title, "title", 300);
    const authorizationSource = text(input.authorizationSource, "owner submission delegation", 1000);
    const profile = await this.service.profiles?.get(identity.profileId);
    return this.store.mutate(state => {
      const item = this.#item(state, id, input, identity);
      if (item.status !== "in_progress" || item.finalAction) fail(409, "application cannot be reviewed in this state");
      const opportunity = state.opportunities.find(i => i.id === item.opportunityId && i.profileId === identity.profileId);
      const fingerprint = hash(preview);
      const legal = preview.filled.filter(requiresLegalReview);
      if (legal.length) {
        try {
          const verified = createFieldReview({ review: { previewFingerprint: fingerprint, authorizationSource,
            fields: input.fieldEvidence ?? [] }, preview, fingerprint, identity, application: item, profile, opportunity });
          if (legal.some(field => !verified.fields.some(e => e.fieldKey === `${field.step ?? 0}:${field.key}`))) throw new Error("uncovered legal field");
        } catch (error) { fail(409, `legal field needs verified scoped owner evidence: ${error.message}`); }
      }
      item.review = { fingerprint, preview, authorizationSource, reviewerId: identity.actorId,
        profileAuthority: authority(profile), opportunityAuthority: hash(opportunity), fieldEvidence: safe(input.fieldEvidence ?? []), at: timestamp() };
      item.updatedAt = timestamp();
      event(state, identity, "reviewed", item, { fingerprint });
      return { applicationId: item.id, previewFingerprint: fingerprint, reviewerId: identity.actorId };
    });
  }

  async startSubmission(id, input, identity) {
    const profile = await this.service.profiles?.get(identity.profileId);
    return this.store.mutate(state => {
      const item = this.#item(state, id, input, identity);
      if (item.status !== "in_progress" || item.finalAction) fail(409, "final action already started or application is waiting; do not repeat Submit");
      if (!item.review || item.review.fingerprint !== input.previewFingerprint
        || item.review.profileAuthority !== authority(profile)
        || item.review.opportunityAuthority !== hash(state.opportunities.find(o => o.id === item.opportunityId && o.profileId === identity.profileId))
        || Date.now() - Date.parse(item.review.at) > 10 * 60_000) fail(409, "complete current review required; facts or preview changed");
      const today = timestamp().slice(0, 10);
      const counted = state.applications.filter(i => i.profileId === identity.profileId &&
        (i.finalAction?.startedAt?.startsWith(today) || i.finalActions?.some(a => a.startedAt.startsWith(today)) || i.receipt?.submittedAt?.startsWith(today) || ownerSubmissionSentAt(i)?.startsWith(today)
          || i.finalSubmissionDecision?.consumedAt?.startsWith(today)
          || i.finalSubmissionDecision?.status === "reserved" && Date.parse(i.finalSubmissionDecision.expiresAt) > Date.now()
          || i.finalSubmissionApproval?.approvedAt?.startsWith(today) && !["skipped", "rejected"].includes(i.status)) && i.receipt?.simulated !== true);
      const { globalCap, modeCap } = manualDailyCaps(this.service.config, profile, item.mode);
      if (counted.filter(i => i.id !== item.id).length >= globalCap
        || counted.filter(i => i.id !== item.id && i.mode === item.mode).length >= modeCap) fail(409, "daily submission cap reached; wait before Submit");
      const attemptId = randomUUID();
      const startedAt = timestamp();
      item.finalAction = { attemptId, fingerprint: item.review.fingerprint, destination: item.review.preview.destination, startedAt };
      item.status = "submission_started";
      item.updatedAt = startedAt;
      state.attempts.push({ id: attemptId, applicationId: item.id, profileId: item.profileId,
        status: "submitting", claimedAt: startedAt, executionStartedAt: startedAt, executionMode: "chrome_session" });
      event(state, identity, "final_action_started", item, { attemptId, fingerprint: item.review.fingerprint });
      return { applicationId: item.id, attemptId, allowed: true };
    });
  }

  async receipt(id, input, identity) {
    const receipt = safe(input.receipt);
    if (!receipt || receipt.manuallyVerified !== true || receipt.simulated === true
      || typeof receipt.visualReceiptHash !== "string" || !/^[a-f0-9]{64}$/.test(receipt.visualReceiptHash) || !receipt.successText
      || typeof receipt.observedAt !== "string" || !Number.isFinite(Date.parse(receipt.observedAt))) fail(400, "verified employer success text, screenshot hash, and observation time required");
    receipt.successText = text(receipt.successText, "employer success text", 6000);
    receipt.finalUrl = https(receipt.finalUrl);
    // Authenticate and bind the attempt before any network verification. Only
    // the server may produce the trusted destination verification record.
    delete receipt.destinationVerification;
    const snapshot = this.store.snapshot();
    const current = snapshot.applications.find(i => i.id === id && i.profileId === identity.profileId && owned(i));
    if (current?.status === 'submitted') {
      if (current.sessionId !== input.sessionId || current.sessionActorId !== identity.actorId) fail(409, 'session does not own this application');
      if (current.receipt?.attemptId !== input.attemptId || current.receipt.finalUrl !== receipt.finalUrl
        || current.receipt.visualReceiptHash !== receipt.visualReceiptHash || current.receipt.successText !== receipt.successText
        || current.receipt.observedAt !== receipt.observedAt) fail(409, 'receipt already has different evidence');
      return { ...current, duplicate: true };
    }
    const item = this.#item(snapshot, id, input, identity);
    const destination = item.finalAction?.destination ?? item.legacyState?.pause?.origin
      ?? snapshot.opportunities.find(o => o.id === item.opportunityId && o.profileId === identity.profileId)?.applyUrl;
    const attemptId = item.finalAction?.attemptId ?? (item.legacyOutcomeHold ? item.claim?.attemptId ?? item.id : null);
    if (!destination || attemptId !== input.attemptId) fail(409, 'receipt does not match the recorded final attempt');
    try { receipt.destinationVerification = await verifyEmployerReceiptRedirect(destination, receipt.finalUrl, input.redirectEvidence, this.receiptFetchImpl); }
    catch (error) { fail(409, `receipt destination or time does not match this attempt: ${error.message}`); }
    return this.store.mutate(state => {
      const item = this.#item(state, id, input, identity);
      const opportunity = state.opportunities.find(i => i.id === item.opportunityId && i.profileId === identity.profileId);
      const action = item.finalAction ?? (item.legacyOutcomeHold ? { destination: item.legacyState?.pause?.origin ?? opportunity.applyUrl,
        startedAt: item.createdAt, attemptId: item.claim?.attemptId ?? item.id } : null);
      if (!action || action.attemptId !== input.attemptId) fail(409, "receipt does not match the recorded final attempt");
      if (!receiptDestinationMatches(action.destination, receipt.finalUrl, receipt.destinationVerification)
        || Date.parse(receipt.observedAt) < Date.parse(action.startedAt)
        || Date.parse(receipt.observedAt) > Date.now() + 60_000) fail(409, "receipt destination or time does not match this attempt");
      item.receipt = { ...receipt, submittedAt: receipt.observedAt, attemptId: input.attemptId };
      item.status = "submitted";
      if (item.review) item.recordedQuestionAnswers = item.review.preview.filled.map(field => ({ question: field.label, answer: field.value, source: field.source }));
      item.updatedAt = timestamp();
      delete item.blocker;
      const attempt = state.attempts.find(i => i.id === input.attemptId && i.profileId === identity.profileId);
      if (attempt) Object.assign(attempt, { status: "submitted", completedAt: item.updatedAt });
      event(state, identity, "receipt", item, { attemptId: input.attemptId, finalUrl: receipt.finalUrl });
      return item;
    });
  }

  async ownerReceipt(id, input, identity) {
    const proof = safe(input.evidence);
    if (input.ownerSubmitted !== true || !proof || proof.source !== 'owner_provided_employer_confirmation'
      || proof.simulated === true || !explicitApplicationReceipt(proof.successText)
      || !/^[a-f0-9]{64}$/i.test(proof.sha256 ?? '')
      || !Number.isFinite(Date.parse(input.observedAt)) || Date.parse(input.observedAt) > Date.now()) {
      fail(400, 'explicit owner submission, employer confirmation, evidence hash and observation time required');
    }
    const recordKey = text(input.recordKey, 'recordKey', 300);
    const successText = text(proof.successText, 'employer success text', 6000);
    const reference = text(proof.reference, 'owner confirmation reference', 1000);
    const finalUrl = https(input.finalUrl);
    const observedAt = new Date(input.observedAt).toISOString();
    const submissionDate = input.submissionDate;
    const record = { version: 1, channel: 'browser', submissionActor: 'owner_browser', identityMatchPending: false,
      recordKey, submissionDate, observedAt, finalUrl,
      evidence: { source: proof.source, successText, reference, sha256: proof.sha256.toLowerCase() } };
    const snapshot = this.store.snapshot();
    const current = snapshot.applications.find(i => i.id === id && i.profileId === identity.profileId && owned(i));
    if (!current) fail(404, 'Chrome application not found');
    if (current.sessionId !== input.sessionId || current.sessionActorId !== identity.actorId) fail(409, 'session does not own this application');
    const currentOpportunity = snapshot.opportunities.find(o => o.id === current.opportunityId && o.profileId === identity.profileId);
    record.jobUrl = https(currentOpportunity?.applyUrl ?? currentOpportunity?.listingUrl);
    // Existing exact evidence imports reuse their server-verified destination,
    // keeping retries idempotent even if the posting later closes.
    if (current.ownerSubmission?.channel === 'browser') record.destinationVerification = current.ownerSubmission.destinationVerification;
    else {
      if (current.finalAction || current.legacyOutcomeHold) fail(409, 'record the existing final attempt receipt; owner import cannot replace an uncertain agent action');
      try { record.destinationVerification = await verifyEmployerReceiptRedirect(record.jobUrl, finalUrl, input.redirectEvidence, this.receiptFetchImpl); }
      catch (error) { fail(409, `owner receipt must identify the exact official role: ${error.message}`); }
    }
    return this.store.mutate(state => {
      // Idempotent evidence import is separate from the agent final-action path.
      const existing = state.applications.find(i => i.id === id && i.profileId === identity.profileId && owned(i));
      if (!existing) fail(404, 'Chrome application not found');
      if (!input.sessionId || existing.sessionId !== input.sessionId || existing.sessionActorId !== identity.actorId) fail(409, 'session does not own this application');
      const opportunity = state.opportunities.find(o => o.id === existing.opportunityId && o.profileId === identity.profileId);
      record.jobUrl = https(opportunity?.applyUrl ?? opportunity?.listingUrl);
      const expectedKeys = roleKeys(opportunity);
      if (!receiptDestinationMatches(record.jobUrl, finalUrl, record.destinationVerification)
        || !record.destinationVerification && ![...roleKeys({ applyUrl: finalUrl })].some(k => expectedKeys.has(k))) fail(409, 'owner receipt must identify the exact official role');
      if (!ownerSubmissionSentAt({ ownerSubmission: record })) fail(400, 'valid owner receipt submission date and evidence required');
      if (Date.parse(observedAt) < Date.parse(existing.createdAt)) fail(409, 'owner receipt predates this application');
      const fingerprint = hash({ ...record, observedAt: undefined });
      if (existing.ownerSubmission?.channel === 'browser') {
        if (existing.ownerSubmission.fingerprint !== fingerprint) fail(409, 'owner receipt already has different evidence');
        return { applicationId: id, status: existing.status, duplicate: true, submissionDate: existing.ownerSubmission.submissionDate };
      }
      const item = this.#item(state, id, input, identity);
      if (item.finalAction || item.legacyOutcomeHold || !['in_progress', 'waiting_owner'].includes(item.status)) {
        fail(409, 'record the existing final attempt receipt; owner import cannot replace an uncertain agent action');
      }
      item.ownerSubmission = { ...record, fingerprint };
      item.status = 'owner_reported_submitted';
      item.updatedAt = timestamp();
      delete item.blocker;
      event(state, identity, 'owner_receipt', item, { recordKey, finalUrl, submissionDate });
      return { applicationId: id, status: item.status, duplicate: false, submissionDate };
    });
  }

  async validationError(id, input, identity) {
    const errors = safe(input.errors);
    if (!Array.isArray(errors) || !errors.length || errors.some(e => typeof e !== "string" || !e.trim() || e.length > 1000)) fail(400, "exact employer validation errors required");
    return this.store.mutate(state => {
      const item = this.#item(state, id, input, identity);
      if (item.status !== "submission_started" || item.finalAction?.attemptId !== input.attemptId
        || input.employerExplicitlyRejected !== true) fail(409, "only an explicit live employer validation rejection can authorize correction");
      if ((item.finalActions?.length ?? 0) >= 2) fail(409, "validation retry limit reached; ask the owner");
      item.finalActions ??= [];
      item.finalActions.push({ ...item.finalAction, rejectedAt: timestamp(), errors });
      const attempt = state.attempts.find(a => a.id === input.attemptId && a.profileId === identity.profileId);
      if (attempt) Object.assign(attempt, { status: "validation_rejected", completedAt: timestamp() });
      delete item.finalAction;
      delete item.review;
      item.status = "in_progress";
      item.updatedAt = timestamp();
      event(state, identity, "validation_rejected", item, { attemptId: input.attemptId, errors });
      return item;
    });
  }

  async takeover(id, input, identity) {
    const sessionId = text(input.sessionId, "sessionId", 100);
    const authorization = text(input.ownerRecoveryReference, "explicit owner session recovery request", 1000);
    return this.store.mutate(state => {
      const item = state.applications.find(i => i.id === id && i.profileId === identity.profileId && active(i));
      if (!item) fail(404, "active Chrome application not found");
      const priorSession = item.sessionId;
      item.sessionId = sessionId;
      item.sessionActorId = identity.actorId;
      if (item.status === "submission_started") item.status = "submission_unverified";
      if (!item.finalAction) delete item.review;
      item.updatedAt = timestamp();
      event(state, identity, "session_recovered", item, { priorSession, authorization });
      return item;
    });
  }

  async skip(id, input, identity) {
    const reason = text(input.reason, "skip reason", 3000);
    return this.store.mutate(state => {
      const item = this.#item(state, id, input, identity);
      if ((item.finalAction || item.legacyOutcomeHold) && input.ownerStoppedPursuit !== true) fail(409, "unknown outcome requires an explicit owner decision; do not imply no submission");
      if (item.finalAction || item.legacyOutcomeHold) item.submissionOutcome = "unverified";
      item.status = "skipped";
      item.skipReason = reason;
      item.updatedAt = timestamp();
      event(state, identity, "skipped", item, { reason, submissionOutcome: item.submissionOutcome });
      return item;
    });
  }

  async recover() {
    return this.store.mutate(state => {
      for (const item of state.applications.filter(i => !owned(i) && ["queued", "claimed", "submitting"].includes(i.status))) {
        const started = item.status === "submitting" || item.claim?.executionStartedAt;
        item.status = "waiting_confirmation";
        item.pause = { ...item.pause, phase: started ? "final_action_started" : "before_final_action",
          message: "Automatic server execution retired. Resume explicitly in the Chrome queue." };
        event(state, { profileId: item.profileId, actorId: "system-recovery" }, "legacy_held", item, { phase: item.pause.phase });
      }
      for (const item of state.applications.filter(owned)) {
        if (item.status === "submission_started") {
          item.status = "submission_unverified";
          item.blocker = { kind: "outcome_check", message: "Server restarted after final action began. Verify the employer outcome before continuing.", recordedAt: timestamp() };
          event(state, { profileId: item.profileId, actorId: "system-recovery" }, "outcome_hold", item);
        }
      }
    });
  }
}
