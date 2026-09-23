import { createHash, randomUUID } from "node:crypto";
import { evaluatePolicy } from "./policy.js";
import { NeedsInputError, NeedsReviewError, NeedsResearchError, PostingUnavailableError,
  RetryableExecutionError } from "./adapters/errors.js";
import { telemetry as defaultTelemetry } from "./telemetry.js";
import { roleKeys } from "./discovery/handled-roles.js";
import { scoreOpportunity } from "./discovery/scoring.js";
import { officialAtsDestination, revalidateOfficialAtsRole } from "./discovery/official-ats.js";
import { buildWorkflowReport, recordWorkflowStage } from "./workflow-report.js";
import { policyCovers, hardPolicyHolds, LEGAL_ATTESTATION_FIELD } from "./standing-policy.js";

function now() { return new Date().toISOString(); }
const inactive = (item) => ["skipped", "rejected", "failed"].includes(item.status);

export class ApplicationService {
  #profileRunners = new Map();
  #activeExecutions = 0;
  #executionWaiters = [];

  constructor({ store, config, adapter, profiles, documentStager, credentialVault,
    telemetry = defaultTelemetry, fetchImpl = fetch }) {
    this.store = store;
    this.config = config;
    this.adapter = adapter;
    this.profiles = profiles;
    this.documentStager = documentStager;
    this.credentialVault = credentialVault;
    this.telemetry = telemetry;
    this.fetchImpl = fetchImpl;
  }

  list(collection, profileId) {
    return this.store.snapshot()[collection].filter((item) => item.profileId === profileId);
  }

