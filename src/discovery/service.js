import { randomUUID } from "node:crypto";
import { officialAtsUrlFromAggregator, resolveEmployerApplicationUrl } from "./application-destination.js";
import { remoteok } from "./sources/remoteok.js";
import { arbeitnow } from "./sources/arbeitnow.js";
import { jobicy } from "./sources/jobicy.js";
import { himalayas } from "./sources/himalayas.js";
import { greenhouse } from "./sources/greenhouse.js";
import { ashby } from "./sources/ashby.js";
import { lever } from "./sources/lever.js";
import { scoreOpportunity } from "./scoring.js";
import { telemetry } from "../telemetry.js";
import { normalizeOpportunity } from "./normalization.js";
import { runIdempotent } from "../idempotency.js";
import { isHandledRole, knownRoleIndex, roleKeys } from "./handled-roles.js";
import { leadRetryDecision, matchingStoredLead } from "./candidate-state.js";
import { selectSemanticCandidateIndexes } from "./semantic-candidate-selection.js";
import { selectFitReviewCandidates } from "./fit-review-selection.js";
import { legacyDiscoveryTitleRelevant } from "./title-preferences.js";
import { fetchVerifiedOfficialAtsRole, officialAtsDestination, officialAtsIdentityFromUrl } from "./official-ats.js";
import { sourceConfigWithLearnedBoards, isLearnedBoardRequest,
  learnedBoardRequestsInLastDay, MAX_LEARNED_BOARD_REQUESTS_PER_DAY } from "./learned-boards.js";

const SOURCES = new Map([remoteok, arbeitnow, jobicy, himalayas, greenhouse, ashby, lever].map((source) => [source.id, source]));
const atsBoardKey = (parsed) => parsed ? `${parsed.source}:${parsed.board}` : null;
const AGGREGATOR_SOURCES = new Set(["himalayas", "jobicy"]);
const STAGED_ATS_SOURCES = new Set(["ashby", "greenhouse", "lever"]);
const discoverySourceOf = (role) => role.discoverySource ?? role.source;
const exactRoleText = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

