import { randomUUID } from "node:crypto";
import { officialAtsUrlFromAggregator, resolveEmployerApplicationUrl } from "./application-destination.js";
import { remoteok } from "./sources/remoteok.js";
import { arbeitnow } from "./sources/arbeitnow.js";
import { jobicy } from "./sources/jobicy.js";
import { himalayas } from "./sources/himalayas.js";
import { greenhouse } from "./sources/greenhouse.js";
import { ashby } from "./sources/ashby.js";
import { lever } from "./sources/lever.js";
import { adzuna, ADZUNA_FILTERS, ADZUNA_FILTER_FORMATS, ADZUNA_FILTER_OPTIONS, adzunaCountries } from "./sources/adzuna.js";
import { jobspipe, JOBSPIPE_ARRAY_FILTERS, JOBSPIPE_FILTERS, JOBSPIPE_FILTER_FORMATS, JOBSPIPE_FILTER_OPTIONS,
  jobspipeSettings } from "./sources/jobspipe.js";
import { credentialFingerprint, isKeyedSource, missingCredentialMessage, redactSecrets,
  sourceCredentials } from "./source-credentials.js";
import { PACED_WINDOWS, quotaError, quotaLimits, SourceQuota } from "./source-quota.js";
import { scoreOpportunity } from "./scoring.js";
import { telemetry } from "../telemetry.js";
import { normalizeOpportunity } from "./normalization.js";
import { runIdempotent } from "../idempotency.js";
import { isHandledRole, irrelevantReviewIndex, knownRoleIndex, roleKeys,
  unchangedIrrelevantRole } from "./handled-roles.js";
import { leadRetryDecision, matchingStoredLead } from "./candidate-state.js";
import { selectSemanticCandidateIndexes } from "./semantic-candidate-selection.js";
import { selectFitReviewCandidates } from "./fit-review-selection.js";
import { postingFingerprint, reviewedEligibility } from "./fit-assessment.js";
import { legacyDiscoveryTitleRelevant } from "./title-preferences.js";
import { fetchVerifiedOfficialAtsRole, officialAtsDestination, officialAtsIdentityFromUrl } from "./official-ats.js";
import { sourceConfigWithLearnedBoards, isLearnedBoardRequest,
  learnedBoardRequestsInLastDay, MAX_LEARNED_BOARD_REQUESTS_PER_DAY } from "./learned-boards.js";

const SOURCES = new Map([remoteok, arbeitnow, jobicy, himalayas, greenhouse, ashby, lever, adzuna, jobspipe]
  .map((source) => [source.id, source]));
const atsBoardKey = (parsed) => parsed ? `${parsed.source}:${parsed.board}` : null;
const AGGREGATOR_SOURCES = new Set(["himalayas", "jobicy"]);
const STAGED_ATS_SOURCES = new Set(["ashby", "greenhouse", "lever"]);
const discoverySourceOf = (role) => role.discoverySource ?? role.source;
const exactRoleText = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

export class DiscoveryService {
  // `sourceEnv` is the only place keyed-source credentials are read from.
  constructor({ applicationService, profiles, config, fetchImpl = fetch, enricher = null,
    officialRequestPaceMs = 1500, sourceEnv = process.env, sourceQuota }) {
    this.applicationService = applicationService;
    this.profiles = profiles;
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.enricher = enricher;
    this.officialRequestPaceMs = Number.isFinite(officialRequestPaceMs)
      ? Math.max(0, officialRequestPaceMs) : 1500;
    this.sourceEnv = sourceEnv;
    this.sourceQuota = sourceQuota ?? new SourceQuota(applicationService?.store);
  }

