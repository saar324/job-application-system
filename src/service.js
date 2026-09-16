import { randomUUID } from "node:crypto";
import { evaluatePolicy } from "./policy.js";
import { NeedsInputError, NeedsReviewError } from "./adapters/errors.js";

function now() { return new Date().toISOString(); }
const inactive = (item) => ["skipped", "rejected", "failed"].includes(item.status);

export class ApplicationService {
  #runner = Promise.resolve();

  constructor({ store, config, adapter, profiles, documentStager, credentialVault }) {
    this.store = store;
    this.config = config;
    this.adapter = adapter;
    this.profiles = profiles;
    this.documentStager = documentStager;
    this.credentialVault = credentialVault;
  }

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

  async addOpportunity(input, identity) {
    if (!input.title || !input.company || !input.applyUrl) {
      throw new ClientError(400, "title, company, and applyUrl are required");
    }
    const dedupKey = input.dedupKey ?? buildDedupKey(input);
    const applicationUrl = normalizedApplicationUrl(input.applyUrl);
    return this.store.mutate(async (state) => {
      const existing = state.opportunities.find(
        (entry) => entry.profileId === identity.profileId
          && (entry.dedupKey === dedupKey || normalizedApplicationUrl(entry.applyUrl) === applicationUrl)
      );
      if (existing) return existing;
      const item = {
        ...input, id: randomUUID(), profileId: identity.profileId, dedupKey,
        mode: input.mode ?? this.config.defaultMode, source: input.source ?? "agent",
        score: Number(input.score ?? 0), status: "discovered", createdAt: now()
      };
      if (!this.config.modes[item.mode]) throw new ClientError(400, `unknown mode: ${item.mode}`);
      state.opportunities.push(item);
      audit(state, identity, "opportunity.created", item.id, { mode: item.mode });
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
    assertNoSensitiveAnswerFields(input.answers, "application answers");
    const initialOpportunity = this.store.snapshot().opportunities.find(
      (item) => item.id === opportunityId && item.profileId === identity.profileId
    );
    if (!initialOpportunity) throw new ClientError(404, "opportunity not found");
    const mode = input.mode ?? initialOpportunity.mode ?? this.config.defaultMode;
    const modeConfig = this.config.modes[mode];
    if (!modeConfig) throw new ClientError(400, `unknown mode: ${mode}`);
    const profile = this.profiles ? await this.profiles.get(identity.profileId) : null;
    const profileStatus = this.profiles
      ? await this.profiles.status(identity.profileId, mode, this.config.defaultMode) : null;
    const modePreferences = mode === "freelance"
      ? profile?.preferences?.freelance : profile?.preferences?.fullTime;
    const submissionApproval = modePreferences?.submissionApproval ?? modeConfig.submissionApproval ?? "automatic";
    if (!["automatic", "always"].includes(submissionApproval)) {
      throw new ClientError(400, `invalid submissionApproval for ${mode}`);
    }

    const saved = await this.store.mutate(async (state) => {
      const opportunity = state.opportunities.find(
        (item) => item.id === opportunityId && item.profileId === identity.profileId
      );
      if (!opportunity) throw new ClientError(404, "opportunity not found");
      const duplicate = state.applications.find(
        (item) => item.profileId === identity.profileId && item.opportunityId === opportunityId && !inactive(item)
      );
      if (duplicate) throw new ClientError(409, "an application already exists for this opportunity");

      const decision = evaluatePolicy({ opportunity, mode, modeConfig, answers: input.answers });
      if (profileStatus && !profileStatus.readyToApply) {
        decision.confirmations.push({
          kind: "missing_answer",
          message: `Complete the application profile: ${profileStatus.missingForApplications.join(", ")}`,
          fields: profileStatus.missingForApplications
        });
      }
      const today = now().slice(0, 10);
      const globalDailyCount = state.applications.filter(
        (item) => item.profileId === identity.profileId && item.createdAt.startsWith(today) && !inactive(item)
      ).length;
      const dailyCount = state.applications.filter(
        (item) => item.profileId === identity.profileId && item.mode === mode
          && item.createdAt.startsWith(today) && !inactive(item)
      ).length;
      const configuredProfileCap = Number(profile?.preferences?.maxApplicationsPerDay);
      const globalDailyCap = Number.isInteger(configuredProfileCap)
        ? configuredProfileCap === 0 ? Number.POSITIVE_INFINITY : configuredProfileCap
        : this.config.execution?.maxApplicationsPerDay;
      if (Number.isFinite(globalDailyCap) && globalDailyCount >= globalDailyCap) {
        decision.eligible = false;
        decision.reasons.push(`global daily application cap of ${globalDailyCap} reached`);
      }
      const configuredModeCap = Number(modePreferences?.dailyApplicationCap);
      const dailyApplicationCap = Number.isInteger(configuredModeCap)
        ? configuredModeCap === 0 ? Number.POSITIVE_INFINITY : configuredModeCap
        : modeConfig.dailyApplicationCap;
      if (dailyCount >= dailyApplicationCap) {
        decision.eligible = false;
        decision.reasons.push(`daily ${mode} application cap of ${dailyApplicationCap} reached`);
      }
      const application = {
        id: randomUUID(), opportunityId, profileId: identity.profileId, mode,
        requestedBy: identity.actorId, answers: input.answers ?? {},
        submissionApproval,
        finalApprovalRequired: submissionApproval === "always",
        status: !decision.eligible ? "skipped"
          : decision.confirmations.length || !decision.autoApply ? "waiting_confirmation" : "queued",
        decision, createdAt: now(), updatedAt: now()
      };
      state.applications.push(application);
      for (const requirement of decision.confirmations) addConfirmation(state, application, requirement);
      if (!decision.autoApply && decision.eligible && !decision.confirmations.length) {
        addConfirmation(state, application, {
          kind: "manual_policy", message: `Automatic applications are disabled for ${mode}`
        });
      }
      audit(state, identity, "application.requested", application.id, { status: application.status });
      return application;
    });
    if (saved.status === "queued") this.enqueue(saved.id);
    return saved;
  }

  async resolveConfirmation(confirmationId, input, identity) {
    const target = this.store.snapshot().confirmations.find(
      (item) => item.id === confirmationId && item.profileId === identity.profileId
    );
    if (!target) throw new ClientError(404, "confirmation not found");
    let safeAnswers = structuredClone(input.answers ?? {});
    if (target.kind === "account_credentials") {
      if (input.approved === true) {
        if (!this.credentialVault) throw new ClientError(503, "credential vault is not configured");
        if (safeAnswers.site_password) {
          const profile = await this.profiles?.get(identity.profileId);
          await this.credentialVault.set(identity.profileId, target.origin, {
            username: safeAnswers.site_username ?? profile?.contact?.email,
            password: safeAnswers.site_password,
            generated: false
          });
          safeAnswers = { siteAccountAction: "existing", credentialStored: true };
        } else if (safeAnswers.siteAccountAction !== "generate") {
          throw new ClientError(400, "choose generated credentials or provide site_username and site_password");
        }
      } else {
        safeAnswers = {};
      }
    } else {
      assertNoSensitiveAnswerFields(safeAnswers, "confirmation answers");
    }
    const result = await this.store.mutate(async (state) => {
      const confirmation = state.confirmations.find(
        (item) => item.id === confirmationId && item.profileId === identity.profileId
      );
      if (!confirmation) throw new ClientError(404, "confirmation not found");
      if (confirmation.status !== "pending") throw new ClientError(409, "confirmation is already resolved");
      if (confirmation.action === "manual_review" && input.approved === true
        && input.answers?.retry !== true
        && !(input.answers?.submitted === true && input.answers?.finalUrl)) {
        throw new ClientError(400, "manual review requires answers.retry=true or a submitted receipt with finalUrl");
      }
      confirmation.status = input.approved === true ? "approved" : "rejected";
      confirmation.resolvedAt = now();
      confirmation.response = safeAnswers;
      confirmation.resolvedBy = identity.actorId;
      const application = state.applications.find((item) => item.id === confirmation.applicationId);
      if (confirmation.kind === "final_submission_approval" && input.approved === true) {
        application.finalSubmissionApproval = {
          approvedAt: now(), previewFingerprint: confirmation.previewFingerprint
        };
      } else if (confirmation.kind === "account_credentials" && input.approved === true) {
        application.siteAccountAction = safeAnswers.siteAccountAction;
        application.credentialOrigin = confirmation.origin;
      } else if (safeAnswers) Object.assign(application.answers, safeAnswers);
      const related = state.confirmations.filter((item) => item.applicationId === application.id);
      if (related.some((item) => item.status === "rejected")) application.status = "rejected";
      else if (related.every((item) => item.status === "approved")) {
        if (related.some((item) => item.action === "manual_review") && safeAnswers?.submitted === true) {
          application.status = "submitted";
          application.receipt = {
            submittedAt: now(), finalUrl: safeAnswers.finalUrl,
            externalId: safeAnswers.externalId, manuallyVerified: true
          };
        } else application.status = "queued";
      }
      application.updatedAt = now();
      audit(state, identity, "confirmation.resolved", confirmation.id, { status: confirmation.status });
      return application;
    });
    if (result.status === "queued") this.enqueue(result.id);
    return result;
  }

  async recordManualSubmission(applicationId, input, identity) {
    if (input.manuallyVerified !== true || !input.finalUrl) {
      throw new ClientError(400, "manuallyVerified=true and finalUrl are required");
    }
    const finalUrl = validateDirectUrl(input.finalUrl);
    const questionsAndAnswers = normalizeQuestionAnswers(input.questionsAndAnswers);
    return this.store.mutate(async (state) => {
      const application = state.applications.find(
        (item) => item.id === applicationId && item.profileId === identity.profileId
      );
      if (!application) throw new ClientError(404, "application not found");
      const opportunity = state.opportunities.find(
        (item) => item.id === application.opportunityId && item.profileId === identity.profileId
      );
      if (!opportunity) throw new ClientError(404, "opportunity not found");
      if (input.company !== undefined) opportunity.company = requiredLogText(input.company, "company");
      if (input.title !== undefined) opportunity.title = requiredLogText(input.title, "title");
      const submittedAt = application.receipt?.submittedAt ?? now();
      application.status = "submitted";
      application.receipt = {
        ...application.receipt,
        submittedAt,
        finalUrl,
        ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
        manuallyVerified: true
      };
      if (questionsAndAnswers.length) {
        application.recordedQuestionAnswers = questionsAndAnswers.map((item) => ({
          ...item,
          answeredAt: item.answeredAt ?? submittedAt
        }));
      }
      application.updatedAt = now();
      audit(state, identity, "application.manual_submission_recorded", application.id, {
        finalUrl,
        externalId: input.externalId,
        questionCount: questionsAndAnswers.length
      });
      return buildApplicationLogEntry(
        application,
        opportunity,
        state.confirmations.filter((item) => item.applicationId === application.id)
      );
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

  enqueue(applicationId) {
    this.#runner = this.#runner.then(() => this.execute(applicationId))
      .catch((error) => console.error("application queue error", error));
  }

  async waitForIdle() { await this.#runner; }

  async recover() {
    const queued = await this.store.mutate(async (state) => {
      const ids = [];
      for (const item of state.applications) {
        if (item.status === "queued") ids.push(item.id);
        if (item.status !== "submitting") continue;
        item.status = "waiting_confirmation";
        item.updatedAt = now();
        const exists = state.confirmations.some(
          (confirmation) => confirmation.applicationId === item.id
            && confirmation.status === "pending" && confirmation.kind === "submission_recovery"
        );
        if (!exists) addConfirmation(state, item, {
          kind: "submission_recovery", action: "manual_review",
          message: "The server restarted during submission. Verify the remote site before retrying."
        });
        audit(state, { actorId: "system-recovery", profileId: item.profileId }, "application.recovery_review", item.id, {});
      }
      return ids;
    });
    for (const id of queued) this.enqueue(id);
  }

  async execute(applicationId) {
    const claimed = await this.store.mutate(async (state) => {
      const application = state.applications.find((item) => item.id === applicationId);
      if (!application || application.status !== "queued") return null;
      const opportunity = state.opportunities.find((item) => item.id === application.opportunityId);
      application.status = "submitting";
      application.updatedAt = now();
      const identity = { actorId: application.requestedBy ?? "system-runner", profileId: application.profileId };
      audit(state, identity, "application.submitting", application.id, { adapter: this.adapter.name });
      return { application, opportunity, identity };
    });
    if (!claimed) return null;
    const { application, opportunity, identity } = claimed;
    try {
      let profile = this.profiles ? await this.profiles.get(identity.profileId) : undefined;
      if (profile && this.documentStager) profile = await this.documentStager.stage(application, profile);
      if (profile && this.credentialVault) {
        const origin = application.credentialOrigin ?? opportunity.applyUrl;
        const credential = application.siteAccountAction === "generate"
          ? await this.credentialVault.ensureGenerated(identity.profileId, origin, profile.contact?.email)
          : await this.credentialVault.get(identity.profileId, origin);
        if (credential) profile.siteCredential = credential;
      }
      const receipt = await this.adapter.submit({ application, opportunity, profile, actor: identity.actorId });
      return this.store.mutate(async (state) => {
        const item = state.applications.find((entry) => entry.id === applicationId);
        item.status = "submitted";
        item.receipt = receipt;
        item.updatedAt = now();
        audit(state, identity, "application.submitted", item.id, { receipt });
        return item;
      });
    } catch (error) {
      if (error instanceof NeedsInputError) return this.#needsInput(applicationId, identity, error);
      if (error instanceof NeedsReviewError) return this.#needsReview(applicationId, identity, error);
      await this.store.mutate(async (state) => {
        const item = state.applications.find((entry) => entry.id === applicationId);
        item.status = "failed";
        item.error = error.message;
        item.updatedAt = now();
        audit(state, identity, "application.failed", item.id, { error: error.message });
      });
      throw error;
    }
  }

  async #needsInput(applicationId, identity, error) {
    return this.store.mutate(async (state) => {
      const item = state.applications.find((entry) => entry.id === applicationId);
      item.status = "waiting_confirmation";
      item.updatedAt = now();
      for (const requirement of error.requirements) {
        const duplicate = state.confirmations.some(
          (entry) => entry.applicationId === item.id && entry.status === "pending" && entry.kind === requirement.kind
            && JSON.stringify(entry.fields ?? []) === JSON.stringify(requirement.fields ?? [])
        );
        if (!duplicate) addConfirmation(state, item, requirement, error.message);
      }
      audit(state, identity, "application.input_required", item.id, { requirements: error.requirements });
      return item;
    });
  }

  async #needsReview(applicationId, identity, error) {
    return this.store.mutate(async (state) => {
      const item = state.applications.find((entry) => entry.id === applicationId);
      item.status = "waiting_confirmation";
      item.updatedAt = now();
      for (const requirement of error.requirements.length ? error.requirements : [{}]) {
        addConfirmation(state, item, { ...requirement, action: "manual_review" }, error.message);
      }
      audit(state, identity, "application.review_required", item.id, { requirements: error.requirements });
      return item;
    });
  }
}

function addConfirmation(state, application, requirement, fallback) {
  const confirmation = {
    id: randomUUID(), applicationId: application.id, profileId: application.profileId,
    status: "pending", action: requirement.action, kind: requirement.kind ?? "missing_answer",
    message: requirement.message ?? fallback, fields: requirement.fields ?? [],
    options: requirement.options, recommendation: requirement.recommendation,
    origin: requirement.origin, preview: requirement.preview,
    previewFingerprint: requirement.previewFingerprint, createdAt: now()
  };
  confirmation.presentation = buildPresentation(confirmation);
  state.confirmations.push(confirmation);
}

function buildPresentation(confirmation) {
  const text = confirmation.kind === "final_submission_approval"
    ? formatPreview(confirmation) : confirmation.message;
  let buttons;
  if (confirmation.kind === "final_submission_approval") {
    buttons = [
      { label: "Approve & submit (recommended)", value: `jobapp:${confirmation.id}:approve`, style: "success" },
      { label: "Decline", value: `jobapp:${confirmation.id}:reject`, style: "danger" }
    ];
  } else {
    buttons = (confirmation.options ?? []).slice(0, 8).map((option, index) => ({
      label: `${option.recommended ? "★ " : ""}${String(option.label).slice(0, 48)}`,
      value: `jobapp:${confirmation.id}:choose:${index}`
    }));
    buttons.push({
      label: `${confirmation.recommendation === "custom" ? "★ " : ""}I’ll type an answer`,
      value: `jobapp:${confirmation.id}:custom`
    });
  }
  return { blocks: [{ type: "text", text }, { type: "buttons", buttons }] };
}

function formatPreview(confirmation) {
  const preview = confirmation.preview ?? {};
  const lines = [confirmation.message];
  if (preview.destination) lines.push(`Destination: ${preview.destination}`);
  lines.push("", "Filled fields:");
  for (const field of preview.filled ?? []) lines.push(`• ${field.label}: ${field.value} (${field.source})`);
  lines.push("", "Not filled:");
  if (!(preview.unfilled ?? []).length) lines.push("• None");
  for (const field of preview.unfilled ?? []) lines.push(`• ${field.label}${field.required ? " (required)" : ""}`);
  return lines.join("\n").slice(0, 3500);
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

function assertNoSensitiveAnswerFields(value, label, path = "") {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    const field = path ? `${path}.${key}` : key;
    if (CREDENTIAL_INPUT_KEY.test(key)) {
      throw new ClientError(400, `${label} must not contain credential field: ${field}`);
    }
    assertNoSensitiveAnswerFields(nested, label, field);
  }
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
  const finalPreview = confirmations
    .filter((item) => item.kind === "final_submission_approval" && item.preview)
    .at(-1)?.preview;
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
    status: application.status,
    createdAt: application.createdAt,
    updatedAt: application.updatedAt,
    submittedAt: application.receipt?.submittedAt,
    questionsAndAnswers: [...answered.values()],
    submittedFields: (finalPreview?.filled ?? []).map((field) => ({
      label: field.label,
      value: sanitizeLoggedValue(field.label, field.value),
      source: field.source
    })),
    decision: application.decision,
    error: application.error,
    employerStatus: application.employerStatus,
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

function normalizeQuestionAnswers(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 200) {
    throw new ClientError(400, "questionsAndAnswers must be an array with at most 200 items");
  }
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ClientError(400, "each question and answer must be an object");
    }
    const field = typeof item.field === "string" ? item.field.trim() : undefined;
    const question = typeof item.question === "string" ? item.question.trim() : undefined;
    if (!field && !question) throw new ClientError(400, "each answer needs a field or question");
    const key = field ?? question;
    return {
      ...(field ? { field } : {}),
      question: question ?? field,
      answer: sanitizeLoggedValue(key, item.answer)
    };
  });
}

function requiredLogText(value, field) {
  if (typeof value !== "string" || !value.trim() || value.length > 300) {
    throw new ClientError(400, `${field} must be a non-empty string with at most 300 characters`);
  }
  return value.trim();
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