  async recordStandingPolicyChange(policy, identity) {
    return this.store.mutate((state) => {
      if (!state.audit.some((item) => item.profileId === identity.profileId
        && item.action === "standing_policy.changed" && item.subjectId === policy.id
        && item.details?.version === policy.version)) {
        audit(state, identity, "standing_policy.changed", policy.id, {
          version: policy.version, mode: policy.mode, dailyCap: policy.dailyCap,
          campaignCap: policy.campaignCap
        });
      }
      return { version: policy.version };
    });
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

  campaignWorkflowReport(campaignId, profileId) {
    const state = this.store.snapshot();
    return buildWorkflowReport(state, { ...this.campaignStatus(campaignId, profileId, state), profileId });
  }

  async addOpportunity(input, identity, { serverVerifiedDiscovery = false } = {}) {
    if (!input.title || !input.company || !input.applyUrl) {
      throw new ClientError(400, "title, company, and applyUrl are required");
    }
    // Client-supplied score/source/provenance is useful for review but cannot
    // establish authorization for an automatic final action.
    const { discoveryVerification: _untrustedVerification, ...candidate } = input;
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
        return existing;
      }
      const item = {
        ...candidate, id: randomUUID(), profileId: identity.profileId, dedupKey,
        mode: candidate.mode ?? this.config.defaultMode, source: candidate.source ?? "agent",
        score: Number(candidate.score ?? 0), status: "discovered", createdAt: now(),
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
    let initialOpportunity = this.store.snapshot().opportunities.find(
      (item) => item.id === opportunityId && item.profileId === identity.profileId
    );
    if (!initialOpportunity) throw new ClientError(404, "opportunity not found");
    const mode = input.mode ?? initialOpportunity.mode ?? this.config.defaultMode;
    const modeConfig = this.config.modes[mode];
    if (!modeConfig) throw new ClientError(400, `unknown mode: ${mode}`);
    const profile = this.profiles ? await this.profiles.get(identity.profileId) : null;
    if (policyCovers(profile?.standingSubmissionPolicy, initialOpportunity, mode)
      && !verifiedDiscoveryIsFresh(initialOpportunity, mode)) {
      initialOpportunity = await this.#refreshDiscoveryVerification(initialOpportunity);
    }
    const profileStatus = this.profiles
      ? await this.profiles.status(identity.profileId, mode, this.config.defaultMode) : null;
    const modePreferences = mode === "freelance"
      ? profile?.preferences?.freelance : profile?.preferences?.fullTime;
    const covered = input.forceFinalApproval !== true
      && policyCovers(profile?.standingSubmissionPolicy, initialOpportunity, mode)
      && verifiedDiscoveryIsFresh(initialOpportunity, mode);
    const submissionApproval = covered ? "automatic" : "always";
    if (!["automatic", "always"].includes(submissionApproval)) {
      throw new ClientError(400, `invalid submissionApproval for ${mode}`);
    }

    const saved = await this.store.mutate(async (state) => {
      if (input.campaignId && !campaignStart(state, String(input.campaignId), identity.profileId)) {
        throw new ClientError(404, "campaign not found");
      }
      const opportunity = state.opportunities.find(
        (item) => item.id === opportunityId && item.profileId === identity.profileId
      );
      if (!opportunity) throw new ClientError(404, "opportunity not found");
      const duplicate = state.applications.find(
        (item) => item.profileId === identity.profileId && item.opportunityId === opportunityId && !inactive(item)
      );
      if (duplicate) throw new ClientError(409, "an application already exists for this opportunity");

      const decision = evaluatePolicy({ opportunity, mode, modeConfig, answers: input.answers });
      if (covered) {
        const freshScore = scoreOpportunity(opportunity, profile, mode,
          { version: String(this.config.discovery?.scorerVersion ?? "2") });
        if (freshScore.scoreDetails.hardExclusion || freshScore.score < modeConfig.minimumScore) {
          decision.eligible = false;
          decision.reasons.push(freshScore.scoreDetails.hardExclusion ?? "current fit score below minimum");
        }
        decision.autoApply = true;
        decision.confirmations.push(...hardPolicyHolds({ opportunity, mode, answers: input.answers, profile })
          .filter((hold) => !decision.confirmations.some((existing) => existing.kind === hold.kind
            && JSON.stringify(existing.fields ?? []) === JSON.stringify(hold.fields ?? []))));
      }
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
      if (!covered && Number.isFinite(globalDailyCap) && globalDailyCount >= globalDailyCap) {
        decision.eligible = false;
        decision.reasons.push(`global daily application cap of ${globalDailyCap} reached`);
      }
      const configuredModeCap = Number(modePreferences?.dailyApplicationCap);
      const dailyApplicationCap = Number.isInteger(configuredModeCap)
        ? configuredModeCap === 0 ? Number.POSITIVE_INFINITY : configuredModeCap
        : modeConfig.dailyApplicationCap;
      if (!covered && dailyCount >= dailyApplicationCap) {
        decision.eligible = false;
        decision.reasons.push(`daily ${mode} application cap of ${dailyApplicationCap} reached`);
      }
      const application = {
        id: randomUUID(), opportunityId, profileId: identity.profileId, mode,
        requestedBy: identity.actorId, answers: input.answers ?? {},
        ...(input.campaignId ? { campaignId: String(input.campaignId) } : {}),
        submissionApproval,
        ...(covered ? { standingPolicyVersion: profile.standingSubmissionPolicy.version } : {}),
        finalApprovalRequired: submissionApproval === "always",
        status: !decision.eligible ? "skipped"
          : decision.confirmations.length || !decision.autoApply ? "waiting_confirmation" : "queued",
        decision, createdAt: now(), updatedAt: now()
      };
      if (application.status === "queued") application.queuedAt = application.createdAt;
      state.applications.push(application);
      for (const requirement of decision.confirmations) addConfirmation(state, application, requirement);
      if (!decision.autoApply && decision.eligible && !decision.confirmations.length) {
        addConfirmation(state, application, {
          kind: "manual_policy", message: `Automatic applications are disabled for ${mode}`
        });
      }
      audit(state, identity, "application.requested", application.id, { status: application.status });
      recordWorkflowStage(state, identity, application.id, "preparation", {
        campaignId: application.campaignId, applicationId: application.id, outcome: application.status
      });
      return application;
    });
    this.telemetry.count("applications.admitted", 1, { mode, status: saved.status });
    if (saved.status === "queued") this.enqueue(saved.id);
    return saved;
  }

  async prepareFinalSubmission(input) {
    const { applicationId, attemptId, previewFingerprint, preview } = input;
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(applicationId ?? "")
      || !/^[a-zA-Z0-9_-]{1,80}$/.test(attemptId ?? "")
      || !/^[a-f0-9]{64}$/.test(previewFingerprint ?? "") || !preview || typeof preview !== "object") {
      throw new ClientError(400, "invalid final decision request");
    }
    const application = this.store.snapshot().applications.find((item) => item.id === applicationId);
    if (!application) throw new ClientError(404, "application not found");
    const profile = await this.profiles?.get(application.profileId);
    const initialOpportunity = this.store.snapshot().opportunities.find((item) => item.id === application.opportunityId);
    if (initialOpportunity && policyCovers(profile?.standingSubmissionPolicy, initialOpportunity, application.mode)
      && !verifiedDiscoveryIsFresh(initialOpportunity, application.mode)) {
      await this.#refreshDiscoveryVerification(initialOpportunity);
    }
    return this.store.mutate(async (state) => {
      const current = state.applications.find((item) => item.id === applicationId);
      const opportunity = state.opportunities.find((item) => item.id === current?.opportunityId);
      if (!current || current.status !== "submitting" || current.claim?.attemptId !== attemptId
        || !opportunity) throw new ClientError(409, "application is not in this submission attempt");
      const policy = profile?.standingSubmissionPolicy;
      const reasonCodes = [];
      if (!policyCovers(policy, opportunity, current.mode)) reasonCodes.push("policy_not_covering");
      if (!verifiedDiscoveryIsFresh(opportunity, current.mode)) reasonCodes.push("discovery_unverified_or_stale");
      if (profile && opportunity) {
        const freshScore = scoreOpportunity(opportunity, profile, current.mode,
          { version: String(this.config.discovery?.scorerVersion ?? "2") });
        if (freshScore.scoreDetails.hardExclusion
          || freshScore.score < this.config.modes[current.mode].minimumScore) {
          reasonCodes.push("current_fit_not_eligible");
        }
      }
      if (current.standingPolicyVersion !== policy?.version) reasonCodes.push("policy_version_changed");
      let destinationMatches = false;
      try {
        const previewHost = new URL(preview.destination).hostname.toLowerCase();
        const roleIdentity = roleKeys(opportunity);
        destinationMatches = policy?.destinationHosts?.some((host) => host === previewHost || host === "*")
          && [...roleKeys({ applyUrl: preview.destination })]
            .some((key) => !key.startsWith("role:") && roleIdentity.has(key));
      } catch { /* invalid destination is a hold */ }
      if (!destinationMatches) {
        reasonCodes.push("destination_changed");
      }
      if (preview.company !== opportunity.company || preview.title !== opportunity.title) {
        reasonCodes.push("role_changed");
      }
      const fields = [...(preview.filled ?? []), ...(preview.unfilled ?? [])];
      if (!Array.isArray(preview.filled) || !Array.isArray(preview.unfilled) || fields.length > 300) {
        reasonCodes.push("invalid_preview");
      } else {
        if (preview.unfilled.some((field) => field.required === true)) reasonCodes.push("required_field_unfilled");
        if (fields.some((field) => ["application answer", "unverified site prefill"].includes(field.source))) {
          reasonCodes.push("answer_provenance_unverified");
        }
        if (preview.filled.some((field) => {
          const answerClass = field.source === "drafted prose" ? "grounded_prose"
            : field.type === "file" ? "resume"
              : /(?:url|link|website|portfolio|github|linkedin)/i.test(field.label ?? "") ? "link"
                : "profile_fact";
          return !policy?.answerClasses?.includes(answerClass);
        })) reasonCodes.push("answer_class_not_authorized");
        if (fields.some((field) => field.source === "drafted prose")
          && !policy?.answerClasses?.includes("grounded_prose")) reasonCodes.push("prose_not_authorized");
        if (fields.some((field) => LEGAL_ATTESTATION_FIELD.test(`${field.label ?? ""} ${field.key ?? ""}`))) {
          reasonCodes.push("legal_answer_unconfirmed");
        }
      }
      if (hardPolicyHolds({ opportunity, mode: current.mode, answers: current.answers, profile }).length) {
        reasonCodes.push("policy_hard_hold");
      }
      const today = now().slice(0, 10);
      const counted = state.applications.filter((item) => item.profileId === current.profileId
        && item.id !== current.id && (item.receipt?.submittedAt?.startsWith(today)
          || item.finalSubmissionDecision?.status === "consumed"
            && item.finalSubmissionDecision.createdAt.startsWith(today)
          || item.finalSubmissionDecision?.status === "reserved"
            && Date.parse(item.finalSubmissionDecision.expiresAt) > Date.now()));
      if (counted.length >= (policy?.dailyCap ?? 0)) reasonCodes.push("daily_cap_reached");
      if (current.campaignId && counted.filter((item) => item.campaignId === current.campaignId).length
        >= (policy?.campaignCap ?? 0)) reasonCodes.push("campaign_cap_reached");
      const decision = { id: randomUUID(), schemaVersion: 1, applicationId, attemptId,
        policyId: policy?.id ?? null, policyVersion: policy?.version ?? null,
        roleKey: [...roleKeys(opportunity)].sort()[0] ?? opportunity.id,
        previewFingerprint, decision: reasonCodes.length ? "hold" : "permit", reasonCodes,
        createdAt: now(), expiresAt: new Date(Date.now() + 30_000).toISOString(),
        status: reasonCodes.length ? "held" : "reserved" };
      current.finalSubmissionDecision = decision;
      audit(state, { actorId: "worker", profileId: current.profileId }, "application.final_decision", current.id,
        { decision: decision.decision, reasonCodes, policyVersion: decision.policyVersion });
      recordWorkflowStage(state, { actorId: "worker", profileId: current.profileId }, current.id,
        "final_decision", { campaignId: current.campaignId, applicationId: current.id,
          attemptId, outcome: decision.decision });
      return { decision: decision.decision, reasonCodes,
        ...(decision.decision === "permit" ? { permit: decision.id } : {}) };
    });
  }

