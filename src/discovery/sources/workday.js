import { plainText } from "../text.js";
import { normalizeEmploymentType } from "../normalization.js";
import { labeledAnnualSalary } from "../labeled-compensation.js";
import { searchTitleQueryPlan } from "../search-title-queries.js";
import { legacyDiscoveryTitleRelevant } from "../title-preferences.js";
import { workdayExternalPath, workdayPostingKey, workdayRoleUrls, workdaySite } from "../workday-identity.js";

// Workday's search endpoint is the careers site's own backend, not a documented
// API. It pages at 20 rows without descriptions, so every scan is bounded here.
// Private config cannot raise these limits.
export const WORKDAY_PAGE_SIZE = 20;
export const WORKDAY_LIMITS = Object.freeze({ termsPerSite: 4, pagesPerTerm: 3, detailsPerSite: 15,
  requestsPerScan: 120 });
const MAX_BODY_CHARS = 2 * 1024 * 1024;
const HEADERS = { "user-agent": "job-application-system/0.2", accept: "application/json" };
const REMOTE_TYPES = new Set(["remote", "fully remote"]);
const NON_REMOTE_TYPES = new Set(["flex", "flexible", "hybrid", "onsite", "on-site", "on site", "office"]);
const MULTIPLE_LOCATIONS = /^\d+\s+locations?$/i;

function configuredSites(sourceConfig) {
  const sites = sourceConfig?.sites ?? [];
  if (!Array.isArray(sites)) throw new Error("Workday sourceOptions.sites must be an array");
  return sites.map((entry) => {
    const site = workdaySite(entry?.url);
    return site && { ...site, company: typeof entry?.company === "string" ? entry.company.trim() : "" };
  }).filter(Boolean);
}

// A location names remote work only when one of its comma- or dash-separated
// parts is exactly "Remote", as in "US, Remote" or "Remote - Germany".
function namesRemote(location) {
  return typeof location === "string"
    && location.split(/\s*,\s*|\s+[-–—]\s+/).some((part) => part.trim().toLowerCase() === "remote");
}