  // An adapter with its own option-derived allowance (for example a plan's
  // credits) exports `quotaLimits`; others use the shared defaults.
  #quotaLimits(sourceId) {
    const options = this.config.discovery?.sourceOptions?.[sourceId];
    return SOURCES.get(sourceId)?.quotaLimits?.(options ?? {}) ?? quotaLimits(sourceId, options?.quota);
  }

  #atsBackoffActive(profileId, key) {
    const event = this.applicationService.store.snapshot().audit.filter((item) =>
      item.profileId === profileId && item.action === "discovery.ats_backoff"
      && item.subjectId === key).at(-1);
    return Boolean(event && Date.parse(event.details?.nextAt) > Date.now());
  }

  async #recordAtsBackoff(identity, key, reason) {
    if (this.#atsBackoffActive(identity.profileId, key)) return;
    await this.applicationService.store.mutate((state) => state.audit.push({ id: randomUUID(),
      at: new Date().toISOString(), actorId: identity.actorId, profileId: identity.profileId,
      action: "discovery.ats_backoff", subjectId: key,
      details: { reason, nextAt: new Date(Date.now() + 6 * 60 * 60_000).toISOString() } }));
  }

  #aggregatorBackoffActive(profileId, sourceId) {
    const event = this.applicationService.store.snapshot().audit.filter((item) =>
      item.profileId === profileId && item.action === "discovery.aggregator_backoff"
      && item.subjectId === sourceId).at(-1);
    return Boolean(event && Date.parse(event.details?.nextAt) > Date.now());
  }

  async #recordAggregatorBackoff(identity, sourceId, reason) {
    if (this.#aggregatorBackoffActive(identity.profileId, sourceId)) return;
    await this.applicationService.store.mutate((state) => state.audit.push({ id: randomUUID(),
      at: new Date().toISOString(), actorId: identity.actorId, profileId: identity.profileId,
      action: "discovery.aggregator_backoff", subjectId: sourceId,
      details: { reason, nextAt: new Date(Date.now() + 6 * 60 * 60_000).toISOString() } }));
  }

  // Returns `{ role }` with the official ATS role (carrying the aggregator's
  // expiry and evidence) or `{ failure }` with an uncertainty code.
  async #verifiedOfficialCandidate(scored, identity, fetchImpl) {
    const parsed = officialAtsIdentityFromUrl(scored.officialAtsCandidateUrl);
    const key = atsBoardKey(parsed);
    if (!parsed) return { failure: "official_ats_unrecognized" };
    if (this.#atsBackoffActive(identity.profileId, key)) return { failure: "official_ats_backoff" };
    let failure = "verification_failed";
    const verified = await fetchVerifiedOfficialAtsRole(scored.officialAtsCandidateUrl,
      this.config.discovery?.sourceOptions ?? {}, fetchImpl, (reason) => { failure = reason; });
    if (["http_403", "http_429"].includes(failure)) await this.#recordAtsBackoff(identity, key, failure);
    if (!verified) return { failure: `official_ats_${failure}` };
    return { role: { ...verified,
      ...(scored.validThrough ? { validThrough: scored.validThrough } : {}),
      ...(scored.postingEvidence ? { postingEvidence: scored.postingEvidence } : {}),
      provenance: { discoveredVia: scored.source, discoveryExternalId: scored.externalId,
        discoveryListingUrl: scored.listingUrl, officialAtsVerified: true } } };
  }

  async describeSources(identity, mode) {
    const profile = await this.profiles.get(identity.profileId);
    const selectedMode = mode ?? profile?.defaultMode ?? this.config.defaultMode;
    const settings = this.config.modes[selectedMode];
    if (!settings) throw Object.assign(new Error(`unknown mode: ${selectedMode}`), { status: 400 });
    const preference = selectedMode === "freelance"
      ? profile?.preferences?.freelance : profile?.preferences?.fullTime;
    const snapshot = this.applicationService.store.snapshot();
    const backedOff = activeAtsBoardBackoffs(snapshot, identity.profileId);
    const atBudget = (key) => learnedBoardRequestsInLastDay(snapshot.audit,
      identity.profileId, key) >= MAX_LEARNED_BOARD_REQUESTS_PER_DAY;
    const enabled = preference?.automatedDiscoverySources ?? settings.sources ?? [];
    const sourceCycles = completedSourceCycles(snapshot.audit, identity.profileId, enabled);
    const capabilities = {
      lever: { kind: "official_feed", filters: { board: "configured", location: "provider", team: "provider",
        department: "provider", commitment: "provider", level: "provider" } },
      himalayas: { kind: "public_board", filters: { q: "provider", country: "provider",
        worldwide: "provider", exclude_worldwide: "provider", seniority: "provider",
        employment_type: "provider", company: "provider", timezone: "provider", sort: "provider" } },
      greenhouse: { kind: "official_feed", filters: { board: "configured", title: "local", location: "local" } },
      ashby: { kind: "official_feed", filters: { board: "configured", title: "local", location: "local" } },
      adzuna: { kind: "keyed_api", filters: Object.fromEntries(ADZUNA_FILTERS.map((key) => [key, "provider"])),
        filterFormats: ADZUNA_FILTER_FORMATS, maxResultsPerPage: 50, attribution: "Jobs by Adzuna" },
      jobspipe: { kind: "keyed_api", filters: Object.fromEntries(JOBSPIPE_FILTERS.map((key) => [key, "provider"])),
        filterFormats: JOBSPIPE_FILTER_FORMATS, arrayFilters: JOBSPIPE_ARRAY_FILTERS,
        maxResultsPerPage: jobspipeSettings(this.config.discovery?.sourceOptions?.jobspipe).pageSize,
        applicationFlow: "verify_official_ats_before_prepare" }
    };
    const sourceOptions = this.config.discovery?.sourceOptions ?? {};
    return { mode: selectedMode, sources: await Promise.all(enabled.filter((id) => SOURCES.has(id)).map(async (id) => ({
      id, version: 1, ...(capabilities[id] ?? { kind: "public_board", filters: {} }),
      filterOptions: id === "himalayas" ? {
        sort: ["relevant", "recent", "salaryAsc", "salaryDesc", "nameAToZ", "nameZToA", "jobs"],
        seniority: ["Entry-level", "Mid-level", "Senior", "Manager", "Director", "Executive"],
        employment_type: ["Full Time", "Part Time", "Contractor", "Temporary", "Intern", "Volunteer", "Other"]
      } : id === "adzuna" ? { ...ADZUNA_FILTER_OPTIONS, country: adzunaCountries(sourceOptions.adzuna) }
        : id === "jobspipe" ? JOBSPIPE_FILTER_OPTIONS : sourceOptions[id]?.filterValues ?? {},
      configuredBoards: (() => {
        const options = sourceConfigWithLearnedBoards(snapshot, identity.profileId, id,
          sourceOptions[id] ?? {},
          { cycle: sourceCycles[id] ?? 0,
            includeLearned: this.config.discovery?.broadenedSources?.[id] === true,
            isBackedOff: (key) => backedOff.has(key), isAtRequestBudget: atBudget });
        return (options.boards ?? options.sites ?? []).map((item) => item.slug ?? item.token);
      })(),
      ...(["himalayas", "jobicy", "remoteok", "arbeitnow", "adzuna"].includes(id)
        ? { applicationFlow: "resolve_employer_url_before_prepare" } : {}),
      ...(isKeyedSource(id) ? { configured: Boolean(sourceCredentials(id, this.sourceEnv)),
        quota: await this.sourceQuota.usage(id, this.#quotaLimits(id)) } : {}),
      maxQueries: 8, maxResultsPerQuery: 200
    }))) };
  }

  async query(input, identity) {
    const descriptor = await this.describeSources(identity, input.mode);
    const source = descriptor.sources.find((item) => item.id === input.source);
    if (!source) throw Object.assign(new Error("source is not enabled for this profile and mode"), { status: 400 });
    if (!Array.isArray(input.queries) || input.queries.length < 1 || input.queries.length > 8
      || typeof input.scanCycleId !== "string" || input.scanCycleId.length < 1 || input.scanCycleId.length > 100
      || typeof input.idempotencyKey !== "string" || input.idempotencyKey.length < 8
      || input.idempotencyKey.length > 200) {
      throw Object.assign(new Error("a bounded query plan, scanCycleId, and idempotencyKey are required"), { status: 400 });
    }
    const queries = input.queries.map((query) => {
      if (!query || typeof query !== "object" || Array.isArray(query)
        || !Number.isInteger(query.limit ?? 50) || (query.limit ?? 50) < 1 || (query.limit ?? 50) > 200
        || !query.filters || typeof query.filters !== "object" || Array.isArray(query.filters)) {
        throw Object.assign(new Error("each query needs filters and a limit from 1 to 200"), { status: 400 });
      }
      for (const [key, value] of Object.entries(query.filters)) {
        if (!Object.hasOwn(source.filters, key)
          || (key === "board" && !source.configuredBoards.includes(value))
          || !(typeof value === "string" || Array.isArray(value) && value.length <= 10
            && value.every((item) => typeof item === "string"))
          || (source.id !== "lever" && Array.isArray(value) && !source.arrayFilters?.includes(key))
          || (["worldwide", "exclude_worldwide"].includes(key) && !["true", "false"].includes(value))
          || (source.filterOptions?.[key] && !(Array.isArray(value) ? value : [value])
            .every((item) => source.filterOptions[key].includes(item)))
          || (source.filterFormats?.[key] && !(Array.isArray(value) ? value : [value])
            .every((item) => new RegExp(source.filterFormats[key]).test(item)))
          || JSON.stringify(value).length > 500) {
          throw Object.assign(new Error(`unsupported filter: ${key}`), { status: 400 });
        }
      }
      return { filters: query.filters, limit: query.limit ?? 50 };
    });
    const key = `${input.scanCycleId}:${input.idempotencyKey}`;
    return runIdempotent({ store: this.applicationService.store, profileId: identity.profileId,
      action: "discovery.query", key, input: { source: source.id, mode: descriptor.mode,
        reviewOnly: input.reviewOnly === true, queries },
      execute: () => this.scan({ mode: descriptor.mode, sources: [source.id], queryPlan: queries,
        limitPerSource: Math.max(...queries.map((query) => query.limit)),
        reviewOnly: input.reviewOnly === true }, identity) });
  }

  // The agent reviews public listing evidence before any expensive destination
  // lookup or application. The server still owns dedup, verification and the
  // final submission policy. A fit verdict never creates owner authority.
  async considerCandidate(input, identity) {
    const candidate = input?.candidate;
    const fit = input?.fit;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
      || !fit || typeof fit !== "object" || Array.isArray(fit)
      || !["relevant", "irrelevant", "uncertain"].includes(fit.decision)
      || typeof fit.reason !== "string" || !fit.reason.trim() || fit.reason.length > 1000
      || typeof candidate.title !== "string" || !candidate.title.trim() || candidate.title.length > 300
      || typeof candidate.company !== "string" || !candidate.company.trim() || candidate.company.length > 300
      || typeof candidate.source !== "string" || !/^[a-z][a-z0-9_-]{0,79}$/.test(candidate.source)
      || typeof candidate.applyUrl !== "string" || candidate.applyUrl.length > 2000
      || typeof candidate.description !== "string" || candidate.description.length > 100_000) {
      throw Object.assign(new Error("candidate and a bounded fit verdict are required"), { status: 400 });
    }
    let url;
    try { url = new URL(candidate.applyUrl); } catch { /* invalid URL */ }
    if (!url || url.protocol !== "https:" || url.username || url.password) {
      throw Object.assign(new Error("candidate needs a public HTTPS application URL"), { status: 400 });
    }
    const profile = await this.profiles.get(identity.profileId);
    const mode = input.mode ?? profile?.defaultMode ?? this.config.defaultMode;
    if (!this.config.modes[mode]) {
      throw Object.assign(new Error("unknown mode"), { status: 400 });
    }
    const snapshot = this.applicationService.store.snapshot();
    const known = knownRoleIndex(snapshot, identity.profileId, { includeIrrelevant: false });
    if (isHandledRole(candidate, known)) return { status: "already_handled" };
    if (fit.decision === "uncertain") return { status: "needs_fit_review" };
    // Browser listings are evidence, not policy or submission authority.
    const listing = Object.fromEntries(["source", "externalId", "title", "company", "description",
      "applyUrl", "listingUrl", "location", "remote", "workArrangement", "employmentType",
      "postedAt", "tags", "compensation", "uncertainties"].filter((key) =>
      Object.hasOwn(candidate, key)).map((key) => [key, candidate[key]]));
    const base = normalizeOpportunity({ ...listing, mode,
      applicationDestinationPending: true, applicationDestinationVerified: false },
    { source: candidate.source });
    if (unchangedIrrelevantRole(base, irrelevantReviewIndex(snapshot, identity.profileId))) {
      return { status: "already_handled" };
    }
    const assessment = (role) => ({ decision: fit.decision, reason: fit.reason.trim(),
      fingerprint: postingFingerprint(role), reviewedAt: new Date().toISOString() });
    if (fit.decision === "irrelevant") {
      const opportunity = await this.applicationService.addOpportunity({ ...base,
        fitAssessment: assessment(base) }, identity, { reviewedDiscovery: true });
      return { status: "skipped", opportunityId: opportunity.id };
    }

    let officialUrl = candidate.applyUrl;
    if (!officialAtsIdentityFromUrl(officialUrl) && AGGREGATOR_SOURCES.has(candidate.source)) {
      const resolved = await officialAtsUrlFromAggregator(base, this.fetchImpl);
      officialUrl = resolved.url;
    } else if (!officialAtsIdentityFromUrl(officialUrl)
      && ["arbeitnow", "remoteok"].includes(candidate.source)) {
      officialUrl = (await resolveEmployerApplicationUrl(base, this.fetchImpl)).applyUrl;
    }
    if (!officialAtsIdentityFromUrl(officialUrl)) {
      const opportunity = await this.applicationService.addOpportunity({ ...base,
        fitAssessment: assessment(base) }, identity, { reviewedDiscovery: true });
      return { status: "destination_pending", opportunityId: opportunity.id };
    }
    let failure = "verification_failed";
    const verified = await fetchVerifiedOfficialAtsRole(officialUrl,
      this.config.discovery?.sourceOptions ?? {}, this.fetchImpl,
      (reason) => { failure = reason; });
    if (!verified) return { status: "destination_unverified", reason: failure };
    const fresh = normalizeOpportunity({ ...verified, mode,
      discoverySource: candidate.source,
      provenance: { discoveredVia: candidate.source,
        discoveryListingUrl: candidate.listingUrl ?? candidate.applyUrl,
        officialAtsVerified: true } }, { source: verified.source });
    const reviewedDescription = candidate.description.trim().replace(/\s+/g, " ");
    const officialDescription = fresh.description.trim().replace(/\s+/g, " ");
    if (exactRoleText(fresh.title) !== exactRoleText(candidate.title)
      || exactRoleText(fresh.company) !== exactRoleText(candidate.company)
      || !reviewedDescription || !officialDescription.startsWith(reviewedDescription)) {
      return { status: "review_official_posting", candidate: {
        source: fresh.source, externalId: fresh.externalId, title: fresh.title,
        company: fresh.company, description: fresh.description.slice(0, 8000),
        location: fresh.location, remote: fresh.remote, applyUrl: fresh.applyUrl,
        listingUrl: fresh.listingUrl } };
    }
    const deterministicMismatch = reviewedEligibility(fresh, profile, mode);
    if (deterministicMismatch.length) {
      return { status: "deterministic_filter", reasons: deterministicMismatch };
    }
    const score = scoreOpportunity(fresh, profile, mode,
      { version: String(this.config.discovery?.scorerVersion ?? "2") });
    const opportunity = await this.applicationService.addOpportunity({ ...fresh, ...score,
      fitAssessment: assessment(fresh) }, identity,
    { serverVerifiedDiscovery: true, reviewedDiscovery: true });
    if (input.apply === false) return { status: "ready", opportunityId: opportunity.id };
    try {
      const application = await this.applicationService.requestApplication(opportunity.id, {}, identity);
      return { status: application.status, opportunityId: opportunity.id,
        applicationId: application.id };
    } catch (error) {
      if (error.status !== 409) throw error;
      const application = this.applicationService.list("applications", identity.profileId)
        .find((item) => item.opportunityId === opportunity.id);
      return { status: application?.status ?? "already_handled", opportunityId: opportunity.id,
        ...(application ? { applicationId: application.id } : {}) };
    }
  }

  // Browser sources can remove known roles before sending any listing text to
  // the model. This operation is local and makes no employer-site requests.
  async filterCandidates(input, identity) {
    if (!Array.isArray(input?.items) || input.items.length > 200) {
      throw Object.assign(new Error("items must contain at most 200 candidates"), { status: 400 });
    }
    const snapshot = this.applicationService.store.snapshot();
    const known = knownRoleIndex(snapshot, identity.profileId, { includeIrrelevant: false });
    const irrelevant = irrelevantReviewIndex(snapshot, identity.profileId);
    const profile = await this.profiles.get(identity.profileId);
    const mode = input.mode ?? profile?.defaultMode ?? this.config.defaultMode;
    if (!this.config.modes[mode]) {
      throw Object.assign(new Error("unknown mode"), { status: 400 });
    }
    const seen = new Set();
    const items = [];
    let handledFiltered = 0;
    let duplicatesFiltered = 0;
    let preferenceFiltered = 0;
    for (const item of input.items) {
      if (!item || typeof item !== "object" || Array.isArray(item)
        || typeof item.title !== "string" || !item.title.trim()
        || typeof item.company !== "string" || !item.company.trim()
        || typeof item.applyUrl !== "string") {
        throw Object.assign(new Error("every candidate needs title, company, and applyUrl"),
          { status: 400 });
      }
      let url;
      try { url = new URL(item.applyUrl); } catch { /* invalid URL */ }
      if (!url || url.protocol !== "https:" || url.username || url.password) {
        throw Object.assign(new Error("every candidate needs a public HTTPS URL"), { status: 400 });
      }
      const keys = roleKeys(item);
      if ([...keys].some((key) => known.has(key))) { handledFiltered += 1; continue; }
      const normalized = normalizeOpportunity(item, { source: item.source ?? "browser" });
      if (unchangedIrrelevantRole(normalized, irrelevant)) {
        handledFiltered += 1; continue;
      }
      if ([...keys].some((key) => seen.has(key))) { duplicatesFiltered += 1; continue; }
      if (reviewedEligibility(item, profile, mode).length) { preferenceFiltered += 1; continue; }
      for (const key of keys) seen.add(key);
      items.push(item);
    }
    return { items, handledFiltered, duplicatesFiltered, preferenceFiltered };
  }

  async scan(input, identity) {
    const scanStarted = performance.now();
    const profile = await this.profiles.get(identity.profileId);
    const mode = input.mode ?? profile?.defaultMode ?? this.config.defaultMode;
    const modeConfig = this.config.modes[mode];
    if (!modeConfig) throw Object.assign(new Error(`unknown mode: ${mode}`), { status: 400 });
    const profileStatus = await this.profiles.status(identity.profileId, mode, this.config.defaultMode);
    if (!profileStatus.readyToSearch) {
      throw Object.assign(new Error(`profile is missing search fields: ${profileStatus.missingForSearch.join(", ")}`), { status: 409 });
    }

    const modePreferences = mode === "freelance"
      ? profile?.preferences?.freelance ?? {}
      : profile?.preferences?.fullTime ?? {};
    const requestedSources = input.sources
      ?? modePreferences.automatedDiscoverySources
      ?? modeConfig.sources
      ?? [];
    if (!Array.isArray(requestedSources) || requestedSources.some((id) => typeof id !== "string")) {
      throw Object.assign(new Error("sources must be an array of source IDs"), { status: 400 });
    }
    const requestedLimit = Number(input.limitPerSource ?? this.config.discovery?.limitPerSource ?? 50);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 200) {
      throw Object.assign(new Error("limitPerSource must be an integer from 1 to 200"), { status: 400 });
    }
    const selected = requestedSources.map((id) => {
      const source = SOURCES.get(id);
      if (!source) throw Object.assign(new Error(`unknown discovery source: ${id}`), { status: 400 });
      return source;
    });
    const sourceYield = new Map(selected.map(({ id }) => [id, {
      sourceId: id, found: 0, qualifying: 0, excluded: 0,
      handledFiltered: 0, destinationPending: 0, selected: 0, scored: 0,
      exclusionCounts: { hardExclusion: 0, belowScore: 0,
        opportunisticRequirements: 0, fitReview: 0 }
    }]));
    const handledBySource = new Map();
    const internalErrors = [];
    const providerStats = new Map();
    const sourceDurations = new Map();
    const snapshot = this.applicationService.store.snapshot();
    const backedOff = activeAtsBoardBackoffs(snapshot, identity.profileId);
    const sourceCycles = input.sourceCycles ?? completedSourceCycles(snapshot.audit,
      identity.profileId, selected.map((source) => source.id));
    const sourceConfigs = new Map(selected.map((source) => [source.id,
      sourceConfigWithLearnedBoards(snapshot, identity.profileId, source.id,
        this.config.discovery?.sourceOptions?.[source.id] ?? {},
        { cycle: sourceCycles[source.id] ?? 0,
          includeLearned: this.config.discovery?.broadenedSources?.[source.id] === true,
          isBackedOff: (key) => backedOff.has(key),
          isAtRequestBudget: (key) => learnedBoardRequestsInLastDay(snapshot.audit,
            identity.profileId, key) >= MAX_LEARNED_BOARD_REQUESTS_PER_DAY })]));
    const learnedBoardKeys = new Set([...sourceConfigs].flatMap(([sourceId, options]) =>
      (options.boards ?? options.sites ?? []).filter((board) => board.seedProvenance)
        .map((board) => `${sourceId}:${String(board.slug ?? board.token).toLowerCase()}`)));
    const learnedBoards = new Map([...sourceConfigs].flatMap(([sourceId, options]) =>
      (options.boards ?? options.sites ?? []).filter((board) => board.seedProvenance)
        .map((board) => [`${sourceId}:${String(board.slug ?? board.token).toLowerCase()}`,
          { sourceId, board: String(board.slug ?? board.token),
            seedProvenance: board.seedProvenance, seedVerifiedAt: board.seedVerifiedAt }])));
    const learnedBoardRequests = new Map();
    const handledKeys = knownRoleIndex(snapshot, identity.profileId,
      { includeIrrelevant: input.reviewOnly !== true });
    const irrelevant = input.reviewOnly === true
      ? irrelevantReviewIndex(snapshot, identity.profileId) : new Map();
    const titlesByOpportunity = new Map(snapshot.opportunities
      .filter((item) => item.profileId === identity.profileId)
      .map((item) => [item.id, item.title]));
    const searchTitles = snapshot.applications
      .filter((item) => item.profileId === identity.profileId && item.status === "submitted"
        && item.receipt?.submittedAt && item.receipt?.simulated !== true)
      .map((item) => titlesByOpportunity.get(item.opportunityId))
      .filter((title) => typeof title === "string" && /\b(engineer|developer|scientist|architect)\b/i.test(title));
    const handledMatches = new Set();
    const isHandled = (role) => {
      // Review-only ATS queries must skip an unchanged reviewed posting before
      // the adapter result cap. Identity alone cannot prove it is unchanged.
      const unchanged = input.reviewOnly === true && typeof role.description === "string"
        && unchangedIrrelevantRole(normalizeOpportunity(role, { source: role.source }), irrelevant);
      if (!unchanged && !isHandledRole(role, handledKeys)) return false;
      handledMatches.add([...roleKeys(role)][0] ?? role.applyUrl ?? role.listingUrl);
      const sourceId = role.source;
      if (sourceYield.has(sourceId)) {
        const perSource = handledBySource.get(sourceId) ?? new Set();
        perSource.add([...roleKeys(role)][0] ?? role.applyUrl ?? role.listingUrl);
        handledBySource.set(sourceId, perSource);
      }
      return true;
    };
    const fetchStarted = performance.now();
    let requestCount = 0;
    const maxRequestsPerSource = input.maxRequestsPerSource ?? 50;
    const maxRequests = input.maxRequests ?? Math.max(100, selected.length * maxRequestsPerSource);
    if (!Number.isInteger(maxRequestsPerSource) || maxRequestsPerSource < 1 || maxRequestsPerSource > 50
      || !Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 350) {
      throw Object.assign(new Error("discovery request budgets are invalid"), { status: 400 });
    }
    const requestsBySource = new Map();
    const credentials = new Map(selected.filter(({ id }) => isKeyedSource(id))
      .map(({ id }) => [id, sourceCredentials(id, this.sourceEnv)]));
    for (const [sourceId, value] of credentials) {
      if (!value) internalErrors.push({ source: sourceId, code: "source_not_configured",
        error: missingCredentialMessage(sourceId) });
      else await this.sourceQuota.releaseStaleKeyHold(sourceId, credentialFingerprint(value));
    }
    // Keyed providers draw on the durable ledger before any request leaves the
    // server; the in-memory cache key may hold credentials and is never logged.
    // A full per-second window is waited out rather than refused.
    const keyedFetch = async (url, options, sourceId) => {
      let reservation;
      for (let attempt = 0; ; attempt += 1) {
        reservation = await this.sourceQuota.reserve(sourceId, this.#quotaLimits(sourceId));
        const wait = !reservation.reserved && PACED_WINDOWS.includes(reservation.window)
          ? Date.parse(reservation.resetAt) - this.sourceQuota.now() : -1;
        if (reservation.reserved || wait < 0 || wait > 2_000 || attempt >= 10) break;
        await new Promise((resolve) => setTimeout(resolve, wait + 5));
      }
      if (!reservation.reserved) {
        requestCount -= 1;
        requestsBySource.set(sourceId, requestsBySource.get(sourceId) - 1);
        throw Object.assign(quotaError(sourceId, reservation), { notSent: true });
      }
      const response = await this.fetchImpl(url, options);
      if (response.status === 429) await this.sourceQuota.hold(sourceId, "rate_limited");
      return response;
    };
    const fetchCache = new Map();
    const requestStartedAtByOrigin = new Map();
    const pacedOriginQueues = new Map();
    const pacedPendingByUrl = new Map();
    const blockedOfficialOrigins = new Map();
    // Requests with a body are distinct per method and body; a body that is
    // not a string is never shared.
    const cacheKey = (url, options) => options?.body === undefined || options?.body === null ? String(url)
      : typeof options.body === "string" ? `${options.method ?? "GET"} ${url}\n${options.body}` : Symbol("uncached");
    const cachedFetch = async (url, options, sourceId) => {
      const key = cacheKey(url, options);
      if (!fetchCache.has(key)) {
        if (requestCount >= maxRequests) {
          throw Object.assign(new Error("discovery request budget exhausted"), { notSent: true });
        }
        if (sourceId && (requestsBySource.get(sourceId) ?? 0) >= maxRequestsPerSource) {
          throw Object.assign(new Error("source request budget exhausted"), { notSent: true });
        }
        // Claim the in-memory request slot before the durable board reservation
        // yields, so concurrent ATS origins cannot overshoot source/global caps.
        requestCount += 1;
        if (sourceId) requestsBySource.set(sourceId, (requestsBySource.get(sourceId) ?? 0) + 1);
        const learnedBoardKey = isLearnedBoardRequest(sourceId, key, learnedBoardKeys);
        try {
          if (learnedBoardKey) {
            const reserved = await this.applicationService.store.mutate((state) => {
              const at = Date.now();
              if (learnedBoardRequestsInLastDay(state.audit, identity.profileId,
                learnedBoardKey, at) >= MAX_LEARNED_BOARD_REQUESTS_PER_DAY) return false;
              state.audit.push({ id: randomUUID(), at: new Date(at).toISOString(),
                actorId: identity.actorId, profileId: identity.profileId,
                action: "discovery.ats_learned_board_request", subjectId: learnedBoardKey,
                details: { sourceId } });
              return true;
            });
            if (!reserved) throw new Error("learned board request budget exhausted");
          }
        } catch (error) {
          requestCount -= 1;
          if (sourceId) requestsBySource.set(sourceId, requestsBySource.get(sourceId) - 1);
          throw error;
        }
        // `key` carries the method and body for keyed POST sources, so the origin
        // comes from the URL itself rather than from the cache key.
        requestStartedAtByOrigin.set(new URL(String(url)).origin, Date.now());
        if (learnedBoardKey) learnedBoardRequests.set(learnedBoardKey,
          (learnedBoardRequests.get(learnedBoardKey) ?? 0) + 1);
        fetchCache.set(key, credentials.has(sourceId) ? keyedFetch(url, options, sourceId)
          : Promise.resolve(this.fetchImpl(url, options)));
      }
      try { return (await fetchCache.get(key)).clone(); }
      catch (error) { fetchCache.delete(key); throw error; }
    };
    const pacedOfficialFetch = (url, options, sourceId) => {
      const key = String(url);
      if (fetchCache.has(key)) return cachedFetch(url, options, sourceId);
      if (pacedPendingByUrl.has(key)) return pacedPendingByUrl.get(key).then((response) => response.clone());
      const origin = new URL(key).origin;
      const previous = pacedOriginQueues.get(origin) ?? Promise.resolve();
      const pending = previous.catch(() => {}).then(async () => {
        if (blockedOfficialOrigins.has(origin)) {
          throw new Error(`official source blocked by HTTP ${blockedOfficialOrigins.get(origin)}`);
        }
        const last = requestStartedAtByOrigin.get(origin);
        const waitMs = Math.max(0, this.officialRequestPaceMs - (Date.now() - (last ?? 0)));
        if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
        const response = await cachedFetch(url, options, sourceId);
        if (response.status === 403 || response.status === 429) {
          blockedOfficialOrigins.set(origin, response.status);
        }
        return response;
      });
      pacedOriginQueues.set(origin, pending.then(() => {}, () => {}));
      pacedPendingByUrl.set(key, pending);
      void pending.finally(() => pacedPendingByUrl.delete(key)).catch(() => {});
      return pending.then((response) => response.clone());
    };
    // A keyed source with no credentials is dropped before any request.
    const requests = selected.filter(({ id }) => !credentials.has(id) || credentials.get(id))
      .flatMap((source) => (input.queryPlan ?? [null]).map((query) => ({ source, query })));
    const settled = await Promise.allSettled(requests.map(async ({ source, query }) => {
      const started = performance.now();
      try { return await source.search({
      // The official feeds can be scored locally without extra provider
      // requests, so inspect a wider bounded pool before the accepted cap.
      limit: query?.limit ?? (["ashby", "greenhouse", "lever"].includes(source.id) ? 500 : 200),
      query: query?.filters,
      fetchImpl: (url, options) => ["ashby", "greenhouse", "lever"].includes(source.id)
        ? pacedOfficialFetch(url, options, source.id) : cachedFetch(url, options, source.id),
      profile,
      searchTitles,
      searchCycle: sourceCycles[source.id] ?? 0,
      isHandled,
      sourceConfig: sourceConfigs.get(source.id),
      ...(credentials.has(source.id) ? { credentials: credentials.get(source.id),
        quota: this.sourceQuota.forSource(source.id, this.#quotaLimits(source.id),
          { fingerprint: credentialFingerprint(credentials.get(source.id)) }) } : {}),
      onError: (error) => internalErrors.push({ source: source.id, ...error }),
      onStats: (stats) => {
        const previous = providerStats.get(source.id) ?? { rawRows: 0,
          adapterPrescreenRejected: 0, pagesVisited: 0, queryStats: [],
          skippedTerms: [], coverageBlocked: false };
        previous.rawRows += Number(stats.rawRows ?? 0);
        previous.adapterPrescreenRejected += Number(stats.adapterPrescreenRejected ?? 0);
        previous.pagesVisited += Number(stats.pagesVisited ?? 0);
        previous.queryStats.push(...(stats.queryStats ?? []));
        previous.skippedTerms.push(...(stats.skippedTerms ?? []));
        previous.coverageBlocked ||= stats.coverageBlocked === true;
        providerStats.set(source.id, previous);
      }
      }); } finally {
        sourceDurations.set(source.id, (sourceDurations.get(source.id) ?? 0)
          + performance.now() - started);
      }
    }));
    telemetry.observe("discovery.fetch_ms", performance.now() - fetchStarted, { mode });
    const fetchMs = performance.now() - fetchStarted;
    telemetry.count("discovery.provider_requests", requestCount, { mode });

    const errors = [...internalErrors];
    const found = [];
    for (let index = 0; index < settled.length; index += 1) {
      const result = settled[index];
      if (result.status === "rejected") {
        errors.push({ source: requests[index].source.id, error: String(result.reason?.message ?? result.reason),
          ...(typeof result.reason?.code === "string" ? { code: result.reason.code } : {}) });
      } else found.push(...result.value.map((item) => ({ ...item, source: requests[index].source.id })));
    }
    for (const error of errors) {
      const restricted = /returned HTTP (403|429)\b/i.exec(String(error.error ?? ""));
      if (restricted && ["ashby", "greenhouse", "lever"].includes(error.source)
        && typeof error.board === "string" && error.board) {
        await this.#recordAtsBackoff(identity, `${error.source}:${error.board}`,
          `http_${restricted[1]}`);
      }
    }
    for (const row of sourceYield.values()) {
      const sourceErrors = errors.filter((error) => error.source === row.sourceId);
      row.requestsMade = requestsBySource.get(row.sourceId) ?? 0;
      row.elapsedMs = Math.round(sourceDurations.get(row.sourceId) ?? 0);
      const stats = providerStats.get(row.sourceId);
      row.rawRowsObserved = stats?.rawRows ?? null;
      row.adapterPrescreenRejected = stats?.adapterPrescreenRejected ?? null;
      row.pagesVisited = stats?.pagesVisited ?? null;
      row.queryStats = stats?.queryStats ?? [];
      row.skippedTerms = stats?.skippedTerms ?? [];
      row.coverageBlocked = stats?.coverageBlocked ?? false;
      row.partialReasons = [...new Set(sourceErrors.map((error) => error.reason)
        .filter((reason) => /^partial_|^invalid_next_page$/.test(reason)))];
      row.errors = sourceErrors.map((error) => ({ reason: error.reason ?? "fetch_error" }));
      row.sourceFailure = sourceErrors.length > 0;
      row.rateLimited = sourceErrors.some((error) => /\b(?:HTTP\s*)?(?:403|429)\b|rate.?limit/i
        .test(String(error.error ?? "")));
      row.challenge = sourceErrors.some((error) => /\b(?:captcha|challenge)\b/i
        .test(String(error.error ?? "")));
      row.timedOut = sourceErrors.some((error) => /\b(?:timeout|timed out|budget exhausted)\b/i
        .test(String(error.error ?? "")));
      // A completed scan is not evidence that a provider's result set was
      // exhausted. Most feeds do not expose a reliable total/page cursor.
      row.exhausted = false;
    }

    const unhandledFound = found.filter((raw) => {
      if (isHandled(raw)) return false;
      if (input.reviewOnly !== true) return true;
      const normalized = normalizeOpportunity(raw, { source: raw.source });
      const unchanged = unchangedIrrelevantRole(normalized, irrelevant);
      if (unchanged) handledMatches.add([...roleKeys(normalized)][0] ?? raw.applyUrl);
      return !unchanged;
    });
    const uniqueFound = [...new Map(unhandledFound
      .map((raw) => [`${raw.source}:${raw.externalId ?? raw.applyUrl}`, raw])).values()];
    if (input.reviewOnly === true) {
      const perSource = new Map();
      const seenKeys = new Set();
      const candidates = [];
      for (const raw of uniqueFound) {
        const keys = roleKeys(raw);
        if ([...keys].some((key) => seenKeys.has(key))) continue;
        const count = perSource.get(raw.source) ?? 0;
        if (count >= requestedLimit) continue;
        const role = normalizeOpportunity(raw, { source: raw.source });
        const mismatches = reviewedEligibility(role, profile, mode);
        if (mismatches.length) {
          const row = sourceYield.get(raw.source);
          if (row) { row.excluded += 1; row.exclusionCounts.hardExclusion += 1; }
          continue;
        }
        for (const key of keys) seenKeys.add(key);
        perSource.set(raw.source, count + 1);
        candidates.push({ source: role.source, externalId: role.externalId,
          title: role.title, company: role.company, description: role.description.slice(0, 8000),
          location: role.location, remote: role.remote, employmentType: role.employmentType,
          postedAt: role.postedAt, applyUrl: role.applyUrl, listingUrl: role.listingUrl,
          tags: role.tags, compensation: role.compensation,
          uncertainties: role.uncertainties });
      }
      for (const row of sourceYield.values()) {
        row.found = uniqueFound.filter((item) => item.source === row.sourceId).length;
        row.handledFiltered = handledBySource.get(row.sourceId)?.size ?? 0;
        row.selected = perSource.get(row.sourceId) ?? 0;
      }
      return { mode, sources: requestedSources, found: uniqueFound.length,
        handledFiltered: handledMatches.size, requestsMade: requestCount,
        candidates, sourceYield: [...sourceYield.values()],
        errors: errors.map((item) => redactedError(item, [...credentials.values()])),
        durations: { fetchMs, totalMs: performance.now() - scanStarted } };
    }
    for (const row of sourceYield.values()) {
      row.dedupFiltered = unhandledFound.filter((item) => item.source === row.sourceId).length
        - uniqueFound.filter((item) => item.source === row.sourceId).length;
    }
    const normalizedFound = [];
    const seenOfficialKeys = new Set();
    const officialAttempts = new Map();
    const resolutionAttempts = new Map();
    let excluded = 0;
    let officialResolutionMs = 0;
    const configuredOfficialCandidateCap = Number(
      this.config.discovery?.officialVerificationMaxCandidatesPerSource ?? 10);
    const officialCandidateCap = Number.isInteger(configuredOfficialCandidateCap)
      && configuredOfficialCandidateCap > 0
      ? Math.min(10, configuredOfficialCandidateCap) : 10;
    for (const raw of uniqueFound) {
      const origin = raw.source;
      const row = sourceYield.get(origin);
      if (row) row.found += 1;
      const storedLead = matchingStoredLead(snapshot, identity.profileId, raw);
      const retryDecision = leadRetryDecision(storedLead, raw);
      if (retryDecision) {
        if (retryDecision === "pending_expired") {
          await this.applicationService.markDiscoveryLeadExpired(storedLead.id, identity);
        }
        excluded += 1;
        if (row) { row.excluded += 1; row.retryDeferred = (row.retryDeferred ?? 0) + 1; }
        continue;
      }
      let candidate = raw;
      if (AGGREGATOR_SOURCES.has(origin)) {
        const started = performance.now();
        try {
          const attempt = officialAttempts.get(origin) ?? 0;
          const resolutionAttempt = resolutionAttempts.get(origin) ?? 0;
          const mayResolve = Boolean(officialAtsIdentityFromUrl(raw.applyUrl)
            || raw.applicationDestinationPending === true);
          let resolution;
          if (this.#aggregatorBackoffActive(identity.profileId, origin)) {
            resolution = { reason: "aggregator_backoff" };
          } else if (!mayResolve) {
            resolution = { reason: "non_ats_destination" };
          } else if (resolutionAttempt >= officialCandidateCap * 2) {
            resolution = { reason: "candidate_cap" };
          } else {
            resolutionAttempts.set(origin, resolutionAttempt + 1);
            try {
              resolution = await officialAtsUrlFromAggregator(raw,
                (url, options) => pacedOfficialFetch(url, options, origin));
            } catch (error) {
              resolution = { reason: /budget exhausted/i.test(error.message)
                ? "request_budget" : "redirect_error" };
            }
          }
          const wasOfficial = Boolean(resolution?.identity);
          if (resolution?.identity) {
            const listed = officialAtsIdentityFromUrl(raw.listingUrl);
            if (listed && listed.key !== resolution.identity.key) {
              if (row) row.excluded += 1;
              excluded += 1;
              continue;
            }
            // Public-board IDs differ from employer ATS IDs. Once the bounded
            // redirect reveals an already handled official role, avoid both a
            // fresh ATS request and a slot in the new-role verification cap.
            if (isHandled({ source: origin, applyUrl: resolution.url })) continue;
            if (seenOfficialKeys.has(resolution.identity.key)) {
              if (row) row.dedupFiltered += 1;
              continue;
            }
            if (attempt >= officialCandidateCap) {
              resolution = { reason: "candidate_cap" };
            } else {
              const key = atsBoardKey(resolution.identity);
              if (!backedOff.has(key)) {
                officialAttempts.set(origin, attempt + 1);
                let failure = "verification_failed";
                const verified = await fetchVerifiedOfficialAtsRole(resolution.url,
                  this.config.discovery?.sourceOptions ?? {},
                  (url, options) => pacedOfficialFetch(url, options, origin).catch((error) => {
                    if (/budget exhausted/i.test(error.message)) throw new Error("official lookup budget exhausted");
                    throw error;
                  }), (reason) => { failure = reason; });
                if (verified) {
                  if (resolution.evidence === "himalayas_explicit_apply_link"
                    && (!exactRoleText(raw.title) || !exactRoleText(raw.company)
                      || exactRoleText(raw.title) !== exactRoleText(verified.title)
                      || exactRoleText(raw.company) !== exactRoleText(verified.company))) {
                    if (row) row.excluded += 1;
                    excluded += 1;
                    continue;
                  }
                  candidate = { ...verified, discoverySource: origin,
                    provenance: { aggregatorSourceId: origin, aggregatorExternalId: raw.externalId,
                      aggregatorListingUrl: raw.listingUrl, officialAtsVerified: true } };
                  if (isHandled({ ...candidate, source: origin })) continue;
                } else if (failure === "closed_or_mismatched_role"
                  || failure === "ineligible_or_mismatched_destination") {
                  if (row) row.excluded += 1;
                  excluded += 1;
                  continue;
                } else {
                  resolution = { reason: failure };
                  if (["http_403", "http_429"].includes(failure)) {
                    await this.#recordAtsBackoff(identity, key, failure);
                    backedOff.add(key);
                  }
                }
              } else resolution = { reason: "ats_backoff" };
            }
          }
          if (candidate === raw) {
            // Unverified aggregator content remains observable and retriable,
            // but cannot enter the actionable employer-application lane.
            candidate = { ...raw, applicationDestinationPending: true,
              applicationDestinationVerified: false,
              destinationResolutionReason: resolution?.reason ?? "non_ats_destination" };
            if (["http_403", "http_429"].includes(resolution?.reason)) {
              if (row) { row.rateLimited = true; row.sourceFailure = true;
                row.errors.push({ reason: resolution.reason }); }
              errors.push({ source: origin, stage: "official_destination",
                reason: resolution.reason, error: `Official ATS returned ${resolution.reason}` });
              if (!wasOfficial) await this.#recordAggregatorBackoff(identity, origin,
                resolution.reason);
            }
            if (["request_budget", "candidate_cap", "budget"].includes(resolution?.reason) && row) {
              row.partialReasons = [...new Set([...(row.partialReasons ?? []),
                "partial_official_verification_budget"])];
            }
          }
        } finally {
          const elapsed = performance.now() - started;
          sourceDurations.set(origin, (sourceDurations.get(origin) ?? 0) + elapsed);
          officialResolutionMs += elapsed;
        }
      }
      const officialKeys = [...roleKeys(candidate)].filter((key) =>
        /^(ashby|greenhouse|lever):/.test(key));
      if (officialKeys.some((key) => seenOfficialKeys.has(key))) {
        if (row) row.dedupFiltered += 1;
        continue;
      }
      for (const key of officialKeys) seenOfficialKeys.add(key);
      normalizedFound.push(normalizeOpportunity(candidate, { source: candidate.source }));
      if (row) row.scored = (row.scored ?? 0) + 1;
    }
    for (const row of sourceYield.values()) {
      row.requestsMade = requestsBySource.get(row.sourceId) ?? 0;
      row.elapsedMs = Math.round(sourceDurations.get(row.sourceId) ?? 0);
    }
    const screeningStarted = performance.now();
    let destinationMs = 0;
    const scorerVersion = String(modePreferences.scorerVersion
      ?? this.config.discovery?.scorerVersion ?? "2");
    const shadowScorerVersion = this.config.discovery?.shadowScorerVersion
      ? String(this.config.discovery.shadowScorerVersion) : null;
    const preliminary = normalizedFound.map((raw, index) => ({
      index, result: scoreOpportunity(raw, profile, mode, { version: scorerVersion })
    }));
    const maximumSemantic = Math.max(0, Number(this.config.discovery?.semantic?.maxCandidates ?? 20));
    const semanticCandidates = selectSemanticCandidateIndexes(preliminary,
      maximumSemantic, modeConfig.minimumScore);
    const qualifying = [];
    const accepted = [];
    const fitReviewCandidates = [];
    const unverifiedSkillCandidates = [];
    for (let index = 0; index < normalizedFound.length; index += 1) {
      let raw = normalizedFound[index];
      const sourceId = discoverySourceOf(raw);
      const atsSource = STAGED_ATS_SOURCES.has(sourceId);
      const boardKey = atsSource ? `${sourceId}:${String(raw.externalId ?? "").split(":")[0].toLowerCase()}` : null;
      const broadenedSourceEnabled = this.config.discovery?.broadenedSources?.[sourceId] === true;
      // The old ATS title gate used full-time preferences. Public freelance
      // discovery had no equivalent title prefilter, so preserve that path.
      const legacyTitleAllowed = (mode === "freelance" && !atsSource)
        || legacyDiscoveryTitleRelevant(raw.title, profile);
      const broaderRole = learnedBoards.has(boardKey)
        || !legacyTitleAllowed;
      if (this.enricher && semanticCandidates.has(index)) {
        try { raw = await this.enricher.enrich(raw, profile); }
        catch (error) {
          errors.push({ source: raw.source, stage: "semantic_enrichment", error: error.message });
          telemetry.count("discovery.enrichment_failures", 1, { source: raw.source });
        }
      }
      const score = scoreOpportunity(raw, profile, mode, { version: scorerVersion });
      const shadow = shadowScorerVersion
        ? scoreOpportunity(raw, profile, mode, { version: shadowScorerVersion }) : null;
      let scored = { ...raw, mode, ...score,
        ...(broadenedSourceEnabled ? { discoveryRelease: { stage: "advisory", sourceId,
          reason: learnedBoards.has(boardKey) ? "learned_board" : "broadened_source" } } : {}),
        ...(shadow ? { scoreComparison: { activeVersion: scorerVersion, activeScore: score.score,
          shadowVersion: shadowScorerVersion, shadowScore: shadow.score,
          changedEligibility: Boolean(score.scoreDetails.hardExclusion) !== Boolean(shadow.scoreDetails.hardExclusion) } } : {}) };
      const opportunistic = scored.scoreDetails.rolePriority === "opportunistic";
      const opportunisticRules = modePreferences.opportunisticRoles ?? {};
      const opportunisticQualified = opportunistic
        && raw.remote === true
        && scored.scoreDetails.compensationComparable === true
        && scored.scoreDetails.matchedSkills.length >= Number(opportunisticRules.minimumMatchedSkills ?? 5)
        && scored.score >= Number(opportunisticRules.minimumScore ?? 65);
      const needsFitReview = scored.scoreDetails.fitReview;
      if (scored.scoreDetails.hardExclusion || needsFitReview
        || (opportunistic ? !opportunisticQualified : scored.score < modeConfig.minimumScore)) {
        excluded += 1;
        if (sourceYield.has(discoverySourceOf(raw))) {
          const row = sourceYield.get(discoverySourceOf(raw));
          row.excluded += 1;
          const kind = scored.scoreDetails.hardExclusion ? "hardExclusion"
            : needsFitReview ? "fitReview"
              : opportunistic ? "opportunisticRequirements" : "belowScore";
          row.exclusionCounts[kind] += 1;
        }
        const unverifiedSkill = /absent from the verified skill profile/i
          .test(scored.scoreDetails.hardExclusion ?? "");
        if (unverifiedSkill || needsFitReview || (!scored.scoreDetails.hardExclusion
          && scored.score >= 30
          && (scored.scoreDetails.matchedSkills.length >= 2
            || (scored.scoreDetails.matchedSkills.length >= 1
              && scored.scoreDetails.titlePriority)))) {
          const review = {
            source: raw.source, discoverySource: discoverySourceOf(raw), externalId: raw.externalId,
            company: raw.company, title: raw.title, location: raw.location,
            listingUrl: raw.listingUrl, applyUrl: raw.applyUrl,
            applicationDestinationPending: raw.applicationDestinationPending === true,
            score: scored.score,
            titlePriority: scored.scoreDetails.titlePriority,
            reason: unverifiedSkill ? "unverified_required_skill"
              : needsFitReview ? needsFitReview.reason
              : opportunistic ? "opportunistic_requirements" : "below_automatic_score",
            ...(needsFitReview ? { reviewRequirement: needsFitReview.requirement } : {}),
            matchedSkillCount: scored.scoreDetails.matchedSkills.length,
            compensationComparable: scored.scoreDetails.compensationComparable === true
          };
          (unverifiedSkill || needsFitReview ? unverifiedSkillCandidates : fitReviewCandidates).push(review);
        }
        continue;
      }
      if (broaderRole && !broadenedSourceEnabled) {
        excluded += 1;
        if (sourceYield.has(sourceId)) sourceYield.get(sourceId).excluded += 1;
        continue;
      }
      if (scored.officialAtsCandidateUrl) {
        // An aggregator result that points at an official ATS is replaced by
        // the fresh official role, then screened again on the official data.
        const destinationStarted = performance.now();
        const official = await this.#verifiedOfficialCandidate(scored, identity,
          (url, options) => cachedFetch(url, options));
        destinationMs += performance.now() - destinationStarted;
        if (official.role) {
          const fresh = normalizeOpportunity({ ...official.role, mode }, { source: official.role.source });
          const rescored = scoreOpportunity(fresh, profile, mode, { version: scorerVersion });
          if (rescored.scoreDetails.hardExclusion || rescored.score < modeConfig.minimumScore) {
            excluded += 1;
            if (sourceYield.has(raw.source)) {
              const row = sourceYield.get(raw.source);
              row.excluded += 1;
              row.exclusionCounts[rescored.scoreDetails.hardExclusion ? "hardExclusion" : "belowScore"] += 1;
            }
            continue;
          }
          scored = { ...fresh, mode, ...rescored };
        } else scored = { ...scored, uncertainties: [...new Set([...scored.uncertainties, official.failure])] };
      } else if (scored.applicationDestinationPending) {
        const destinationStarted = performance.now();
        try { scored = await resolveEmployerApplicationUrl(scored, cachedFetch); }
        catch (error) {
          errors.push({ source: scored.source, stage: "application_destination", error: error.message });
        }
        destinationMs += performance.now() - destinationStarted;
      }
      // This flag is derived from a server-fetched official ATS row and its
      // stable role URL, never from caller-supplied source metadata.
      scored.applicationDestinationVerified = officialAtsDestination(scored);
      if (!scored.applicationDestinationVerified) scored.applicationDestinationPending = true;
      if (isHandled(scored)) {
        excluded += 1;
        if (sourceYield.has(discoverySourceOf(raw))) sourceYield.get(discoverySourceOf(raw)).excluded += 1;
        continue;
      }
      if (sourceYield.has(discoverySourceOf(raw))) {
        sourceYield.get(discoverySourceOf(raw)).qualifying += 1;
        if (scored.applicationDestinationPending) sourceYield.get(discoverySourceOf(raw)).destinationPending += 1;
      }
      accepted.push(scored);
    }
    const selectedPerSource = new Map();
    const selectedAccepted = [...accepted].sort((left, right) => Number(right.score ?? 0) - Number(left.score ?? 0)
      || Date.parse(right.postedAt ?? 0) - Date.parse(left.postedAt ?? 0)).filter((scored) => {
      // Unresolved destinations have a separate bounded review lane; they
      // cannot consume the cap intended for actionable employer applications.
      const lane = `${discoverySourceOf(scored)}:${scored.applicationDestinationPending ? "pending" : "ready"}`;
      const count = selectedPerSource.get(lane) ?? 0;
      if (count >= requestedLimit) return false;
      selectedPerSource.set(lane, count + 1);
      return true;
    });
    for (const scored of selectedAccepted) {
      if (sourceYield.has(discoverySourceOf(scored)) && !scored.applicationDestinationPending) {
        sourceYield.get(discoverySourceOf(scored)).selected += 1;
      }
      const opportunity = await this.applicationService.addOpportunity(scored, identity, { serverVerifiedDiscovery: true,
        advisoryDiscovery: scored.discoveryRelease });
      const entry = { opportunity };
      if (opportunity.applicationDestinationPending) entry.applicationBlockedBySource = "employer_application_url_required";
      else if (opportunity.discoveryRelease?.stage === "advisory") entry.applicationBlockedBySource = "advisory_fit_review_required";
      if (!profileStatus.readyToApply) entry.applicationBlockedByProfile = profileStatus.missingForApplications;
      qualifying.push(entry);
    }
    telemetry.count("discovery.scans", 1, { mode, sourceCount: requestedSources.length });
    telemetry.count("discovery.source_failures", errors.length, { mode });
    telemetry.observe("discovery.jobs_found", uniqueFound.length, { mode });
    telemetry.observe("discovery.scan_ms", performance.now() - scanStarted, { mode });
    for (const [sourceId, roles] of handledBySource) sourceYield.get(sourceId).handledFiltered = roles.size;
    const learnedBoardYield = [...learnedBoards].map(([key, board]) => ({ ...board,
      requestsMade: learnedBoardRequests.get(key) ?? 0,
      eligibleUnhandled: new Set(accepted.filter((role) => {
        const parsed = officialAtsIdentityFromUrl(role.applyUrl);
        return role.applicationDestinationVerified === true
          && role.applicationDestinationPending !== true
          && discoverySourceOf(role) === board.sourceId
          && parsed && `${parsed.source}:${parsed.board}` === key;
      }).flatMap((role) => [...roleKeys(role)].filter((roleKey) => roleKey.startsWith(`${key}:`)))).size
    }));
    await this.applicationService.store.mutate((state) => state.audit.push({ id: randomUUID(),
      at: new Date().toISOString(), actorId: identity.actorId, profileId: identity.profileId,
      action: "discovery.scan_completed", subjectId: randomUUID(),
      details: { sources: [...new Set(requests.map(({ source }) => source.id))] } }));
    return {
      mode,
      sources: requestedSources,
      found: uniqueFound.length,
      handledFiltered: handledMatches.size,
      requestsMade: requestCount,
      qualifying: qualifying.length,
      excluded,
      readyToApply: profileStatus.readyToApply,
      missingForApplications: profileStatus.missingForApplications,
      // Keyed-source credentials must never reach scan output.
      errors: errors.map((item) => redactedError(item, [...credentials.values()])),
      fitReviewCandidates: selectFitReviewCandidates(fitReviewCandidates,
        unverifiedSkillCandidates),
      sourceYield: [...sourceYield.values()],
      learnedBoardYield,
      searchPlanSeed: { profile: { preferences: { fullTime: {
        jobTitles: modePreferences.jobTitles ?? [],
        secondaryJobTitles: modePreferences.secondaryJobTitles ?? []
      } } }, verifiedSubmittedTitles: searchTitles },
      durations: { fetchMs, officialResolutionMs,
        screeningMs: Math.max(0, performance.now() - screeningStarted - destinationMs),
        destinationMs: destinationMs + officialResolutionMs,
        totalMs: performance.now() - scanStarted },
      items: qualifying
    };
  }
}