  async #refreshDiscoveryVerification(opportunity) {
    if (!opportunity?.discoveryVerification || !officialAtsDestination(opportunity)
      || opportunity.validThrough && Date.parse(opportunity.validThrough) <= Date.now()) return opportunity;
    if (!await revalidateOfficialAtsRole(opportunity, this.fetchImpl)) return opportunity;
    return this.store.mutate((state) => {
      const current = state.opportunities.find((item) => item.id === opportunity.id);
      if (!current || current.profileId !== opportunity.profileId
        || current.applyUrl !== opportunity.applyUrl || current.title !== opportunity.title
        || current.userRequested === true || current.direct === true) return current ?? opportunity;
      current.discoveryVerification.verifiedAt = now();
      audit(state, { actorId: "system-discovery-refresh", profileId: current.profileId },
        "opportunity.discovery_revalidated", current.id, { source: current.source });
      return current;
    });
  }

  async commitFinalSubmission(input) {
    const application = this.store.snapshot().applications.find((item) => item.id === input.applicationId);
    if (!application) throw new ClientError(404, "application not found");
    const profile = await this.profiles?.get(application.profileId);
    return this.store.mutate(async (state) => {
      const current = state.applications.find((item) => item.id === input.applicationId);
      const opportunity = state.opportunities.find((item) => item.id === current?.opportunityId);
      const decision = current?.finalSubmissionDecision;
      const policy = profile?.standingSubmissionPolicy;
      if (!current || current.status !== "submitting" || current.claim?.attemptId !== input.attemptId
        || decision?.id !== input.permit || decision.status !== "reserved"
        || Date.parse(decision.expiresAt) <= Date.now()
        || !policyCovers(policy, opportunity, current.mode)
        || policy.id !== decision.policyId || policy.version !== decision.policyVersion
        || decision.previewFingerprint !== input.previewFingerprint) {
        throw new ClientError(409, "final submission permit is invalid or revoked");
      }
      const today = now().slice(0, 10);
      const counted = state.applications.filter((item) => item.profileId === current.profileId
        && item.id !== current.id && (item.receipt?.submittedAt?.startsWith(today)
          || item.finalSubmissionDecision?.status === "consumed"
            && item.finalSubmissionDecision.createdAt.startsWith(today)
          || item.finalSubmissionDecision?.status === "reserved"
            && Date.parse(item.finalSubmissionDecision.expiresAt) > Date.now()));
      if (counted.length >= policy.dailyCap || current.campaignId
        && counted.filter((item) => item.campaignId === current.campaignId).length >= policy.campaignCap) {
        throw new ClientError(409, "final submission cap reached");
      }
      decision.status = "consumed";
      decision.consumedAt = now();
      audit(state, { actorId: "worker", profileId: current.profileId }, "application.final_permit_consumed", current.id,
        { policyVersion: policy.version });
      recordWorkflowStage(state, { actorId: "worker", profileId: current.profileId }, current.id,
        "final_action", { campaignId: current.campaignId, applicationId: current.id,
          attemptId: input.attemptId, outcome: "permit_consumed" });
      return { committed: true };
    });
  }

  async resolveConfirmation(confirmationId, input, identity) {
    const target = this.store.snapshot().confirmations.find(
      (item) => item.id === confirmationId && item.profileId === identity.profileId
    );
    if (!target) throw new ClientError(404, "confirmation not found");
    let requireApprovalOnRetry = false;
    if (["submission_unverified", "submission_recovery"].includes(target.kind)
      && input.approved === true && input.answers?.retry === true && this.adapter.attemptStatus) {
      const priorApplication = this.store.snapshot().applications.find((item) => item.id === target.applicationId
        && item.profileId === identity.profileId);
      const mode = priorApplication?.mode ?? this.config.defaultMode;
      const profile = this.profiles ? await this.profiles.get(identity.profileId) : null;
      const modePreferences = mode === "freelance"
        ? profile?.preferences?.freelance : profile?.preferences?.fullTime;
      requireApprovalOnRetry = (modePreferences?.submissionApproval
        ?? this.config.modes[mode]?.submissionApproval) === "always";
      let worker;
      try { worker = await this.adapter.attemptStatus(target.applicationId); }
      catch { throw new ClientError(409, "worker status is unavailable; verify that the old attempt has stopped before retrying"); }
      if (worker.status === "active") {
        throw new ClientError(409, "the previous browser attempt is still running");
      }
      if (worker.status === "final_action_started") {
        throw new ClientError(409, "the previous final action may have run; verify the employer outcome before retrying");
      }
      if (worker.status === "submitted" && worker.receipt?.submittedAt && worker.receipt?.finalUrl) {
        return this.store.mutate(async (state) => {
          const application = state.applications.find((item) => item.id === target.applicationId
            && item.profileId === identity.profileId);
          const confirmation = state.confirmations.find((item) => item.id === confirmationId
            && item.status === "pending");
          if (!application || !confirmation) throw new ClientError(409, "confirmation is no longer pending");
          application.status = "submitted";
          application.receipt = worker.receipt;
          application.updatedAt = now();
          confirmation.status = "approved";
          confirmation.resolvedAt = now();
          confirmation.resolvedBy = identity.actorId;
          audit(state, identity, "application.late_receipt_reconciled", application.id, {});
          return application;
        });
      }
    }
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
      for (const controlField of ["retry", "submitted", "finalUrl", "externalId"]) {
        delete safeAnswers[controlField];
      }
    }
    const result = await this.store.mutate(async (state) => {
      const confirmation = state.confirmations.find(
        (item) => item.id === confirmationId && item.profileId === identity.profileId
      );
      if (!confirmation) throw new ClientError(404, "confirmation not found");
      if (confirmation.status !== "pending") throw new ClientError(409, "confirmation is already resolved");
      const hasManualFieldAnswers = confirmation.action === "manual_review"
        && Array.isArray(confirmation.fields) && confirmation.fields.length > 0
        && confirmation.fields.every((field) => Object.hasOwn(safeAnswers, field)
          && safeAnswers[field] !== undefined && safeAnswers[field] !== null
          && String(safeAnswers[field]).trim() !== "");
      if (confirmation.action === "manual_review" && input.approved === true
        && input.answers?.retry !== true
        && !(input.answers?.submitted === true && input.answers?.finalUrl)
        && !hasManualFieldAnswers) {
        throw new ClientError(400,
          "manual review requires answers for every named field, answers.retry=true, or a submitted receipt with finalUrl");
      }
      confirmation.status = input.approved === true ? "approved" : "rejected";
      confirmation.resolvedAt = now();
      confirmation.response = safeAnswers;
      confirmation.resolvedBy = identity.actorId;
      const application = state.applications.find((item) => item.id === confirmation.applicationId);
      if (input.approved !== true) {
        for (const sibling of state.confirmations) {
          if (sibling.applicationId === application.id && sibling.id !== confirmation.id
            && sibling.status === "pending") {
            sibling.status = "superseded";
            sibling.resolvedAt = confirmation.resolvedAt;
            sibling.resolvedBy = identity.actorId;
          }
        }
      }
      if (requireApprovalOnRetry) {
        application.finalApprovalRequired = true;
        application.submissionApproval = "always";
        application.finalSubmissionApproval = undefined;
      }
      if (confirmation.kind === "final_submission_approval" && input.approved === true) {
        application.finalSubmissionApproval = {
          approvedAt: now(), previewFingerprint: confirmation.previewFingerprint
        };
      } else if (confirmation.kind === "account_credentials" && input.approved === true) {
        application.siteAccountAction = safeAnswers.siteAccountAction;
        application.credentialOrigin = confirmation.origin;
      } else if (safeAnswers) Object.assign(application.answers, safeAnswers);
      const related = state.confirmations.filter((item) => item.applicationId === application.id
        && item.status !== "superseded");
      if (related.some((item) => item.status === "rejected")) application.status = "rejected";
      else if (related.every((item) => item.status === "approved")) {
        if (related.some((item) => item.action === "manual_review") && safeAnswers?.submitted === true) {
          application.status = "submitted";
          application.receipt = {
            submittedAt: now(), finalUrl: safeAnswers.finalUrl,
            externalId: safeAnswers.externalId, manuallyVerified: true
          };
        } else {
          application.status = "queued";
          application.queuedAt = now();
        }
      }
      application.updatedAt = now();
      audit(state, identity, "confirmation.resolved", confirmation.id, { status: confirmation.status });
      recordWorkflowStage(state, identity, application.id, "owner_hold", {
        campaignId: application.campaignId, applicationId: application.id,
        outcome: confirmation.status,
        durationMs: Math.max(0, Date.parse(confirmation.resolvedAt) - Date.parse(confirmation.createdAt))
      });
      if (application.status === "rejected") recordWorkflowStage(state, identity, application.id,
        "terminal_failure", { campaignId: application.campaignId, applicationId: application.id,
          outcome: "owner_rejected" });
      return application;
    });
    if (result.status === "queued") this.enqueue(result.id);
    return result;
  }

  async refreshFinalPreview(applicationId, identity, input = {}) {
    const answers = structuredClone(input.answers ?? {});
    assertNoSensitiveAnswerFields(answers, "preview revision answers");
    const application = await this.store.mutate(async (state) => {
      const item = state.applications.find((entry) => entry.id === applicationId
        && entry.profileId === identity.profileId && entry.status === "waiting_confirmation"
        && !entry.receipt);
      if (!item) throw new ClientError(409, "application is not waiting for a final preview");
      const pending = state.confirmations.filter((entry) => entry.applicationId === item.id
        && entry.profileId === identity.profileId && entry.status === "pending");
      if (pending.length !== 1 || pending[0].kind !== "final_submission_approval") {
        throw new ClientError(409, "only a sole pending final preview can be refreshed");
      }
      pending[0].status = "superseded";
      pending[0].resolvedAt = now();
      pending[0].resolvedBy = identity.actorId;
      Object.assign(item.answers, answers);
      item.finalSubmissionApproval = undefined;
      item.status = "queued";
      item.queuedAt = now();
      item.updatedAt = item.queuedAt;
      audit(state, identity, "application.final_preview_refreshed", item.id,
        { oldConfirmationId: pending[0].id, revisedAnswerCount: Object.keys(answers).length });
      return item;
    });
    this.enqueue(application.id);
    return application;
  }

  async approvePreparedBatch(entries, identity) {
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > 50
      || new Set(entries.map((entry) => entry?.applicationId)).size !== entries.length) {
      throw new ClientError(400, "batch must contain 1 to 50 distinct applications");
    }
    const approved = await this.store.mutate(async (state) => {
      const matches = entries.map((entry) => {
        const application = state.applications.find((item) => item.id === entry.applicationId
          && item.profileId === identity.profileId && item.status === "waiting_confirmation");
        const confirmation = state.confirmations.find((item) => item.applicationId === entry.applicationId
          && item.profileId === identity.profileId && item.status === "pending"
          && item.kind === "final_submission_approval"
          && item.previewFingerprint === entry.previewFingerprint);
        const others = state.confirmations.some((item) => item.applicationId === entry.applicationId
          && item.profileId === identity.profileId && item.status === "pending"
          && item.kind !== "final_submission_approval");
        if (!application || !confirmation || others) {
          throw new ClientError(409, `application ${entry.applicationId} is not ready for this exact approval`);
        }
        return { application, confirmation };
      });
      for (const { application, confirmation } of matches) {
        confirmation.status = "approved";
        confirmation.resolvedAt = now();
        confirmation.resolvedBy = identity.actorId;
        application.finalSubmissionApproval = {
          approvedAt: confirmation.resolvedAt, previewFingerprint: confirmation.previewFingerprint
        };
        application.status = "queued";
        application.queuedAt = now();
        application.updatedAt = now();
        audit(state, identity, "confirmation.batch_approved", confirmation.id,
          { applicationId: application.id, previewFingerprint: confirmation.previewFingerprint });
        recordWorkflowStage(state, identity, application.id, "owner_hold", {
          campaignId: application.campaignId, applicationId: application.id, outcome: "batch_approved",
          durationMs: Math.max(0, Date.parse(confirmation.resolvedAt) - Date.parse(confirmation.createdAt))
        });
      }
      return matches.map(({ application }) => application);
    });
    for (const application of approved) this.enqueue(application.id);
    return { items: approved.map((item) => ({ applicationId: item.id, status: item.status })) };
  }

  async createCampaign(input, identity) {
    if (!/^[a-f0-9-]{36}$/.test(input.id ?? "")
      || !Number.isInteger(input.target) || input.target < 1 || input.target > 50
      || !Number.isInteger(input.reserve) || input.reserve < 0 || input.reserve > 50) {
      throw new ClientError(400, "campaign requires an id, target from 1 to 50, and reserve from 0 to 50");
    }
    return this.store.mutate(async (state) => {
      if (state.audit.some((item) => item.profileId === identity.profileId
        && item.action === "campaign.started" && item.subjectId === input.id)) {
        throw new ClientError(409, "campaign already exists");
      }
      audit(state, identity, "campaign.started", input.id, {
        target: input.target, reserve: input.reserve, mode: input.mode,
        sources: input.sources ?? [], fallbackSources: input.fallbackSources ?? [], queryPlan: input.queryPlan ?? []
      });
      recordWorkflowStage(state, identity, input.id, "discovery", { campaignId: input.id, outcome: "started" });
      return this.campaignStatus(input.id, identity.profileId, state);
    });
  }

  async recordCampaignScan(campaignId, input, identity) {
    return this.store.mutate(async (state) => {
      const started = campaignStart(state, campaignId, identity.profileId);
      if (!started) throw new ClientError(404, "campaign not found");
      audit(state, identity, "campaign.scan_completed", campaignId, {
        found: input.found, qualifying: input.qualifying, excluded: input.excluded,
        handledFiltered: input.handledFiltered, selectedOpportunityIds: input.selectedOpportunityIds ?? [],
        destinationPending: input.destinationPending ?? 0,
        applicationIds: input.applicationIds ?? [], errors: input.errors ?? [],
        sourceYield: input.sourceYield ?? [], durations: input.durations ?? {}
      });
      for (const [stage, durationMs] of [["discovery", input.durations?.fetchMs],
        ["screening", input.durations?.screeningMs], ["destination", input.durations?.destinationMs]]) {
        recordWorkflowStage(state, identity, campaignId, stage, { campaignId, durationMs,
          found: input.found, qualifying: input.qualifying, excluded: input.excluded,
          handledFiltered: input.handledFiltered, destinationPending: input.destinationPending,
          outcome: "completed" });
      }
      return this.campaignStatus(campaignId, identity.profileId, state);
    });
  }

  async recordCampaignFailure(campaignId, error, identity) {
    return this.store.mutate(async (state) => {
      if (!campaignStart(state, campaignId, identity.profileId)) throw new ClientError(404, "campaign not found");
      audit(state, identity, "campaign.failed", campaignId, {
        error: String(error?.message ?? error).slice(0, 1000)
      });
      recordWorkflowStage(state, identity, campaignId, "terminal_failure", { campaignId, outcome: "campaign_failed" });
      return this.campaignStatus(campaignId, identity.profileId, state);
    });
  }

  async recordCampaignSourceScan(campaignId, input, identity) {
    return this.store.mutate(async (state) => {
      const started = campaignStart(state, campaignId, identity.profileId);
      if (!started) throw new ClientError(404, "campaign not found");
      if (!(started.details.fallbackSources ?? []).includes(input.sourceId)) {
        throw new ClientError(400, "source is not in this campaign fallback plan");
      }
      audit(state, identity, "campaign.source_scanned", campaignId, {
        sourceId: input.sourceId, found: input.found, qualifying: input.qualifying,
        excluded: input.excluded, handledFiltered: input.handledFiltered,
        selected: input.selected, opportunityIds: input.opportunityIds ?? [],
        exclusionReasons: input.exclusionReasons ?? [],
        completed: input.completed, pagesVisited: input.pagesVisited, requestsMade: input.requestsMade,
        rateLimited: input.rateLimited === true, exhausted: input.exhausted === true,
        errors: input.errors ?? []
      });
      recordWorkflowStage(state, identity, campaignId, "discovery", { campaignId,
        sourceId: input.sourceId, found: input.found, qualifying: input.qualifying,
        excluded: input.excluded, handledFiltered: input.handledFiltered,
        outcome: input.rateLimited ? "rate_limited" : "completed" });
      return this.campaignStatus(campaignId, identity.profileId, state);
    });
  }

  async finalizeCampaignSelection(campaignId, identity) {
    const campaign = this.campaignStatus(campaignId, identity.profileId);
    if (campaign.sourceCoverage.fallbackRemaining.length) {
      throw new ClientError(409, "campaign source search is not complete");
    }
    const state = this.store.snapshot();
    const events = state.audit.filter((item) => item.profileId === identity.profileId
      && item.subjectId === campaignId && item.action.startsWith("campaign."));
    const scan = events.findLast((item) => item.action === "campaign.scan_completed");
    const ids = [...new Set([
      ...(scan?.details.selectedOpportunityIds ?? []),
      ...events.filter((item) => item.action === "campaign.source_scanned")
        .flatMap((item) => item.details.opportunityIds ?? [])
    ])];
    const opportunities = state.opportunities.filter((item) => item.profileId === identity.profileId
      && ids.includes(item.id)).sort((left, right) => Number(right.score ?? 0) - Number(left.score ?? 0)
      || Date.parse(right.postedAt ?? 0) - Date.parse(left.postedAt ?? 0));
    const selectedIds = [];
    for (const opportunity of opportunities) {
      if (selectedIds.length >= campaign.target + campaign.reserve) break;
      try {
        await this.requestApplication(opportunity.id, { campaignId }, identity);
        selectedIds.push(opportunity.id);
      } catch (error) {
        if (error.status !== 409) throw error;
      }
    }
    await this.store.mutate(async (draft) => audit(draft, identity, "campaign.selection_finalized", campaignId,
      { candidateCount: opportunities.length, selectedOpportunityIds: selectedIds }));
    return this.campaignStatus(campaignId, identity.profileId);
  }

  listCampaigns(profileId) {
    const state = this.store.snapshot();
    return state.audit.filter((item) => item.profileId === profileId && item.action === "campaign.started")
      .map((item) => this.campaignStatus(item.subjectId, profileId, state))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  campaignStatus(campaignId, profileId, snapshot = this.store.snapshot()) {
    const started = campaignStart(snapshot, campaignId, profileId);
    if (!started) throw new ClientError(404, "campaign not found");
    const events = snapshot.audit.filter((item) => item.profileId === profileId && item.subjectId === campaignId
      && item.action.startsWith("campaign.")).sort((left, right) => left.at.localeCompare(right.at));
    const scan = events.findLast((item) => item.action === "campaign.scan_completed");
    const failed = events.findLast((item) => item.action === "campaign.failed");
    const approval = events.find((item) => item.action === "campaign.batch_approved");
    const selection = events.findLast((item) => item.action === "campaign.selection_finalized");
    const sourceScans = events.filter((item) => item.action === "campaign.source_scanned");
    const applications = snapshot.applications.filter((item) => item.profileId === profileId
      && item.campaignId === campaignId);
    const applicationIds = new Set(applications.map((item) => item.id));
    const opportunities = new Map(snapshot.opportunities.filter((item) => item.profileId === profileId)
      .map((item) => [item.id, item]));
    const attempts = (snapshot.attempts ?? []).filter((item) => item.profileId === profileId
      && applicationIds.has(item.applicationId));
    const finalConfirmations = snapshot.confirmations.filter((item) => item.profileId === profileId
      && item.kind === "final_submission_approval" && applicationIds.has(item.applicationId));
    const pendingFinal = snapshot.confirmations.filter((item) => item.profileId === profileId
      && item.status === "pending" && item.kind === "final_submission_approval"
      && applicationIds.has(item.applicationId));
    const pendingOther = snapshot.confirmations.filter((item) => item.profileId === profileId
      && item.status === "pending" && item.kind !== "final_submission_approval"
      && applicationIds.has(item.applicationId));
    const counts = Object.fromEntries([...new Set(applications.map((item) => item.status))]
      .map((status) => [status, applications.filter((item) => item.status === status).length]));
    const submitted = applications.filter((item) => item.status === "submitted" && item.receipt?.submittedAt)
      .sort((left, right) => left.receipt.submittedAt.localeCompare(right.receipt.submittedAt));
    const target = started.details.target;
    const fallbackPlanned = started.details.fallbackSources ?? [];
    const fallbackCovered = [...new Set(sourceScans.filter((item) => item.details.completed !== false)
      .map((item) => item.details.sourceId))];
    const fallbackRemaining = fallbackPlanned.filter((source) => !fallbackCovered.includes(source));
    const searchingMore = Boolean(scan && applications.length < target && fallbackRemaining.length);
    const active = applications.some((item) => ["queued", "claimed", "submitting"].includes(item.status));
    const status = failed ? "failed"
      : submitted.length >= target ? "complete"
        : active ? "running"
          : pendingOther.length ? "blocked"
            : pendingFinal.length ? "awaiting_batch_review"
              : searchingMore ? "searching_more_sources"
              : scan && applications.length < target ? "insufficient_candidates" : "blocked";
    const completedAt = status === "complete" ? submitted[target - 1].receipt.submittedAt : undefined;
    const lastApplicationUpdate = applications.length
      ? applications.map((item) => item.updatedAt).sort().at(-1) : undefined;
    const endedAt = completedAt ?? failed?.at
      ?? (["insufficient_candidates", "blocked"].includes(status)
        ? [selection?.at, scan?.at, lastApplicationUpdate].filter(Boolean).sort().at(-1) : undefined);
    const reviewReadyAt = finalConfirmations.length
      ? finalConfirmations.map((item) => item.createdAt).sort().at(-1) : undefined;
    const duration = (end, start) => end && start
      ? Math.max(0, Date.parse(end) - Date.parse(start)) : null;
    const activeWorkerMs = attempts.reduce((sum, item) => sum + Number(item.workerMetrics?.activeMs ?? 0), 0);
    return {
      campaignId, status, target, reserve: started.details.reserve, mode: started.details.mode,
      sourceCoverage: {
        primary: started.details.sources ?? [], fallbackPlanned, fallbackCovered, fallbackRemaining,
        coveredCount: (started.details.sources ?? []).length + fallbackCovered.length,
        plannedCount: (started.details.sources ?? []).length + fallbackPlanned.length,
        scans: sourceScans.map((item) => ({ at: item.at, ...item.details }))
      },
      candidatePoolSize: [...new Set([
        ...(scan?.details.selectedOpportunityIds ?? []),
        ...sourceScans.flatMap((item) => item.details.opportunityIds ?? [])
      ])].length,
      startedAt: started.at, ...(scan ? { scanCompletedAt: scan.at, scan: scan.details } : {}),
      ...(completedAt ? { completedAt } : {}),
      ...(endedAt ? { endedAt } : {}),
      elapsedMs: Math.max(0, Date.parse(endedAt ?? now()) - Date.parse(started.at)),
      timing: {
        scanMs: duration(scan?.at, started.at),
        preparationMs: duration(!active && !pendingOther.length ? reviewReadyAt : undefined, scan?.at),
        approvalWaitMs: duration(approval?.at, reviewReadyAt),
        submissionMs: duration(completedAt, approval?.at),
        workerActiveMs: activeWorkerMs,
        workerAttempts: attempts.length
      },
      counts, submitted: submitted.length,
      readyForReview: pendingFinal.length,
      reviewEntries: pendingFinal.map((item) => {
        const application = applications.find((entry) => entry.id === item.applicationId);
        const opportunity = opportunities.get(application?.opportunityId);
        return {
          applicationId: item.applicationId, previewFingerprint: item.previewFingerprint,
          company: opportunity?.company, title: opportunity?.title,
          destination: opportunity?.applyUrl ?? opportunity?.listingUrl,
          presentation: item.presentation
        };
      }),
      applications: applications.map((item) => ({
        company: opportunities.get(item.opportunityId)?.company,
        title: opportunities.get(item.opportunityId)?.title,
        destination: opportunities.get(item.opportunityId)?.applyUrl
          ?? opportunities.get(item.opportunityId)?.listingUrl,
        applicationId: item.id, opportunityId: item.opportunityId, status: item.status,
        createdAt: item.createdAt, updatedAt: item.updatedAt, submittedAt: item.receipt?.submittedAt
      }))
    };
  }

  async approveCampaign(campaignId, entries, identity) {
    const campaign = this.campaignStatus(campaignId, identity.profileId);
    const remaining = Math.max(0, campaign.target - campaign.submitted);
    if (!remaining || !Array.isArray(entries) || entries.length < 1 || entries.length > remaining) {
      throw new ClientError(400, `campaign approval must contain 1 to ${remaining} applications`);
    }
    const allowed = new Set(campaign.applications.map((item) => item.applicationId));
    if (entries.some((entry) => !allowed.has(entry.applicationId))) {
      throw new ClientError(409, "campaign approval contains an application from another campaign");
    }
    const result = await this.approvePreparedBatch(entries, identity);
    await this.store.mutate(async (state) => audit(state, identity, "campaign.batch_approved", campaignId, {
      applicationIds: entries.map((entry) => entry.applicationId)
    }));
    return { ...result, campaign: this.campaignStatus(campaignId, identity.profileId) };
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
      recordWorkflowStage(state, identity, application.id, "receipt", {
        campaignId: application.campaignId, applicationId: application.id,
        outcome: "manually_verified"
      });
      return buildApplicationLogEntry(
        application,
        opportunity,
        state.confirmations.filter((item) => item.applicationId === application.id)
      );
    });
  }

  async attachResearch(applicationId, input, identity) {
    const url = validateDirectUrl(input.url);
    const excerpt = optionalLogText(input.excerpt, "excerpt", 6000);
    if (!excerpt || input.officialSourceConfirmed !== true) {
      throw new ClientError(400, "officialSourceConfirmed=true and a nonempty excerpt are required");
    }
    const result = await this.store.mutate(async (state) => {
      const item = state.applications.find((entry) => entry.id === applicationId && entry.profileId === identity.profileId);
      if (!item) throw new ClientError(404, "application not found");
      if (item.status !== "waiting_research") throw new ClientError(409, "application is not waiting for research");
      if ((item.researchEvidence ?? []).length >= 4) throw new ClientError(409, "research budget is exhausted");
      item.researchEvidence ??= [];
      item.researchEvidence.push({ url, excerpt,
        sourceHash: createHash("sha256").update(`${url}\n${excerpt}`).digest("hex"),
        recordedAt: now() });
      item.status = "queued";
      item.queuedAt = now();
      item.updatedAt = now();
      audit(state, identity, "application.research_attached", item.id, { url });
      return item;
    });
    this.enqueue(result.id);
    return result;
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
    const application = this.store.snapshot().applications.find((item) => item.id === applicationId);
    if (!application) return;
    const profileId = application.profileId;
    const previous = this.#profileRunners.get(profileId) ?? Promise.resolve();
    const runner = previous.then(() => this.#withGlobalSlot(() => this.execute(applicationId)))
      .catch((error) => console.error("application queue error", error))
      .finally(() => {
        if (this.#profileRunners.get(profileId) === runner) this.#profileRunners.delete(profileId);
      });
    this.#profileRunners.set(profileId, runner);
  }

  async waitForIdle() {
    while (this.#profileRunners.size) await Promise.all([...this.#profileRunners.values()]);
  }

  async #withGlobalSlot(fn) {
    const limit = Math.max(1, Number(this.config.execution?.concurrency ?? 2));
    if (this.#activeExecutions >= limit) await new Promise((resolve) => this.#executionWaiters.push(resolve));
    this.#activeExecutions += 1;
    try { return await fn(); }
    finally {
      this.#activeExecutions -= 1;
      this.#executionWaiters.shift()?.();
    }
  }

  async recover() {
    const queued = await this.store.mutate(async (state) => {
      const ids = [];
      for (const item of state.applications) {
        if (item.status === "queued") {
          ids.push(item.id);
          continue;
        }
        if (item.status === "claimed" && !item.claim?.executionStartedAt) {
          const attempt = state.attempts?.find((entry) => entry.id === item.claim?.attemptId);
          if (attempt) Object.assign(attempt, {
            status: "recovered", completedAt: now(), errorCode: "pre_execution_recovered"
          });
          item.status = "queued";
          item.queuedAt = now();
          item.claim = undefined;
          item.updatedAt = now();
          ids.push(item.id);
          continue;
        }
        if (!(["claimed", "submitting"].includes(item.status))) continue;
        const attempt = state.attempts?.find((entry) => entry.id === item.claim?.attemptId);
        if (attempt) Object.assign(attempt, {
          status: "uncertain", completedAt: now(), errorCode: "submission_interrupted"
        });
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
        recordWorkflowStage(state, { actorId: "system-recovery", profileId: item.profileId },
          item.id, "recovery", { campaignId: item.campaignId, applicationId: item.id,
            attemptId: item.claim?.attemptId, outcome: "uncertain" });
      }
      return ids;
    });
    for (const id of queued) this.enqueue(id);
  }

  async execute(applicationId) {
    const executionStarted = performance.now();
    const claimed = await this.store.mutate(async (state) => {
      const application = state.applications.find((item) => item.id === applicationId);
      if (!application || application.status !== "queued") return null;
      const opportunity = state.opportunities.find((item) => item.id === application.opportunityId);
      const attemptId = randomUUID();
      const claimedAt = now();
      application.status = "claimed";
      application.claim = {
        attemptId,
        owner: `${process.pid}`,
        claimedAt,
        leaseExpiresAt: new Date(Date.now() + Number(this.config.execution?.claimLeaseMs ?? 60_000)).toISOString()
      };
      application.updatedAt = now();
      const identity = { actorId: application.requestedBy ?? "system-runner", profileId: application.profileId };
      state.attempts ??= [];
      state.attempts.push({
        id: attemptId, applicationId: application.id, profileId: application.profileId,
        status: "claimed", claimedAt, leaseExpiresAt: application.claim.leaseExpiresAt,
        queueMs: application.queuedAt ? Math.max(0, Date.parse(claimedAt) - Date.parse(application.queuedAt)) : null
      });
      audit(state, identity, "application.claimed", application.id, { adapter: this.adapter.name, attemptId });
      recordWorkflowStage(state, identity, application.id, "worker", {
        campaignId: application.campaignId, applicationId: application.id,
        attemptId, outcome: "claimed" });
      return { application, opportunity, identity, attemptId };
    });
    if (!claimed) return null;
    const { application, opportunity, identity, attemptId } = claimed;
    let verifiedReceipt;
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
      const executable = await this.store.mutate(async (state) => {
        const item = state.applications.find((entry) => entry.id === applicationId);
        if (!item || item.status !== "claimed" || item.claim?.attemptId !== attemptId) return null;
        const executionStartedAt = now();
        item.status = "submitting";
        item.claim.executionStartedAt = executionStartedAt;
        item.updatedAt = executionStartedAt;
        const attempt = state.attempts.find((entry) => entry.id === attemptId);
        if (attempt) Object.assign(attempt, { status: "submitting", executionStartedAt });
        audit(state, identity, "application.submitting", item.id, { adapter: this.adapter.name, attemptId });
        recordWorkflowStage(state, identity, item.id, "worker", {
          campaignId: item.campaignId, applicationId: item.id,
          attemptId, outcome: "started" });
        return item;
      });
      if (!executable) return null;
      application.status = executable.status;
      application.claim = executable.claim;
      verifiedReceipt = await this.adapter.submit({
        application, opportunity, profile, actor: identity.actorId,
        evidencePacket: buildEvidencePacket(application, opportunity, profile)
      });
      const submitted = await this.#persistSubmitted(applicationId, identity, attemptId, verifiedReceipt);
      this.telemetry.count("applications.submitted", 1, { mode: submitted.mode, adapter: this.adapter.name });
      this.telemetry.observe("applications.workflow_duration_ms", Date.now() - Date.parse(submitted.createdAt),
        { mode: submitted.mode });
      return submitted;
    } catch (error) {
      if (verifiedReceipt) {
        try {
          const submitted = await this.#persistSubmitted(applicationId, identity, attemptId, verifiedReceipt);
          this.telemetry.count("applications.submitted", 1, { mode: submitted.mode, adapter: this.adapter.name });
          return submitted;
        } catch {
          throw error;
        }
      }
      if (error instanceof RetryableExecutionError) {
        const retried = await this.#retryTransient(applicationId, identity, error, attemptId);
        if (retried) return retried;
        return this.#needsReview(applicationId, identity,
          new NeedsReviewError("The browser repeatedly stopped before the final action", [{
            kind: "transient_worker_failure", action: "manual_review",
            message: "The form is safe to retry, but the automatic retry limit was reached"
          }]), attemptId);
      }
      if (error instanceof NeedsInputError) return this.#needsInput(applicationId, identity, error, attemptId);
      if (error instanceof NeedsResearchError) return this.#needsResearch(applicationId, identity, error, attemptId);
      if (error instanceof NeedsReviewError) return this.#needsReview(applicationId, identity, error, attemptId);
      if (error instanceof PostingUnavailableError) return this.#postingUnavailable(applicationId, identity, error, attemptId);
      await this.store.mutate(async (state) => {
        const item = state.applications.find((entry) => entry.id === applicationId);
        item.status = "failed";
        item.error = error.message;
        item.claim = undefined;
        item.updatedAt = now();
        const attempt = state.attempts?.find((entry) => entry.id === attemptId);
        if (attempt) Object.assign(attempt, { status: "failed", completedAt: item.updatedAt, errorCode: "execution_failed" });
        audit(state, identity, "application.failed", item.id, { error: error.message });
        recordWorkflowStage(state, identity, item.id, "terminal_failure", {
          campaignId: item.campaignId, applicationId: item.id, attemptId,
          outcome: "execution_failed" });
      });
      this.telemetry.count("applications.failed", 1, { adapter: this.adapter.name, reason: "execution_failed" });
      throw error;
    } finally {
      this.telemetry.observe("applications.attempt_duration_ms", performance.now() - executionStarted,
        { adapter: this.adapter.name });
    }
  }

  async #persistSubmitted(applicationId, identity, attemptId, receipt) {
    const saved = await this.store.mutate(async (state) => {
      const item = state.applications.find((entry) => entry.id === applicationId);
      if (!item) throw new Error("application disappeared while persisting its receipt");
      item.status = "submitted";
      item.receipt = receipt;
      item.claim = undefined;
      item.error = undefined;
      item.updatedAt = now();
      const attempt = state.attempts.find((entry) => entry.id === attemptId);
      if (attempt) Object.assign(attempt, { status: "submitted", completedAt: item.updatedAt,
        workerMetrics: safeWorkerMetrics(receipt.metrics) });
      const recorded = state.audit.some((entry) => entry.action === "application.submitted"
        && entry.subjectId === item.id && entry.details?.attemptId === attemptId);
      if (!recorded) audit(state, identity, "application.submitted", item.id, { receipt, attemptId });
      if (!state.audit.some((entry) => entry.action === "workflow.stage"
        && entry.subjectId === item.id && entry.details?.stage === "final_action"
        && entry.details?.attemptId === attemptId)) {
        recordWorkflowStage(state, identity, item.id, "final_action", {
          campaignId: item.campaignId, applicationId: item.id, attemptId,
          outcome: "inferred_from_receipt"
        });
      }
      recordWorkflowStage(state, identity, item.id, "receipt", {
        campaignId: item.campaignId, applicationId: item.id, attemptId,
        outcome: receipt.simulated === true ? "simulated" : receipt.manuallyVerified === true
          ? "manually_verified" : "adapter_verified",
        durationMs: receipt.metrics?.receiptMs });
      if (Number.isFinite(receipt.metrics?.activeMs)) recordWorkflowStage(state, identity, item.id,
        "worker", { campaignId: item.campaignId, applicationId: item.id,
          attemptId, outcome: "completed", durationMs: receipt.metrics.activeMs,
          modelCalls: receipt.metrics.draftCalls, browserSteps: receipt.metrics.steps });
      if (Number.isFinite(receipt.metrics?.planFillMs)) recordWorkflowStage(state, identity, item.id,
        "preparation", { campaignId: item.campaignId, applicationId: item.id,
          attemptId, outcome: "completed", durationMs: receipt.metrics.planFillMs,
          modelCalls: receipt.metrics.draftCalls });
      return item;
    });
    recordWorkerMetrics(this.telemetry, receipt.metrics, "submitted");
    return saved;
  }

  async #retryTransient(applicationId, identity, error, attemptId) {
    const saved = await this.store.mutate(async (state) => {
      const retries = state.attempts.filter((entry) => entry.applicationId === applicationId
        && entry.status === "transient_retry").length;
      if (retries >= 2) return null;
      const item = state.applications.find((entry) => entry.id === applicationId);
      item.status = "queued";
      item.claim = undefined;
      item.queuedAt = now();
      item.updatedAt = item.queuedAt;
      const attempt = state.attempts.find((entry) => entry.id === attemptId);
      if (attempt) Object.assign(attempt, { status: "transient_retry", completedAt: item.updatedAt,
        errorCode: "worker_stopped_before_final_action" });
      audit(state, identity, "application.transient_retry", item.id, { reason: error.message, retry: retries + 1 });
      recordWorkflowStage(state, identity, item.id, "recovery", {
        campaignId: item.campaignId, applicationId: item.id, attemptId,
        outcome: "transient_retry" });
      return item;
    });
    if (saved) this.enqueue(saved.id);
    return saved;
  }

  async #needsInput(applicationId, identity, error, attemptId) {
    const result = await this.store.mutate(async (state) => {
      const item = state.applications.find((entry) => entry.id === applicationId);
      item.status = "waiting_confirmation";
      item.checkpoint = validatedCheckpoint(error.checkpoint, item.id);
      item.preparedAnswers = validatedPreparedAnswers(error.preparedAnswers, item.preparedAnswers);
      item.claim = undefined;
      item.updatedAt = now();
      const attempt = state.attempts?.find((entry) => entry.id === attemptId);
      if (attempt) Object.assign(attempt, { status: "input_required", completedAt: item.updatedAt,
        workerMetrics: safeWorkerMetrics(error.metrics) });
      for (const requirement of error.requirements) {
        const duplicate = state.confirmations.some(
          (entry) => entry.applicationId === item.id && entry.status === "pending" && entry.kind === requirement.kind
            && JSON.stringify(entry.fields ?? []) === JSON.stringify(requirement.fields ?? [])
        );
        if (!duplicate) addConfirmation(state, item, requirement, error.message);
      }
      audit(state, identity, "application.input_required", item.id, { requirements: error.requirements });
      recordWorkflowStage(state, identity, item.id, "preparation", {
        campaignId: item.campaignId, applicationId: item.id, attemptId,
        outcome: "input_required", durationMs: error.metrics?.planFillMs,
        modelCalls: error.metrics?.draftCalls });
      return item;
    });
    this.telemetry.count("applications.confirmation_required", 1,
      { reason: error.requirements[0]?.kind ?? "missing_input" });
    recordWorkerMetrics(this.telemetry, error.metrics, "input_required");
    return result;
  }

  async #postingUnavailable(applicationId, identity, error, attemptId) {
    const result = await this.store.mutate((state) => {
      const item = state.applications.find((entry) => entry.id === applicationId);
      item.status = "skipped";
      item.claim = undefined;
      item.updatedAt = now();
      item.decision.reasons.push("employer posting unavailable");
      const attempt = state.attempts?.find((entry) => entry.id === attemptId);
      if (attempt) Object.assign(attempt, { status: "posting_unavailable", completedAt: item.updatedAt,
        errorCode: error.reasonCode ?? "posting_unavailable", workerMetrics: safeWorkerMetrics(error.metrics) });
      audit(state, identity, "application.posting_unavailable", item.id,
        { reasonCode: error.reasonCode ?? "posting_unavailable" });
      recordWorkflowStage(state, identity, item.id, "terminal_failure", {
        campaignId: item.campaignId, applicationId: item.id, attemptId,
        outcome: "posting_unavailable" });
      return item;
    });
    this.telemetry.count("applications.posting_unavailable", 1,
      { reason: error.reasonCode ?? "posting_unavailable" });
    recordWorkerMetrics(this.telemetry, error.metrics, "posting_unavailable");
    return result;
  }

  async #needsReview(applicationId, identity, error, attemptId) {
    const result = await this.store.mutate(async (state) => {
      const item = state.applications.find((entry) => entry.id === applicationId);
      item.status = "waiting_confirmation";
      item.checkpoint = validatedCheckpoint(error.checkpoint, item.id);
      item.preparedAnswers = validatedPreparedAnswers(error.preparedAnswers, item.preparedAnswers);
      item.claim = undefined;
      item.updatedAt = now();
      const attempt = state.attempts?.find((entry) => entry.id === attemptId);
      if (attempt) Object.assign(attempt, { status: "review_required", completedAt: item.updatedAt,
        workerMetrics: safeWorkerMetrics(error.metrics) });
      for (const requirement of error.requirements.length ? error.requirements : [{}]) {
        addConfirmation(state, item, { ...requirement, action: "manual_review" }, error.message);
      }
      audit(state, identity, "application.review_required", item.id, { requirements: error.requirements });
      recordWorkflowStage(state, identity, item.id, "recovery", {
        campaignId: item.campaignId, applicationId: item.id, attemptId,
        outcome: "review_required", durationMs: error.metrics?.activeMs });
      return item;
    });
    this.telemetry.count("applications.manual_review", 1,
      { reason: error.requirements[0]?.kind ?? "review_required" });
    recordWorkerMetrics(this.telemetry, error.metrics, "review_required");
    return result;
  }

  async #needsResearch(applicationId, identity, error, attemptId) {
    const saved = await this.store.mutate(async (state) => {
      const item = state.applications.find((entry) => entry.id === applicationId);
      item.status = "waiting_research";
      item.claim = undefined;
      item.checkpoint = validatedCheckpoint(error.checkpoint, item.id);
      item.preparedAnswers = validatedPreparedAnswers(error.preparedAnswers, item.preparedAnswers);
      item.researchQuestions = error.questions.slice(0, 8).map((question) => ({
        fieldId: String(question.fieldId ?? "").slice(0, 160),
        question: String(question.question ?? "").slice(0, 1000)
      }));
      item.updatedAt = now();
      const attempt = state.attempts?.find((entry) => entry.id === attemptId);
      if (attempt) Object.assign(attempt, { status: "research_required", completedAt: item.updatedAt,
        workerMetrics: safeWorkerMetrics(error.metrics) });
      audit(state, identity, "application.research_required", item.id,
        { questionCount: item.researchQuestions.length });
      recordWorkflowStage(state, identity, item.id, "preparation", {
        campaignId: item.campaignId, applicationId: item.id, attemptId,
        outcome: "research_required", durationMs: error.metrics?.activeMs });
      return item;
    });
    recordWorkerMetrics(this.telemetry, error.metrics, "research_required");
    return saved;
  }
}

