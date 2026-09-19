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

const SOURCES = new Map([remoteok, arbeitnow, jobicy, himalayas, greenhouse, ashby, lever].map((source) => [source.id, source]));

export class DiscoveryService {
  constructor({ applicationService, profiles, config, fetchImpl = fetch, enricher = null }) {
    this.applicationService = applicationService;
    this.profiles = profiles;
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.enricher = enricher;
  }

  async scan(input, identity) {
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
    const settled = await Promise.allSettled(selected.map((source) => source.search({
      limit: requestedLimit,
      fetchImpl: this.fetchImpl,
      profile,
      sourceConfig: this.config.discovery?.sourceOptions?.[source.id] ?? {},
      onError: (error) => internalErrors.push({ source: source.id, ...error })
    })));

    const errors = [...internalErrors];
    const found = [];
    for (let index = 0; index < settled.length; index += 1) {
      const result = settled[index];
      if (result.status === "rejected") errors.push({ source: selected[index].id, error: result.reason.message });
      else found.push(...result.value);
    }

    const normalizedFound = found.map((raw) => normalizeOpportunity(raw));
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
      if (modeConfig.autoApplyDiscovered && profileStatus.readyToApply) {
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
    telemetry.observe("discovery.jobs_found", found.length, { mode });
    return {
      mode,
      sources: requestedSources,
      found: found.length,
      qualifying: qualifying.length,
      excluded,
      readyToApply: profileStatus.readyToApply,
      missingForApplications: profileStatus.missingForApplications,
      errors,
      items: qualifying
    };
  }
}
