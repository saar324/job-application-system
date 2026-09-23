import { randomUUID } from "node:crypto";
import { resolveEmployerApplicationUrl } from "./application-destination.js";
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
import { fetchVerifiedOfficialAtsRole, officialAtsDestination, officialAtsIdentityFromUrl } from "./official-ats.js";

const SOURCES = new Map([remoteok, arbeitnow, jobicy, himalayas, greenhouse, ashby, lever].map((source) => [source.id, source]));
const atsBoardKey = (parsed) => parsed ? `${parsed.source}:${parsed.board}` : null;

export class DiscoveryService {
  constructor({ applicationService, profiles, config, fetchImpl = fetch, enricher = null }) {
    this.applicationService = applicationService;
    this.profiles = profiles;
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.enricher = enricher;
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

  async describeSources(identity, mode) {
    const profile = await this.profiles.get(identity.profileId);
    const selectedMode = mode ?? profile?.defaultMode ?? this.config.defaultMode;
    const settings = this.config.modes[selectedMode];
    if (!settings) throw Object.assign(new Error(`unknown mode: ${selectedMode}`), { status: 400 });
    const preference = selectedMode === "freelance"
      ? profile?.preferences?.freelance : profile?.preferences?.fullTime;
    const enabled = preference?.automatedDiscoverySources ?? settings.sources ?? [];
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
      configuredBoards: (this.config.discovery?.sourceOptions?.[id]?.boards
        ?? this.config.discovery?.sourceOptions?.[id]?.sites ?? []).map((item) => item.slug ?? item.token),
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
    await this.applicationService.createCampaign({
      id: campaignId, target, reserve, mode, sources: primarySources,
      fallbackSources, queryPlan: input.queryPlan, reserveOnly: input.reserveOnly === true
    }, identity);
    try {
      const scan = await this.scan({
        mode, sources: primarySources, queryPlan: input.queryPlan,
        limitPerSource: input.limitPerSource ?? (fallbackSources.length ? 10 : undefined),
        prepareApplications: false, campaignId, reserveOnly: input.reserveOnly === true,
        maxRequestsPerSource: input.maxRequestsPerSource
      }, identity);
      if (!input.reserveOnly && !scan.readyToApply) {
        throw Object.assign(new Error(`profile is missing application fields: ${scan.missingForApplications.join(", ")}`),
          { status: 409 });
      }
      const preloaded = input.reserveOnly ? [] : await this.#freshReserveCandidates(identity,
        await this.profiles.get(identity.profileId), mode,
        target + reserve);
      const ready = [...scan.items, ...preloaded].filter((entry) => !entry.opportunity.applicationDestinationPending
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
        sourceYield: scan.sourceYield.map((row) => ({ ...row,
          selected: selected.filter((entry) => entry.opportunity.source === row.sourceId).length })),
        durations: scan.durations,
        destinationPending: scan.items.length - ready.length,
        selectedOpportunityIds: selected.map((entry) => entry.opportunity.id),
        applicationIds, errors: scan.errors
      }, identity);
      if (input.reserveOnly && !fallbackSources.length) {
        return this.applicationService.finalizeCampaignSelection(campaignId, identity);
      }
      return recorded;
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
      if (score.scoreDetails.hardExclusion || score.score < this.config.modes[mode].minimumScore) {
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
      if (score.scoreDetails.hardExclusion || score.score < this.config.modes[mode].minimumScore) {
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
        || input.requestsMade < 0 || input.requestsMade > 1000))) {
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
        cooldownSkipped: true, cooldownReason: active.reason, cooldownUntil: active.until,
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
    const atsBackoffKeys = new Set(this.applicationService.store.snapshot().audit.filter((item) =>
      item.profileId === identity.profileId && item.action === "discovery.ats_backoff"
      && Date.parse(item.details?.nextAt) > Date.now()).map((item) => item.subjectId));
    let excluded = 0; let handledFiltered = 0; let qualifying = 0; let selected = 0;
    let destinationPending = 0;
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
        const officialIdentity = officialAtsIdentityFromUrl(raw.applyUrl);
        const listedIdentity = officialAtsIdentityFromUrl(raw.listingUrl);
        if (officialIdentity && listedIdentity && officialIdentity.key !== listedIdentity.key) {
          excluded += 1;
          exclusionReasons.set("official_ats_identity_mismatch",
            (exclusionReasons.get("official_ats_identity_mismatch") ?? 0) + 1);
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
          || (opportunistic ? !opportunisticQualified : scored.score < modeConfig.minimumScore)) {
          excluded += 1;
          const reason = scored.scoreDetails.hardExclusion ?? (opportunistic
            ? "opportunistic_requirements_not_met" : "score_below_minimum");
          exclusionReasons.set(reason, (exclusionReasons.get(reason) ?? 0) + 1);
          continue;
        }
        qualifying += 1;
        if (scored.applicationDestinationPending) {
          try { scored = await resolveEmployerApplicationUrl(scored, this.fetchImpl); }
          catch (error) { errors.push({ stage: "application_destination", error: error.message }); }
        }
        if (scored.applicationDestinationPending || !/^https:\/\//i.test(scored.applyUrl ?? "")) {
          destinationPending += 1;
          errors.push({ stage: "application_destination", error: "verified HTTPS employer application URL required" });
          continue;
        }
        eligible.push({ scored, serverVerifiedDiscovery: Boolean(official) });
      } catch (error) {
        errors.push({ stage: "candidate_import", error: String(error.message ?? error).slice(0, 500) });
      }
    }
    const opportunityIds = [];
    for (const { scored, serverVerifiedDiscovery } of eligible.sort((left, right) =>
      Number(right.scored.score ?? 0) - Number(left.scored.score ?? 0)
      || Date.parse(right.scored.postedAt ?? 0) - Date.parse(left.scored.postedAt ?? 0))
      .slice(0, remainingSourceSlots)) {
      const opportunity = await this.applicationService.addOpportunity({ ...scored, lastCampaignId: campaignId,
        ...(campaign.reserveOnly && serverVerifiedDiscovery
          ? { reserveObservedAt: new Date().toISOString(),
            reserveExpiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString() } : {}) },
        identity, { serverVerifiedDiscovery });
      opportunityIds.push(opportunity.id); selected += 1;
      for (const key of roleKeys(opportunity)) knownKeys.add(key);
    }
    const recorded = await this.applicationService.recordCampaignSourceScan(campaignId, {
      sourceId, found: input.items.length, qualifying, excluded, handledFiltered, selected,
      destinationPending,
      opportunityIds,
      exclusionReasons: [...exclusionReasons.entries()].map(([reason, count]) => ({ reason, count }))
        .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason)),
      completed: input.completed !== false, pagesVisited: input.pagesVisited, requestsMade: input.requestsMade,
      rateLimited: input.rateLimited === true, exhausted: input.exhausted === true,
      challenge: input.challenge === true, timedOut: input.timedOut === true,
      parseDrift: input.parseDrift === true,
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
      handledFiltered: 0, destinationPending: 0, selected: 0,
      exclusionCounts: { hardExclusion: 0, belowScore: 0, opportunisticRequirements: 0 }
    }]));
    const handledBySource = new Map();
    const internalErrors = [];
    const handledKeys = knownRoleIndex(this.applicationService.store.snapshot(), identity.profileId);
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
    const cachedFetch = async (url, options, sourceId) => {
      const key = String(url);
      if (!fetchCache.has(key)) {
        if (requestCount >= maxRequests) throw new Error("discovery request budget exhausted");
        if (sourceId && (requestsBySource.get(sourceId) ?? 0) >= maxRequestsPerSource) {
          throw new Error("source request budget exhausted");
        }
        requestCount += 1;
        if (sourceId) requestsBySource.set(sourceId, (requestsBySource.get(sourceId) ?? 0) + 1);
        fetchCache.set(key, Promise.resolve(this.fetchImpl(url, options)));
      }
      return (await fetchCache.get(key)).clone();
    };
    const requests = selected.flatMap((source) => (input.queryPlan ?? [null]).map((query) => ({ source, query })));
    const settled = await Promise.allSettled(requests.map(({ source, query }) => source.search({
      limit: query?.limit ?? requestedLimit,
      query: query?.filters,
      fetchImpl: (url, options) => cachedFetch(url, options, source.id),
      profile,
      isHandled,
      sourceConfig: this.config.discovery?.sourceOptions?.[source.id] ?? {},
      onError: (error) => internalErrors.push({ source: source.id, ...error })
    })));
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

    const uniqueFound = [...new Map(found.filter((raw) => !isHandled(raw))
      .map((raw) => [`${raw.source}:${raw.externalId ?? raw.applyUrl}`, raw])).values()];
    const normalizedFound = uniqueFound.map((raw) => normalizeOpportunity(raw));
    for (const raw of normalizedFound) {
      if (sourceYield.has(raw.source)) sourceYield.get(raw.source).found += 1;
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
    const semanticCandidates = new Set(preliminary
      .filter((entry) => !entry.result.scoreDetails.hardExclusion)
      .sort((left, right) => right.result.score - left.result.score)
      .slice(0, maximumSemantic).map((entry) => entry.index));
    const qualifying = [];
    let excluded = 0;
    for (let index = 0; index < normalizedFound.length; index += 1) {
      let raw = normalizedFound[index];
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
      if (scored.scoreDetails.hardExclusion
        || (opportunistic ? !opportunisticQualified : scored.score < modeConfig.minimumScore)) {
        excluded += 1;
        if (sourceYield.has(raw.source)) {
          const row = sourceYield.get(raw.source);
          row.excluded += 1;
          const kind = scored.scoreDetails.hardExclusion ? "hardExclusion"
            : opportunistic ? "opportunisticRequirements" : "belowScore";
          row.exclusionCounts[kind] += 1;
        }
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
      if (isHandled(scored)) {
        excluded += 1;
        if (sourceYield.has(raw.source)) sourceYield.get(raw.source).excluded += 1;
        continue;
      }
      if (sourceYield.has(raw.source)) {
        sourceYield.get(raw.source).qualifying += 1;
        if (scored.applicationDestinationPending) sourceYield.get(raw.source).destinationPending += 1;
        else sourceYield.get(raw.source).selected += 1;
      }
      const opportunity = await this.applicationService.addOpportunity({
        ...scored, ...(input.campaignId ? { lastCampaignId: input.campaignId } : {}),
        ...(input.reserveOnly && scored.applicationDestinationVerified
          ? { reserveObservedAt: new Date().toISOString(),
            reserveExpiresAt: new Date(Date.now() + 45 * 60_000).toISOString() } : {})
      }, identity, { serverVerifiedDiscovery: true });
      const entry = { opportunity };
      const autoApplyDiscovered = input.prepareApplications === false ? false : modeConfig.autoApplyDiscovered;
      if (autoApplyDiscovered && scored.applicationDestinationPending) {
        entry.applicationBlockedBySource = "employer_application_url_required";
        telemetry.count("discovery.application_destination_pending", 1, { source: scored.source });
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
      sourceYield: [...sourceYield.values()],
      durations: { fetchMs, screeningMs: Math.max(0, performance.now() - screeningStarted - destinationMs),
        destinationMs, totalMs: performance.now() - scanStarted },
      items: qualifying
    };
  }
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
    applicationDestinationVerified: destinationObserved,
    applicationDestinationPending: !destinationObserved,
    tags: Array.isArray(candidate.tags) ? candidate.tags.slice(0, 100).map((item) => String(item).slice(0, 100)) : [],
    compensation: candidate.compensation && typeof candidate.compensation === "object"
      ? candidate.compensation : undefined,
    provenance: { importedBy: "campaign_browser_fallback", sourceUrl: capped(candidate.sourceUrl, 2000) },
    uncertainties: Array.isArray(candidate.uncertainties)
      ? candidate.uncertainties.slice(0, 50).map((item) => String(item).slice(0, 200)) : []
  }, { source: sourceId });
}