function activeAtsBoardBackoffs(snapshot, profileId, at = Date.now()) {
  const latest = new Map((snapshot.audit ?? []).filter((item) => item.profileId === profileId
    && item.action === "discovery.ats_backoff").map((item) => [item.subjectId, item]));
  return new Set([...latest].filter(([, item]) => Date.parse(item.details?.nextAt) > at)
    .map(([key]) => key));
}

function completedSourceCycles(audit, profileId, sourceIds) {
  const starts = new Map(audit.filter((item) => item.profileId === profileId
    && item.action === "campaign.started").map((item) => [item.subjectId, item]));
  const completedPrimary = new Set(audit.filter((item) => item.profileId === profileId
    && item.action === "campaign.scan_completed").map((item) => item.subjectId));
  const completedBrowser = new Set(audit.filter((item) => item.profileId === profileId
    && item.action === "campaign.source_scanned" && item.details?.completed !== false)
    .map((item) => `${item.subjectId}:${item.details.sourceId}`));
  return Object.fromEntries([...new Set(sourceIds)].map((sourceId) => [sourceId,
    [...starts].filter(([campaignId, event]) => completedPrimary.has(campaignId)
      && event.details?.sources?.includes(sourceId)).length
    + [...starts].filter(([campaignId, event]) => event.details?.fallbackSources?.includes(sourceId)
      && completedBrowser.has(`${campaignId}:${sourceId}`)).length
    + audit.filter((event) => event.profileId === profileId
      && event.action === "discovery.scan_completed" && event.details?.sources?.includes(sourceId)).length]));
}