function recordWorkerMetrics(telemetry, metrics, outcome) {
  if (!metrics || typeof metrics !== "object") return;
  for (const key of ["loadMs", "planFillMs", "draftMs", "transitionMs", "receiptMs", "activeMs"]) {
    if (Number.isFinite(metrics[key]) && metrics[key] >= 0) {
      telemetry.observe(`applications.worker.${key}`, metrics[key], { outcome });
    }
  }
  for (const key of ["steps", "fields", "draftCalls"]) {
    if (Number.isInteger(metrics[key]) && metrics[key] >= 0) {
      telemetry.count(`applications.worker.${key}`, metrics[key], { outcome });
    }
  }
}

function safeWorkerMetrics(metrics) {
  if (!metrics || typeof metrics !== "object") return undefined;
  const keys = ["loadMs", "planFillMs", "draftMs", "transitionMs", "receiptMs", "activeMs",
    "steps", "fields", "draftCalls"];
  const safe = Object.fromEntries(keys.filter((key) => Number.isFinite(metrics[key]) && metrics[key] >= 0)
    .map((key) => [key, metrics[key]]));
  return Object.keys(safe).length ? safe : undefined;
}

function validatedCheckpoint(checkpoint, applicationId) {
  if (!checkpoint) return undefined;
  if (checkpoint.version !== 1 || checkpoint.applicationId !== applicationId
    || !Array.isArray(checkpoint.steps) || !Array.isArray(checkpoint.fields)
    || checkpoint.steps.length > 16 || checkpoint.fields.length > 200
    || JSON.stringify(checkpoint).length > 64_000) {
    return undefined;
  }
  return checkpoint;
}