export class DiscoveryService {
  constructor({ applicationService, profiles, config, fetchImpl = fetch, enricher = null,
    officialRequestPaceMs = 1500 }) {
    this.applicationService = applicationService;
    this.profiles = profiles;
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.enricher = enricher;
    this.officialRequestPaceMs = Number.isFinite(officialRequestPaceMs)
      ? Math.max(0, officialRequestPaceMs) : 1500;
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
      ashby: { kind: "official_feed", filters: { board: "configured", title: "local", location: "local" } }
    };
    return { mode: selectedMode, sources: enabled.filter((id) => SOURCES.has(id)).map((id) => ({
      id, version: 1, ...(capabilities[id] ?? { kind: "public_board", filters: {} }),
      filterOptions: id === "himalayas" ? {
        sort: ["relevant", "recent", "salaryAsc", "salaryDesc", "nameAToZ", "nameZToA", "jobs"],
        seniority: ["Entry-level", "Mid-level", "Senior", "Manager", "Director", "Executive"],
        employment_type: ["Full Time", "Part Time", "Contractor", "Temporary", "Intern", "Volunteer", "Other"]
      } : this.config.discovery?.sourceOptions?.[id]?.filterValues ?? {},
      configuredBoards: (() => {
        const options = sourceConfigWithLearnedBoards(snapshot, identity.profileId, id,
          this.config.discovery?.sourceOptions?.[id] ?? {},
          { cycle: sourceCycles[id] ?? 0,
            includeLearned: this.config.discovery?.broadenedSources?.[id] === true,
            isBackedOff: (key) => backedOff.has(key), isAtRequestBudget: atBudget });
        return (options.boards ?? options.sites ?? []).map((item) => item.slug ?? item.token);
      })(),
      ...(["himalayas", "jobicy", "remoteok", "arbeitnow"].includes(id)
        ? { applicationFlow: "resolve_employer_url_before_prepare" } : {}),
      maxQueries: 8, maxResultsPerQuery: 200
    })) };
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
          || (source.id !== "lever" && Array.isArray(value))
          || (["worldwide", "exclude_worldwide"].includes(key) && !["true", "false"].includes(value))
          || (source.filterOptions?.[key] && !(Array.isArray(value) ? value : [value])
            .every((item) => source.filterOptions[key].includes(item)))
          || JSON.stringify(value).length > 500) {
          throw Object.assign(new Error(`unsupported filter: ${key}`), { status: 400 });
        }
      }
      return { filters: query.filters, limit: query.limit ?? 50 };
    });
    const key = `${input.scanCycleId}:${input.idempotencyKey}`;
    return runIdempotent({ store: this.applicationService.store, profileId: identity.profileId,
      action: "discovery.query", key, input: { source: source.id, mode: descriptor.mode, queries },
      execute: () => this.scan({ mode: descriptor.mode, sources: [source.id], queryPlan: queries,
        limitPerSource: Math.max(...queries.map((query) => query.limit)) }, identity) });
  }

  async startCampaign(input, identity) {
    const target = Number(input.target ?? 10);
    const reserve = Number(input.reserve ?? Math.min(10, target));
    if (!Number.isInteger(target) || target < 1 || target > 100
      || !Number.isInteger(reserve) || reserve < 0 || reserve > 50) {
      throw Object.assign(new Error("target must be 1 to 100 and reserve must be 0 to 50"), { status: 400 });
    }
    const campaignId = randomUUID();
    const mode = input.mode ?? (await this.profiles.get(identity.profileId))?.defaultMode ?? this.config.defaultMode;
    const descriptor = await this.describeSources(identity, mode);
    const primarySources = input.sources ?? descriptor.sources.map((source) => source.id);
    const fallbackSources = [...new Set(input.fallbackSources ?? [])];
    if (fallbackSources.length > 100 || fallbackSources.some((source) => typeof source !== "string"
      || !/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(source))) {
      throw Object.assign(new Error("fallbackSources must contain at most 100 source IDs"), { status: 400 });
    }
    const sourceCycles = completedSourceCycles(this.applicationService.store.snapshot().audit,
      identity.profileId, [...primarySources, ...fallbackSources]);
    await this.applicationService.createCampaign({
      id: campaignId, target, reserve, mode, sources: primarySources,
      fallbackSources, queryPlan: input.queryPlan, reserveOnly: input.reserveOnly === true,
      sourceCycles
    }, identity);
    try {
      const scan = await this.scan({
        mode, sources: primarySources, queryPlan: input.queryPlan,
        // The scan fetches a wider bounded raw pool internally, then caps
        // accepted roles per source after scoring.
        limitPerSource: input.limitPerSource,
        prepareApplications: false, campaignId, reserveOnly: input.reserveOnly === true,
        maxRequestsPerSource: input.maxRequestsPerSource, sourceCycles
      }, identity);
      if (!input.reserveOnly && !scan.readyToApply) {
        throw Object.assign(new Error(`profile is missing application fields: ${scan.missingForApplications.join(", ")}`),
          { status: 409 });
      }
      const preloaded = input.reserveOnly ? [] : await this.#freshReserveCandidates(identity,
        await this.profiles.get(identity.profileId), mode,
        target + reserve);
      const ready = [...scan.items, ...preloaded].filter((entry) => !entry.opportunity.applicationDestinationPending
        && entry.opportunity.discoveryRelease?.stage !== "advisory"
        && /^https:\/\//i.test(entry.opportunity.applyUrl ?? ""));
      const ranked = [...ready].sort((left, right) => Number(right.opportunity.score ?? 0) - Number(left.opportunity.score ?? 0)
        || Date.parse(right.opportunity.postedAt ?? 0) - Date.parse(left.opportunity.postedAt ?? 0));
      const selected = fallbackSources.length
        ? perSourceLimit(ranked, 10) : ranked.slice(0, target + reserve);
      const applicationIds = [];
      for (const entry of fallbackSources.length || input.reserveOnly ? [] : selected) {
        try {
          const application = await this.applicationService.requestApplication(entry.opportunity.id, {
            campaignId
          }, identity);
          applicationIds.push(application.id);
        } catch (error) {
          if (error.status !== 409) throw error;
        }
      }
      const recorded = await this.applicationService.recordCampaignScan(campaignId, {
        found: scan.found, qualifying: scan.qualifying, excluded: scan.excluded,
        handledFiltered: scan.handledFiltered,
        fitReviewCandidates: scan.fitReviewCandidates,
        sourceYield: scan.sourceYield.map((row) => ({ ...row,
          selected: selected.filter((entry) => discoverySourceOf(entry.opportunity) === row.sourceId).length })),
        durations: scan.durations,
        destinationPending: scan.items.length - ready.length,
        selectedOpportunityIds: selected.map((entry) => entry.opportunity.id),
        applicationIds, errors: scan.errors
      }, identity);
      const result = (value) => ({ ...value, searchPlanSeed: scan.searchPlanSeed });
      if (input.reserveOnly && !fallbackSources.length) {
        return result(await this.applicationService.finalizeCampaignSelection(campaignId, identity));
      }
      return result(recorded);
    } catch (error) {
      await this.applicationService.recordCampaignFailure(campaignId, error, identity);
      throw error;
    }
  }

  async #freshReserveCandidates(identity, profile, mode, limit) {
    const state = this.applicationService.store.snapshot();
    const attempted = new Set(state.applications.filter((item) => item.profileId === identity.profileId)
      .map((item) => item.opportunityId));
    const candidates = state.opportunities.filter((item) => item.profileId === identity.profileId
      && item.mode === mode && item.reserveExpiresAt && Date.parse(item.reserveExpiresAt) > Date.now()
      && !attempted.has(item.id) && officialAtsDestination(item))
      .sort((left, right) => Number(right.score ?? 0) - Number(left.score ?? 0));
    const bounded = candidates.slice(0, Math.min(limit, 20));
    const result = [];
    const preferences = mode === "freelance" ? profile?.preferences?.freelance
      : profile?.preferences?.fullTime;
    const version = String(preferences?.scorerVersion ?? this.config.discovery?.scorerVersion ?? "2");
    for (const stored of bounded) {
      const atsKey = atsBoardKey(officialAtsIdentityFromUrl(stored.applyUrl));
      if (atsKey && this.#atsBackoffActive(identity.profileId, atsKey)) continue;
      let failureReason;
      const verified = await fetchVerifiedOfficialAtsRole(stored.applyUrl,
        this.config.discovery?.sourceOptions ?? {}, this.fetchImpl,
        (reason) => { failureReason = reason; });
      if (atsKey && ["http_403", "http_429"].includes(failureReason)) {
        await this.#recordAtsBackoff(identity, atsKey, failureReason);
      }
      if (!verified || `${verified.source}:${verified.externalId}`
        !== `${stored.source}:${stored.externalId}`) {
        await this.applicationService.store.mutate((draft) => {
          const item = draft.opportunities.find((entry) => entry.id === stored.id);
          if (item) {
            item.reserveExpiresAt = new Date().toISOString();
            item.reserveRetryAfter = new Date(Date.now() + 6 * 60 * 60_000).toISOString();
          }
        });
        continue;
      }
      const fresh = normalizeOpportunity({ ...verified, mode, reserveObservedAt: new Date().toISOString(),
        reserveExpiresAt: stored.reserveExpiresAt,
        provenance: { ...stored.provenance, officialAtsVerified: true } }, { source: verified.source });
      const score = scoreOpportunity(fresh, profile, mode, { version });
      if (score.scoreDetails.hardExclusion || score.scoreDetails.fitReview
        || score.score < this.config.modes[mode].minimumScore) {
        await this.applicationService.store.mutate((draft) => {
          const item = draft.opportunities.find((entry) => entry.id === stored.id);
          if (item) item.reserveExpiresAt = new Date().toISOString();
        });
        continue;
      }
      const updated = await this.applicationService.store.mutate((draft) => {
        const item = draft.opportunities.find((entry) => entry.id === stored.id
          && entry.profileId === identity.profileId);
        if (!item || draft.applications.some((app) => app.profileId === identity.profileId
          && app.opportunityId === item.id)) return null;
        Object.assign(item, fresh, score, { discoveryVerification: { sourceId: verified.source,
          verifiedAt: new Date().toISOString(), score: score.score } });
        return item;
      });
      if (updated) result.push({ opportunity: updated });
    }
    return result;
  }

  async refreshReserve(input, identity) {
    const descriptor = await this.describeSources(identity, input.mode);
    const sourceIds = input.sources ?? descriptor.sources.filter((item) => item.kind === "official_feed")
      .map((item) => item.id);
    if (!Array.isArray(sourceIds) || sourceIds.length > 7 || sourceIds.some((id) =>
      !descriptor.sources.some((source) => source.id === id && source.kind === "official_feed"))) {
      throw Object.assign(new Error("reserve refresh requires up to seven enabled official-feed sources"), { status: 400 });
    }
    const results = [];
    for (const sourceId of [...new Set(sourceIds)]) {
      const sourceStarted = performance.now();
      const key = `${descriptor.mode}:${sourceId}`;
      const claimed = await this.applicationService.store.mutate((state) => {
        const previous = state.audit.filter((item) => item.profileId === identity.profileId
          && item.subjectId === key && item.action.startsWith("reserve.source_")).at(-1);
        if (previous?.details?.nextAt && Date.parse(previous.details.nextAt) > Date.now()) return false;
        if (previous?.action === "reserve.source_started"
          && Date.parse(previous.details.leaseUntil) > Date.now()) return false;
        state.audit.push({ id: randomUUID(), at: new Date().toISOString(),
          actorId: identity.actorId, profileId: identity.profileId,
          action: "reserve.source_started", subjectId: key,
          details: { sourceId, mode: descriptor.mode,
            leaseUntil: new Date(Date.now() + 2 * 60_000).toISOString() } });
        return true;
      });
      if (!claimed) { results.push({ sourceId, status: "cooldown_or_running" }); continue; }
      try {
        const scan = await this.scan({ mode: descriptor.mode, sources: [sourceId], limitPerSource: 10,
          maxRequestsPerSource: 20, prepareApplications: false, reserveOnly: true }, identity);
        const eligible = scan.items.map((entry) => entry.opportunity)
          .filter((item) => item.applicationDestinationVerified && officialAtsDestination(item));
        const observedAt = new Date().toISOString();
        const expiresAt = new Date(Date.now() + 45 * 60_000).toISOString();
        const restricted = scan.errors.some((item) => /(?:\b403\b|\b429\b|challenge|rate.?limit)/i
          .test(String(item.error ?? "")));
        const nextAt = new Date(Date.now() + (restricted ? 6 * 60 : scan.errors.length ? 60 : 30)
          * 60_000).toISOString();
        const durationMs = Math.round(performance.now() - sourceStarted);
        await this.applicationService.store.mutate((state) => {
          for (const role of eligible) {
            const item = state.opportunities.find((entry) => entry.id === role.id
              && entry.profileId === identity.profileId);
            if (!item || state.applications.some((application) => application.profileId === identity.profileId
              && application.opportunityId === item.id)) continue;
            item.reserveObservedAt = observedAt;
            item.reserveExpiresAt = expiresAt;
          }
          state.audit.push({ id: randomUUID(), at: observedAt, actorId: identity.actorId,
            profileId: identity.profileId, action: "reserve.source_completed", subjectId: key,
            details: { sourceId, mode: descriptor.mode, found: scan.found,
              eligible: eligible.length, handledFiltered: scan.handledFiltered,
              requestsMade: scan.requestsMade, restricted, nextAt, durationMs } });
        });
        results.push({ sourceId, status: restricted ? "backoff"
          : scan.errors.length ? "error_cooldown" : "complete",
          found: scan.found, eligible: eligible.length, handledFiltered: scan.handledFiltered,
          requestsMade: scan.requestsMade, nextAt });
      } catch (error) {
        const nextAt = new Date(Date.now() + 60 * 60_000).toISOString();
        await this.applicationService.store.mutate((state) => state.audit.push({ id: randomUUID(),
          at: new Date().toISOString(), actorId: identity.actorId, profileId: identity.profileId,
          action: "reserve.source_failed", subjectId: key,
          details: { sourceId, mode: descriptor.mode, nextAt,
            reason: String(error.message ?? error).slice(0, 120) } }));
        results.push({ sourceId, status: "failed", nextAt });
      }
    }
    const renewed = await this.#renewStoredReserve(identity, descriptor.mode, 20);
    return { mode: descriptor.mode, results, renewed };
  }

  async #renewStoredReserve(identity, mode, limit) {
    const state = this.applicationService.store.snapshot();
    const restrictedSources = new Set(state.audit.filter((item) => item.profileId === identity.profileId
      && item.action === "reserve.source_completed" && item.details?.mode === mode)
      .reduce((latest, item) => latest.set(item.details.sourceId, item), new Map()).values());
    const blockedSourceIds = new Set([...restrictedSources].filter((item) => item.details?.restricted
      && Date.parse(item.details.nextAt) > Date.now()).map((item) => item.details.sourceId));
    const attempted = new Set(state.applications.filter((item) => item.profileId === identity.profileId)
      .map((item) => item.opportunityId));
    const due = state.opportunities.filter((item) => item.profileId === identity.profileId
      && item.mode === mode && item.reserveObservedAt && !attempted.has(item.id)
      && officialAtsDestination(item) && !blockedSourceIds.has(item.source)
      && Date.parse(item.reserveExpiresAt ?? 0) < Date.now() + 10 * 60_000
      && Date.parse(item.reserveRetryAfter ?? 0) <= Date.now())
      .sort((left, right) => Date.parse(left.reserveExpiresAt) - Date.parse(right.reserveExpiresAt))
      .slice(0, limit);
    let renewed = 0; let failed = 0;
    for (const stored of due) {
      const atsKey = atsBoardKey(officialAtsIdentityFromUrl(stored.applyUrl));
      if (atsKey && this.#atsBackoffActive(identity.profileId, atsKey)) continue;
      let failureReason;
      const verified = await fetchVerifiedOfficialAtsRole(stored.applyUrl,
        this.config.discovery?.sourceOptions ?? {}, this.fetchImpl,
        (reason) => { failureReason = reason; });
      if (atsKey && ["http_403", "http_429"].includes(failureReason)) {
        await this.#recordAtsBackoff(identity, atsKey, failureReason);
      }
      if (!verified || `${verified.source}:${verified.externalId}`
        !== `${stored.source}:${stored.externalId}`) {
        failed += 1;
        await this.applicationService.store.mutate((draft) => {
          const item = draft.opportunities.find((entry) => entry.id === stored.id);
          if (item) {
            item.reserveExpiresAt = new Date().toISOString();
            item.reserveRetryAfter = new Date(Date.now() + 6 * 60 * 60_000).toISOString();
          }
        });
        continue;
      }
      const profile = await this.profiles.get(identity.profileId);
      const fresh = normalizeOpportunity({ ...verified, mode,
        provenance: { ...stored.provenance, officialAtsVerified: true } }, { source: verified.source });
      const score = scoreOpportunity(fresh, profile, mode,
        { version: String(this.config.discovery?.scorerVersion ?? "2") });
      if (score.scoreDetails.hardExclusion || score.scoreDetails.fitReview
        || score.score < this.config.modes[mode].minimumScore) {
        failed += 1;
        await this.applicationService.store.mutate((draft) => {
          const item = draft.opportunities.find((entry) => entry.id === stored.id);
          if (item) {
            item.reserveExpiresAt = new Date().toISOString();
            item.reserveRetryAfter = new Date(Date.now() + 6 * 60 * 60_000).toISOString();
          }
        });
        continue;
      }
      await this.applicationService.store.mutate((draft) => {
        const item = draft.opportunities.find((entry) => entry.id === stored.id
          && entry.profileId === identity.profileId);
        if (!item || draft.applications.some((app) => app.profileId === identity.profileId
          && app.opportunityId === item.id)) return;
        Object.assign(item, fresh, score, { reserveObservedAt: new Date().toISOString(),
          reserveExpiresAt: new Date(Date.now() + 45 * 60_000).toISOString(),
          reserveRetryAfter: undefined,
          discoveryVerification: { sourceId: verified.source,
            verifiedAt: new Date().toISOString(), score: score.score } });
        renewed += 1;
      });
    }
    return { checked: due.length, renewed, failed };
  }

  async addCampaignSourceResults(campaignId, input, identity) {
    const campaign = this.applicationService.campaignStatus(campaignId, identity.profileId);
    const sourceId = String(input.sourceId ?? "");
    if (!campaign.sourceCoverage.fallbackPlanned.includes(sourceId)) {
      throw Object.assign(new Error("source is not in this campaign fallback plan"), { status: 400 });
    }
    if (!Array.isArray(input.items) || input.items.length > 200) {
      throw Object.assign(new Error("items must be an array with at most 200 candidates"), { status: 400 });
    }
    if ((input.errors !== undefined && (!Array.isArray(input.errors) || input.errors.length > 100
      || input.errors.some((error) => !error || typeof error !== "object" || typeof error.error !== "string")))
      || (input.pagesVisited !== undefined && (!Number.isInteger(input.pagesVisited)
        || input.pagesVisited < 0 || input.pagesVisited > 100))
      || (input.requestsMade !== undefined && (!Number.isInteger(input.requestsMade)
        || input.requestsMade < 0 || input.requestsMade > 1000))
      || (input.elapsedMs !== undefined && (!Number.isInteger(input.elapsedMs)
        || input.elapsedMs < 0 || input.elapsedMs > 600_000))
      || (input.stopReason !== undefined && (typeof input.stopReason !== "string"
        || !/^[a-z_]{1,50}$/.test(input.stopReason)))
      || (input.partialReasons !== undefined && (!Array.isArray(input.partialReasons)
        || input.partialReasons.length > 10 || input.partialReasons.some((reason) =>
          typeof reason !== "string" || !/^[a-z_]{1,50}$/.test(reason))))
      || (input.queryStats !== undefined && (!Array.isArray(input.queryStats)
        || input.queryStats.length > 16 || input.queryStats.some((row) => !row
          || typeof row.term !== "string" || row.term.length > 100
          || ["pages", "rawRows", "uniqueRows", "detailAttempts", "extractedJobs"]
            .some((key) => !Number.isInteger(row[key]) || row[key] < 0 || row[key] > 10000))))
      || (input.discardedObservedCandidates !== undefined
        && (!Number.isInteger(input.discardedObservedCandidates)
          || input.discardedObservedCandidates < 0 || input.discardedObservedCandidates > 100))
      || (input.discardReason !== undefined && (typeof input.discardReason !== "string"
        || !/^[a-z_]{1,50}$/.test(input.discardReason)))) {
      throw Object.assign(new Error("source telemetry is invalid"), { status: 400 });
    }
    if (input.cooldownSkipped === true) {
      const active = campaign.sourceCoverage.cooldowns?.[sourceId];
      if (!active || input.items.length || input.completed !== true
        || input.pagesVisited !== 0 || input.requestsMade !== 0) {
        throw Object.assign(new Error("cooldown coverage requires an active hold and zero requests"),
          { status: 409 });
      }
      const recorded = await this.applicationService.recordCampaignSourceScan(campaignId, {
        sourceId, found: 0, qualifying: 0, excluded: 0, handledFiltered: 0, selected: 0,
        destinationPending: 0, completed: true, pagesVisited: 0, requestsMade: 0,
        elapsedMs: input.elapsedMs,
        cooldownSkipped: true, cooldownReason: active.reason, cooldownUntil: active.until,
        discardedObservedCandidates: input.discardedObservedCandidates ?? 0,
        discardReason: input.discardReason,
        errors: []
      }, identity);
      return recorded.sourceCoverage.fallbackRemaining.length ? recorded
        : this.applicationService.finalizeCampaignSelection(campaignId, identity);
    }
    const profile = await this.profiles.get(identity.profileId);
    const profileStatus = await this.profiles.status(identity.profileId, campaign.mode, this.config.defaultMode);
    if (!profileStatus.readyToApply) {
      throw Object.assign(new Error(`profile is missing application fields: ${profileStatus.missingForApplications.join(", ")}`),
        { status: 409 });
    }
    const modeConfig = this.config.modes[campaign.mode];
    const modePreferences = campaign.mode === "freelance"
      ? profile?.preferences?.freelance ?? {} : profile?.preferences?.fullTime ?? {};
    const scorerVersion = String(modePreferences.scorerVersion ?? this.config.discovery?.scorerVersion ?? "2");
    const knownKeys = knownRoleIndex(this.applicationService.store.snapshot(), identity.profileId);
    const storedLeads = this.applicationService.store.snapshot();
    const atsBackoffKeys = new Set(this.applicationService.store.snapshot().audit.filter((item) =>
      item.profileId === identity.profileId && item.action === "discovery.ats_backoff"
      && Date.parse(item.details?.nextAt) > Date.now()).map((item) => item.subjectId));
    let excluded = 0; let handledFiltered = 0; let qualifying = 0; let selected = 0;
    let destinationPending = 0;
    const pendingCandidates = [];
    const fitReviewCandidates = [];
    const errors = [];
    const exclusionReasons = new Map();
    const eligible = [];
    const alreadySelected = campaign.sourceCoverage.scans.filter((scan) => scan.sourceId === sourceId)
      .reduce((sum, scan) => sum + Number(scan.selected ?? 0), 0);
    const remainingSourceSlots = Math.max(0, 10 - alreadySelected);
    // One browser result page may contain many roles from the same Ashby board.
    // Reuse that official response only within this import; final permits still
    // run their own freshness checks.
    const officialResponses = new Map();
    let officialRequestCount = 0;
    let officialBudgetBlockedCandidate = false;
    const maxOfficialRequests = Math.max(1, Math.min(30,
      Number(this.config.discovery?.officialVerificationMaxRequestsPerBatch ?? 20)));
    const officialFetch = async (url, options) => {
      const key = String(url);
      if (!officialResponses.has(key)) {
        if (officialRequestCount >= maxOfficialRequests) {
          officialBudgetBlockedCandidate = true;
          throw new Error("official lookup budget exhausted");
        }
        officialRequestCount += 1;
        officialResponses.set(key, Promise.resolve().then(() => this.fetchImpl(url, options)));
      }
      try { return (await officialResponses.get(key)).clone(); }
      catch (error) { officialResponses.delete(key); throw error; }
    };
    for (const candidate of input.items) {
      try {
        officialBudgetBlockedCandidate = false;
        const raw = importedCandidate(candidate, sourceId);
        const storedLead = matchingStoredLead(storedLeads, identity.profileId, raw);
        const retryDecision = leadRetryDecision(storedLead, raw);
        if (retryDecision) {
          if (retryDecision === "pending_expired") {
            await this.applicationService.markDiscoveryLeadExpired(storedLead.id, identity);
          }
          excluded += 1;
          exclusionReasons.set(retryDecision, (exclusionReasons.get(retryDecision) ?? 0) + 1);
          continue;
        }
        const officialIdentity = officialAtsIdentityFromUrl(raw.applyUrl);
        const listedIdentity = officialAtsIdentityFromUrl(raw.listingUrl);
        if (officialIdentity && listedIdentity && officialIdentity.key !== listedIdentity.key) {
          excluded += 1;
          exclusionReasons.set("official_ats_identity_mismatch",
            (exclusionReasons.get("official_ats_identity_mismatch") ?? 0) + 1);
          continue;
        }
        // An official role URL already in this profile's handled index needs
        // no further lookup. Preserve the mismatch check above so a forged
        // listing cannot claim the identity of a different ATS opening.
        if (officialIdentity && knownKeys.has(officialIdentity.key)) {
          handledFiltered += 1;
          continue;
        }
        if (officialIdentity && atsBackoffKeys.has(atsBoardKey(officialIdentity))) {
          excluded += 1;
          exclusionReasons.set("official_ats_backoff",
            (exclusionReasons.get("official_ats_backoff") ?? 0) + 1);
          continue;
        }
        let officialFailure = "verification_failed";
        const official = officialIdentity
          ? await fetchVerifiedOfficialAtsRole(raw.applyUrl,
            this.config.discovery?.sourceOptions ?? {}, officialFetch,
            (reason) => { officialFailure = reason; }) : null;
        if (officialIdentity && ["http_403", "http_429"].includes(officialFailure)) {
          await this.#recordAtsBackoff(identity, atsBoardKey(officialIdentity), officialFailure);
          atsBackoffKeys.add(atsBoardKey(officialIdentity));
        }
        if (officialIdentity && !official) {
          excluded += 1;
          const reason = officialBudgetBlockedCandidate
            ? "official_ats_lookup_budget_exhausted" : `official_ats_${officialFailure}`;
          exclusionReasons.set(reason, (exclusionReasons.get(reason) ?? 0) + 1);
          continue;
        }
        const verified = official ? normalizeOpportunity({ ...official,
          provenance: { importedBy: "campaign_browser_fallback", browserSourceId: sourceId,
            sourceUrl: raw.provenance?.sourceUrl, officialAtsVerified: true } }, { source: official.source }) : raw;
        if (isHandledRole(verified, knownKeys)) { handledFiltered += 1; continue; }
        const broadenedBrowserSource = this.config.discovery?.broadenedSources?.[sourceId] === true;
        if (official && !broadenedBrowserSource
          && !legacyDiscoveryTitleRelevant(verified.title, profile)) {
          excluded += 1;
          exclusionReasons.set("broadened_source_disabled",
            (exclusionReasons.get("broadened_source_disabled") ?? 0) + 1);
          continue;
        }
        for (const key of roleKeys(verified)) knownKeys.add(key);
        let scored = { ...verified, mode: campaign.mode,
          ...scoreOpportunity(verified, profile, campaign.mode, { version: scorerVersion }) };
        const opportunistic = scored.scoreDetails.rolePriority === "opportunistic";
        const opportunisticRules = modePreferences.opportunisticRoles ?? {};
        const opportunisticQualified = opportunistic && verified.remote === true
          && scored.scoreDetails.compensationComparable === true
          && scored.scoreDetails.matchedSkills.length >= Number(opportunisticRules.minimumMatchedSkills ?? 5)
          && scored.score >= Number(opportunisticRules.minimumScore ?? 65);
        if (scored.scoreDetails.hardExclusion
          || scored.scoreDetails.fitReview
          || (opportunistic ? !opportunisticQualified : scored.score < modeConfig.minimumScore)) {
          excluded += 1;
          if (!scored.scoreDetails.hardExclusion && scored.scoreDetails.fitReview) {
            fitReviewCandidates.push({ source: sourceId, company: scored.company,
              title: scored.title, listingUrl: scored.listingUrl, applyUrl: scored.applyUrl,
              score: scored.score, reason: scored.scoreDetails.fitReview.reason,
              reviewRequirement: scored.scoreDetails.fitReview.requirement });
          }
          const reason = scored.scoreDetails.hardExclusion
            ?? scored.scoreDetails.fitReview?.reason ?? (opportunistic
            ? "opportunistic_requirements_not_met" : "score_below_minimum");
          exclusionReasons.set(reason, (exclusionReasons.get(reason) ?? 0) + 1);
          continue;
        }
        qualifying += 1;
        if (scored.applicationDestinationPending) {
          try { scored = await resolveEmployerApplicationUrl(scored, this.fetchImpl); }
          catch (error) { errors.push({ stage: "application_destination", error: error.message }); }
        }
        if (scored.applicationDestinationPending || scored.applicationDestinationVerified !== true
          || !/^https:\/\//i.test(scored.applyUrl ?? "")) {
          destinationPending += 1;
          pendingCandidates.push({ ...scored, applicationDestinationPending: true,
            applicationDestinationVerified: false });
          continue;
        }
        eligible.push({ scored, serverVerifiedDiscovery: Boolean(official),
          advisoryDiscovery: official && broadenedBrowserSource
            ? { stage: "advisory", sourceId, reason: "broadened_browser_source" } : null });
      } catch (error) {
        errors.push({ stage: "candidate_import", error: String(error.message ?? error).slice(0, 500) });
      }
    }
    const opportunityIds = [];
    const pendingOpportunityIds = [];
    const alreadyPending = new Set(campaign.sourceCoverage.scans
      .filter((scan) => scan.sourceId === sourceId)
      .flatMap((scan) => scan.pendingOpportunityIds ?? []));
    for (const scored of pendingCandidates.sort((left, right) =>
      Number(right.score ?? 0) - Number(left.score ?? 0))
      .slice(0, Math.max(0, 10 - alreadyPending.size))) {
      const opportunity = await this.applicationService.addOpportunity({ ...scored,
        lastCampaignId: campaignId }, identity);
      if (!alreadyPending.has(opportunity.id)) {
        pendingOpportunityIds.push(opportunity.id);
        alreadyPending.add(opportunity.id);
      }
    }
    for (const { scored, serverVerifiedDiscovery, advisoryDiscovery } of eligible.sort((left, right) =>
      Number(right.scored.score ?? 0) - Number(left.scored.score ?? 0)
      || Date.parse(right.scored.postedAt ?? 0) - Date.parse(left.scored.postedAt ?? 0))
      .slice(0, remainingSourceSlots)) {
      const opportunity = await this.applicationService.addOpportunity({ ...scored, lastCampaignId: campaignId,
        ...(campaign.reserveOnly && serverVerifiedDiscovery
          ? { reserveObservedAt: new Date().toISOString(),
            reserveExpiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString() } : {}) },
        identity, { serverVerifiedDiscovery, advisoryDiscovery });
      opportunityIds.push(opportunity.id); selected += 1;
      for (const key of roleKeys(opportunity)) knownKeys.add(key);
    }
    const recorded = await this.applicationService.recordCampaignSourceScan(campaignId, {
      sourceId, found: input.items.length, qualifying, excluded, handledFiltered, selected,
      destinationPending,
      opportunityIds,
      pendingOpportunityIds,
      fitReviewCandidates: fitReviewCandidates.sort((left, right) => right.score - left.score).slice(0, 10),
      exclusionReasons: [...exclusionReasons.entries()].map(([reason, count]) => ({ reason, count }))
        .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason)),
      completed: input.completed !== false, pagesVisited: input.pagesVisited, requestsMade: input.requestsMade,
      elapsedMs: input.elapsedMs,
      rateLimited: input.rateLimited === true, exhausted: input.exhausted === true,
      challenge: input.challenge === true, timedOut: input.timedOut === true,
      parseDrift: input.parseDrift === true,
      sourceFailure: input.sourceFailure === true,
      stopReason: input.stopReason, partialReasons: input.partialReasons ?? [],
      queryStats: input.queryStats ?? [],
      discardedObservedCandidates: input.discardedObservedCandidates ?? 0,
      discardReason: input.discardReason,
      manual: input.manual === true,
      errors: [...errors, ...(input.errors ?? [])].slice(0, 100)
    }, identity);
    if (!recorded.sourceCoverage.fallbackRemaining.length) {
      return this.applicationService.finalizeCampaignSelection(campaignId, identity);
    }
    return recorded;
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
    const handledKeys = knownRoleIndex(snapshot, identity.profileId);
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
      if (!isHandledRole(role, handledKeys)) return false;
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
    const fetchCache = new Map();
    const requestStartedAtByOrigin = new Map();
    const pacedOriginQueues = new Map();
    const pacedPendingByUrl = new Map();
    const blockedOfficialOrigins = new Map();
    const cachedFetch = async (url, options, sourceId) => {
      const key = String(url);
      if (!fetchCache.has(key)) {
        if (requestCount >= maxRequests) throw new Error("discovery request budget exhausted");
        if (sourceId && (requestsBySource.get(sourceId) ?? 0) >= maxRequestsPerSource) {
          throw new Error("source request budget exhausted");
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
        requestStartedAtByOrigin.set(new URL(key).origin, Date.now());
        if (learnedBoardKey) learnedBoardRequests.set(learnedBoardKey,
          (learnedBoardRequests.get(learnedBoardKey) ?? 0) + 1);
        fetchCache.set(key, Promise.resolve(this.fetchImpl(url, options)));
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
    const requests = selected.flatMap((source) => (input.queryPlan ?? [null]).map((query) => ({ source, query })));
    const settled = await Promise.allSettled(requests.map(async ({ source, query }) => {
      const started = performance.now();
      try { return await source.search({
      // The official feeds can be scored locally without extra provider
      // requests, so inspect a wider bounded pool before the accepted cap.
      limit: ["ashby", "greenhouse", "lever"].includes(source.id) ? 500 : 200,
      query: query?.filters,
      fetchImpl: (url, options) => ["ashby", "greenhouse", "lever"].includes(source.id)
        ? pacedOfficialFetch(url, options, source.id) : cachedFetch(url, options, source.id),
      profile,
      searchTitles,
      searchCycle: sourceCycles[source.id] ?? 0,
      isHandled,
      sourceConfig: sourceConfigs.get(source.id),
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
      if (result.status === "rejected") errors.push({ source: requests[index].source.id, error: result.reason.message });
      else found.push(...result.value.map((item) => ({ ...item, source: requests[index].source.id })));
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

    const unhandledFound = found.filter((raw) => !isHandled(raw));
    const uniqueFound = [...new Map(unhandledFound
      .map((raw) => [`${raw.source}:${raw.externalId ?? raw.applyUrl}`, raw])).values()];
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
      if (scored.applicationDestinationPending) {
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
      const opportunity = await this.applicationService.addOpportunity({
        ...scored, ...(input.campaignId ? { lastCampaignId: input.campaignId } : {}),
        ...(input.reserveOnly && scored.applicationDestinationVerified
          ? { reserveObservedAt: new Date().toISOString(),
            reserveExpiresAt: new Date(Date.now() + 45 * 60_000).toISOString() } : {})
      }, identity, { serverVerifiedDiscovery: true,
        advisoryDiscovery: scored.discoveryRelease });
      const entry = { opportunity };
      const autoApplyDiscovered = input.prepareApplications === false ? false : modeConfig.autoApplyDiscovered;
      if (autoApplyDiscovered && scored.applicationDestinationPending) {
        entry.applicationBlockedBySource = "employer_application_url_required";
        telemetry.count("discovery.application_destination_pending", 1, { source: scored.source });
      } else if (autoApplyDiscovered && opportunity.discoveryRelease?.stage === "advisory") {
        entry.applicationBlockedBySource = "advisory_fit_review_required";
      } else if (autoApplyDiscovered && profileStatus.readyToApply) {
        try { entry.application = await this.applicationService.requestApplication(opportunity.id, {}, identity); }
        catch (error) {
          if (error.status !== 409) throw error;
          entry.application = this.applicationService.list("applications", identity.profileId)
            .find((item) => item.opportunityId === opportunity.id);
        }
      }
      if (autoApplyDiscovered && !profileStatus.readyToApply) {
        entry.applicationBlockedByProfile = profileStatus.missingForApplications;
      }
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
      errors,
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
      && completedBrowser.has(`${campaignId}:${sourceId}`)).length]));
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
    provenance: { importedBy: "campaign_browser_fallback", sourceUrl: capped(candidate.sourceUrl, 2000),
      employerLinkObserved: destinationObserved },
    uncertainties: Array.isArray(candidate.uncertainties)
      ? candidate.uncertainties.slice(0, 50).map((item) => String(item).slice(0, 200)) : []
  }, { source: sourceId });
}