function remoteTypeOf(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

// Tenants define their own remoteType values. Unknown ones are not remote, and
// are counted so an operator can see when a tenant needs a rule.
function unrecognizedRemoteType(value) {
  const type = remoteTypeOf(value);
  return Boolean(type) && !REMOTE_TYPES.has(type) && !NON_REMOTE_TYPES.has(type);
}

// Remote needs an explicit employer statement: a remote remoteType, or, when
// the tenant sets none, "Remote" in every location. One office makes it not remote.
export function workdayRemote(remoteType, locations) {
  const type = remoteTypeOf(remoteType);
  if (type) return REMOTE_TYPES.has(type);
  return locations.length > 0 && locations.every(namesRemote);
}

// "Posted Today", "Posted Yesterday", "Posted 3 Days Ago", "Posted 30+ Days Ago".
function postedAgeDays(value) {
  const text = String(value ?? "").toLowerCase();
  if (/\btoday\b/.test(text)) return 0;
  if (/\byesterday\b/.test(text)) return 1;
  const days = /(\d+)\+?\s+days?\s+ago/.exec(text);
  return days ? Number(days[1]) + (text.includes("+") ? 0.5 : 0) : Number.POSITIVE_INFINITY;
}

async function readJson(response, site, label) {
  const text = await response.text();
  if (text.length > MAX_BODY_CHARS) throw new Error(`Workday ${site.key} returned an oversized ${label} response`);
  try { return JSON.parse(text); } catch {
    throw new Error(`Workday ${site.key} returned invalid_official_response (non-JSON body, possible challenge)`);
  }
}

async function searchPage(site, term, offset, fetchImpl) {
  const response = await fetchImpl(`${site.origin}/wday/cxs/${site.tenant}/${site.site}/jobs`, {
    method: "POST",
    headers: { ...HEADERS, "content-type": "application/json" },
    body: JSON.stringify({ appliedFacets: {}, limit: WORKDAY_PAGE_SIZE, offset, searchText: term }),
    signal: AbortSignal.timeout(20_000)
  });
  if (response.status === 404) throw new Error(`Workday ${site.key} returned HTTP 404 (unknown site)`);
  if (!response.ok) throw new Error(`Workday ${site.key} returned HTTP ${response.status}`);
  const body = await readJson(response, site, "search");
  if (!body || !Array.isArray(body.jobPostings)) {
    throw new Error(`Workday ${site.key} returned invalid_official_response`);
  }
  return body;
}

async function readDetail(site, externalPath, fetchImpl) {
  const response = await fetchImpl(new URL(`/wday/cxs/${site.tenant}/${site.site}${externalPath}`, site.origin).href, {
    headers: HEADERS, signal: AbortSignal.timeout(10_000) });
  if (response.status === 404 || response.status === 410) return null;
  if (!response.ok) throw new Error(`Workday ${site.key} returned HTTP ${response.status}`);
  const body = await readJson(response, site, "detail");
  const info = body?.jobPostingInfo;
  if (!info || typeof info !== "object" || typeof info.title !== "string"
    || (typeof info.externalPath !== "string" && typeof info.externalUrl !== "string")) {
    throw new Error(`Workday ${site.key} returned invalid_official_response`);
  }
  return info;
}

export const workday = {
  id: "workday",
  async search({ limit = 50, fetchImpl = fetch, profile, searchTitles = [], searchCycle = 0,
    sourceConfig, query = {}, isHandled = () => false, onError = () => {}, onStats = () => {} }) {
    const requested = typeof query.board === "string" ? query.board.replace(/^[^/]*/, (tenant) => tenant.toLowerCase()) : null;
    const configured = configuredSites(sourceConfig).filter((site) => !query.board || site.key === requested);
    // Rotate the site order by cycle so a long list is not starved at the tail.
    const cycle = Number.isInteger(searchCycle) && searchCycle >= 0 ? searchCycle : 0;
    const start = configured.length ? cycle % configured.length : 0;
    const sites = [...configured.slice(start), ...configured.slice(0, start)];
    // Workday matches searchText on the server. An empty term would list the
    // whole site, so a query title or the shared title plan is required.
    const plan = query.title ? { queries: [{ term: query.title }], skippedTerms: [], coverageBlocked: false }
      : searchTitleQueryPlan(profile, searchTitles, { maximum: WORKDAY_LIMITS.termsPerSite, cycle });
    const terms = [...new Set(plan.queries.map((item) => String(item.term ?? "").trim()).filter(Boolean))]
      .slice(0, WORKDAY_LIMITS.termsPerSite);
    if (!sites.length || !terms.length) return [];

    const stats = { rawRows: 0, adapterPrescreenRejected: 0, pagesVisited: 0, detailReads: 0,
      unrecognizedRemoteType: 0 };
    let requests = 0;
    const claimRequest = () => {
      if (requests >= WORKDAY_LIMITS.requestsPerScan) return false;
      requests += 1;
      return true;
    };
    const claimedRoles = new Set();
    const capped = (site, stage, details) => onError({ board: site.key, stage,
      reason: "partial_response_cap", ...details });
    const titleAllowed = (title) => (!query.title || title.toLowerCase().includes(query.title.toLowerCase()))
      && (!profile || legacyDiscoveryTitleRelevant(title, profile));
    const rowPrescreen = (row) => {
      const type = remoteTypeOf(row.remoteType);
      if (type) {
        if (unrecognizedRemoteType(type)) stats.unrecognizedRemoteType += 1;
        return REMOTE_TYPES.has(type);
      }
      const locations = typeof row.locationsText === "string" ? row.locationsText.trim() : "";
      return !locations || MULTIPLE_LOCATIONS.test(locations) || namesRemote(locations);
    };

    const readSite = async (site) => {
      const rows = [];
      let searchCapped = null;
      // A failed search fails the site; the service budget running out only truncates it.
      const budgeted = async (request) => {
        try { return await request(); } catch (error) {
          if (error?.notSent) return undefined;
          throw error;
        }
      };
      terms: for (const term of terms) {
        let total = null;
        for (let page = 0; ; page += 1) {
          if (!claimRequest()) { searchCapped = { requestsPerScan: WORKDAY_LIMITS.requestsPerScan }; break terms; }
          const body = await budgeted(() => searchPage(site, term, page * WORKDAY_PAGE_SIZE, fetchImpl));
          if (!body) { searchCapped = { sourceRequestBudget: true }; break terms; }
          stats.pagesVisited += 1;
          const batch = body.jobPostings;
          stats.rawRows += batch.length;
          // Only the first page reports a total; later pages report 0.
          if (page === 0 && Number.isFinite(body.total) && body.total > 0) total = body.total;
          for (const row of batch) rows.push(row);
          const offset = (page + 1) * WORKDAY_PAGE_SIZE;
          if (batch.length < WORKDAY_PAGE_SIZE || (total !== null && offset >= total)) break;
          if (page + 1 >= WORKDAY_LIMITS.pagesPerTerm) {
            searchCapped ??= { pagesPerTerm: WORKDAY_LIMITS.pagesPerTerm };
            break;
          }
        }
      }
      if (searchCapped) capped(site, "pagination", searchCapped);

      const candidates = [];
      for (const row of rows) {
        const externalPath = workdayExternalPath(row?.externalPath);
        const postingKey = externalPath && workdayPostingKey(externalPath);
        const title = typeof row?.title === "string" ? row.title.trim() : "";
        // One requisition is one role across terms and across sites of a tenant.
        const roleKey = postingKey ? `workday:${site.tenant}:${postingKey}` : `${site.key}:${row?.externalPath}`;
        if (claimedRoles.has(roleKey)) continue;
        claimedRoles.add(roleKey);
        if (!postingKey || !title || !titleAllowed(title)) { stats.adapterPrescreenRejected += 1; continue; }
        const role = { source: "workday", externalId: `${site.key}:${postingKey}`,
          ...workdayRoleUrls(site, externalPath) };
        if (isHandled(role)) continue;
        if (!rowPrescreen(row)) { stats.adapterPrescreenRejected += 1; continue; }
        candidates.push({ row, externalPath, postingKey, role, age: postedAgeDays(row.postedOn) });
      }
      candidates.sort((left, right) => left.age - right.age);
      if (candidates.length > WORKDAY_LIMITS.detailsPerSite) {
        capped(site, "detail", { rawRows: candidates.length, detailsPerSite: WORKDAY_LIMITS.detailsPerSite });
      }

      const results = [];
      for (const [index, candidate] of candidates.slice(0, WORKDAY_LIMITS.detailsPerSite).entries()) {
        if (!claimRequest()) { capped(site, "requests", { requestsPerScan: WORKDAY_LIMITS.requestsPerScan }); break; }
        let info;
        try {
          info = await budgeted(() => readDetail(site, candidate.externalPath, fetchImpl));
          if (info === undefined) { capped(site, "requests", { sourceRequestBudget: true, detailsRead: index }); break; }
        } catch (error) {
          onError({ board: site.key, stage: "detail", error: error.message });
          // A restricted host stays blocked for the rest of the scan.
          if (/returned HTTP (403|429)\b/.test(error.message)) break;
          continue;
        }
        stats.detailReads += 1;
        const role = info && normalize(site, candidate, info, stats);
        if (role && (!query.location || role.location.toLowerCase().includes(query.location.toLowerCase()))) {
          results.push(role);
        } else stats.adapterPrescreenRejected += 1;
      }
      return results;
    };

    const settled = await Promise.allSettled(sites.map(readSite));
    settled.forEach((result, index) => {
      if (result.status === "rejected") onError({ board: sites[index].key, error: result.reason.message });
    });
    const selected = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    onStats({ ...stats, skippedTerms: plan.skippedTerms, coverageBlocked: plan.coverageBlocked });
    if (selected.length > limit) onError({ stage: "selection", reason: "partial_response_cap",
      rawRows: selected.length });
    return selected.slice(0, limit);
  }
};

function normalize(site, { row, externalPath, postingKey }, info, stats) {
  if (info.posted !== true || info.canApply !== true) return null;
  const title = info.title.trim();
  const detailKey = workdayPostingKey(info.jobPostingId);
  if (!title || (detailKey && detailKey !== postingKey)) return null;
  const locations = [...new Set([info.location, ...(Array.isArray(info.additionalLocations) ? info.additionalLocations : [])]
    .filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))];
  // The detail decides; a list row's remoteType fills in only when it has none.
  const type = remoteTypeOf(info.remoteType) ? info.remoteType : row.remoteType;
  if (!remoteTypeOf(row.remoteType) && unrecognizedRemoteType(info.remoteType)) stats.unrecognizedRemoteType += 1;
  if (!workdayRemote(type, locations)) return null;
  // Workday states contract status only as a facet, so timeType gives full or part time, or nothing.
  const employmentType = normalizeEmploymentType(info.timeType);
  const description = typeof info.jobDescription === "string" ? info.jobDescription : "";
  return {
    source: "workday",
    externalId: `${site.key}:${postingKey}`,
    title,
    // hiringOrganization names a legal entity, not the employer people know.
    company: site.company || site.tenant,
    ...workdayRoleUrls(site, externalPath),
    description: plainText(description),
    compensation: labeledAnnualSalary(description),
    tags: [],
    location: locations.join("; "),
    remote: true,
    employmentType: ["full_time", "part_time"].includes(employmentType) ? employmentType : undefined,
    postedAt: typeof info.startDate === "string" && info.startDate ? info.startDate : undefined,
    applicationQuestions: []
  };
}