function redactedError(item, credentialSets) {
  if (!credentialSets.some(Boolean)) return item;
  return Object.fromEntries(Object.entries(item).map(([key, value]) =>
    [key, typeof value === "string" ? redactSecrets(value, ...credentialSets) : value]));
}

function perSourceLimit(entries, limit) {
  const counts = new Map();
  return entries.filter((entry) => {
    const source = entry.opportunity.source;
    const count = counts.get(source) ?? 0;
    if (count >= limit) return false;
    counts.set(source, count + 1);
    return true;
  });
}

function importedCandidate(candidate, sourceId) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("candidate must be an object");
  }
  const required = ["title", "company", "applyUrl"];
  if (required.some((key) => typeof candidate[key] !== "string" || !candidate[key].trim())) {
    throw new Error("candidate requires title, company, and applyUrl");
  }
  for (const key of ["applyUrl", "listingUrl"]) {
    if (candidate[key] === undefined) continue;
    const url = new URL(candidate[key]);
    if (url.protocol !== "https:") throw new Error(`${key} must use HTTPS`);
  }
  const capped = (value, size) => value === undefined ? undefined : String(value).slice(0, size);
  const destinationObserved = candidate.applicationDestinationVerified === true
    && (!candidate.listingUrl || new URL(candidate.listingUrl).hostname.replace(/^www\./, "")
      !== new URL(candidate.applyUrl).hostname.replace(/^www\./, ""));
  return normalizeOpportunity({
    source: sourceId,
    externalId: capped(candidate.externalId, 500),
    title: capped(candidate.title, 300), company: capped(candidate.company, 300),
    description: capped(candidate.description, 100_000),
    location: capped(candidate.location, 500), employmentType: capped(candidate.employmentType, 100),
    remote: candidate.remote === true, postedAt: capped(candidate.postedAt, 100),
    listingUrl: candidate.listingUrl ?? candidate.applyUrl, applyUrl: candidate.applyUrl,
    // A browser-observed off-board link is a useful lead. The employer role,
    // location, and open form remain unverified until a fresh employer check.
    applicationDestinationVerified: false,
    applicationDestinationPending: true,
    tags: Array.isArray(candidate.tags) ? candidate.tags.slice(0, 100).map((item) => String(item).slice(0, 100)) : [],
    compensation: candidate.compensation && typeof candidate.compensation === "object"
      ? candidate.compensation : undefined,
    provenance: { importedBy: "chrome_session_discovery", sourceUrl: capped(candidate.sourceUrl, 2000),
      employerLinkObserved: destinationObserved },
    uncertainties: Array.isArray(candidate.uncertainties)
      ? candidate.uncertainties.slice(0, 50).map((item) => String(item).slice(0, 200)) : []
  }, { source: sourceId });
}