function validatedPreparedAnswers(value, previous = {}) {
  if (value === undefined) return previous;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length > 20
    || Object.entries(value).some(([key, text]) => key.length > 160
      || typeof text !== "string" || text.length > 5000 || CREDENTIAL_INPUT_KEY.test(key))) return previous;
  return value;
}

function buildEvidencePacket(application, opportunity, profile) {
  const packet = {
    version: 1,
    company: String(opportunity.company ?? "").slice(0, 200),
    title: String(opportunity.title ?? "").slice(0, 200),
    listing: String(opportunity.description ?? "").slice(0, 8000),
    listingUrl: opportunity.listingUrl ?? opportunity.applyUrl,
    research: (application.researchEvidence ?? []).slice(0, 4).map((item) => ({
      url: item.url, excerpt: item.excerpt, sourceHash: item.sourceHash
    })),
    applicant: {
      skills: (profile?.skills ?? []).slice(0, 30),
      links: Object.fromEntries(["linkedin", "github", "portfolio"]
        .filter((key) => /^https:\/\//i.test(profile?.links?.[key] ?? ""))
        .map((key) => [key, String(profile.links[key]).slice(0, 500)]))
    }
  };
  return packet;
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
  recordWorkflowStage(state, { actorId: "system-confirmation", profileId: application.profileId },
    application.id, "owner_hold", { campaignId: application.campaignId,
      applicationId: application.id, outcome: confirmation.kind });
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
  const parts = [];
  for (let offset = 0; offset < text.length; offset += 3000) {
    parts.push({ type: "text", text: text.slice(offset, offset + 3000) });
  }
  return { blocks: [...(parts.length ? parts : [{ type: "text", text: "" }]), { type: "buttons", buttons }] };
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
  return lines.join("\n");
}

function audit(state, identity, action, subjectId, details) {
  state.audit.push({
    id: randomUUID(), at: now(), actorId: identity.actorId, profileId: identity.profileId,
    action, subjectId, details
  });
}

function campaignStart(state, campaignId, profileId) {
  return state.audit.find((item) => item.profileId === profileId
    && item.action === "campaign.started" && item.subjectId === campaignId);
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
    campaignId: application.campaignId,
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

function verifiedDiscoveryIsFresh(opportunity, mode) {
  const verification = opportunity?.discoveryVerification;
  if (!verification || opportunity.userRequested === true || opportunity.direct === true
    || opportunity.mode !== mode || verification.sourceId !== opportunity.source
    || opportunity.applicationDestinationVerified !== true
    || opportunity.applicationDestinationPending === true
    || !/^https:\/\//i.test(opportunity.applyUrl ?? "")) return false;
  const verifiedAt = Date.parse(verification.verifiedAt);
  if (!Number.isFinite(verifiedAt) || Date.now() - verifiedAt > 10 * 60_000
    || verifiedAt > Date.now() + 60_000) return false;
  if (opportunity.validThrough && (!Number.isFinite(Date.parse(opportunity.validThrough))
    || Date.parse(opportunity.validThrough) <= Date.now())) return false;
  return true;
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
