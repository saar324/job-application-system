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
import { handledRoleIndex, isHandledRole, roleKeys } from "./handled-roles.js";

const SOURCES = new Map([remoteok, arbeitnow, jobicy, himalayas, greenhouse, ashby, lever].map((source) => [source.id, source]));

export class DiscoveryService {
  constructor({ applicationService, profiles, config, fetchImpl = fetch, enricher = null }) {
    this.applicationService = applicationService;
    this.profiles = profiles;
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.enricher = enricher;
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
    const internalErrors = [];
    const handledKeys = handledRoleIndex(this.applicationService.store.snapshot(), identity.profileId);
    const handledMatches = new Set();
    const isHandled = (role) => {
      if (!isHandledRole(role, handledKeys)) return false;
      handledMatches.add([...roleKeys(role)][0] ?? role.applyUrl ?? role.listingUrl);
      return true;
    };
    const fetchStarted = performance.now();
    let requestCount = 0;
    const fetchCache = new Map();
    const cachedFetch = async (url, options) => {
      const key = String(url);
      if (!fetchCache.has(key)) {
        requestCount += 1;
        fetchCache.set(key, Promise.resolve(this.fetchImpl(url, options)));
      }
      return (await fetchCache.get(key)).clone();
    };
    const requests = selected.flatMap((source) => (input.queryPlan ?? [null]).map((query) => ({ source, query })));
    const settled = await Promise.allSettled(requests.map(({ source, query }) => source.search({
      limit: query?.limit ?? requestedLimit,
      query: query?.filters,
      fetchImpl: cachedFetch,
      profile,
      isHandled,
      sourceConfig: this.config.discovery?.sourceOptions?.[source.id] ?? {},
      onError: (error) => internalErrors.push({ source: source.id, ...error })
    })));
    telemetry.observe("discovery.fetch_ms", performance.now() - fetchStarted, { mode });
    telemetry.count("discovery.provider_requests", requestCount, { mode });

    const errors = [...internalErrors];
    const found = [];
    for (let index = 0; index < settled.length; index += 1) {
      const result = settled[index];
      if (result.status === "rejected") errors.push({ source: requests[index].source.id, error: result.reason.message });
      else found.push(...result.value);
    }

    const uniqueFound = [...new Map(found.filter((raw) => !isHandled(raw))
      .map((raw) => [`${raw.source}:${raw.externalId ?? raw.applyUrl}`, raw])).values()];
    const normalizedFound = uniqueFound.map((raw) => normalizeOpportunity(raw));
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
      const scored = { ...raw, mode, ...score,
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
        continue;
      }
      const opportunity = await this.applicationService.addOpportunity(scored, identity);
      const entry = { opportunity };
      if (modeConfig.autoApplyDiscovered && scored.applicationDestinationPending) {
        entry.applicationBlockedBySource = "employer_application_url_required";
        telemetry.count("discovery.application_destination_pending", 1, { source: scored.source });
      } else if (modeConfig.autoApplyDiscovered && profileStatus.readyToApply) {
        try { entry.application = await this.applicationService.requestApplication(opportunity.id, {}, identity); }
        catch (error) {
          if (error.status !== 409) throw error;
          entry.application = this.applicationService.list("applications", identity.profileId)
            .find((item) => item.opportunityId === opportunity.id);
        }
      }
      if (modeConfig.autoApplyDiscovered && !profileStatus.readyToApply) {
        entry.applicationBlockedByProfile = profileStatus.missingForApplications;
      }
      qualifying.push(entry);
    }
    telemetry.count("discovery.scans", 1, { mode, sourceCount: requestedSources.length });
    telemetry.count("discovery.source_failures", errors.length, { mode });
    telemetry.observe("discovery.jobs_found", uniqueFound.length, { mode });
    telemetry.observe("discovery.scan_ms", performance.now() - scanStarted, { mode });
    return {
      mode,
      sources: requestedSources,
      found: uniqueFound.length,
      handledFiltered: handledMatches.size,
      qualifying: qualifying.length,
      excluded,
      readyToApply: profileStatus.readyToApply,
      missingForApplications: profileStatus.missingForApplications,
      errors,
      items: qualifying
    };
  }
}
