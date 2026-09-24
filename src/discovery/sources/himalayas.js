import { plainText } from "../text.js";
import { searchTitleQueryPlan } from "../search-title-queries.js";
import { needsEmployerApplyUrl } from "../application-destination.js";

function candidateCountry(profile) {
  const values = [
    profile?.contact?.location,
    ...(profile?.preferences?.fullTime?.allowedLocations ?? []),
    ...(profile?.preferences?.locations ?? [])
  ].filter((value) => typeof value === "string" && value.trim());
  for (const raw of values) {
    const value = raw.split(",").at(-1).trim();
    if (!/^(remote|eu|europe|emea|eea|worldwide|anywhere)$/i.test(value)) return value;
  }
  return undefined;
}

function postedAt(value) {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value * 1000).toISOString();
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

export const himalayas = {
  id: "himalayas",
  async search({ limit = 50, fetchImpl = fetch, profile, searchTitles = [],
    isHandled = () => false, query = {}, onError = () => {}, onStats = () => {}, searchCycle = 0 }) {
    const country = query.country ?? candidateCountry(profile);
    const plan = query.q ? { queries: [{ term: query.q, origin: "explicit" }],
      skippedTerms: [], coverageBlocked: false }
      : searchTitleQueryPlan(profile, searchTitles, { maximum: 16, cycle: searchCycle });
    const queries = plan.queries.map((item) => item.term);
    if (!queries.length) return [];
    const unique = new Map();
    const exhausted = new Set();
    const queryStats = new Map(queries.map((term) => [term,
      { term, pages: 0, rawRows: 0, uniqueRows: 0 }]));
    let rawRows = 0; let adapterPrescreenRejected = 0;
    const maxPagesPerQuery = 10;
    const maxRequests = Math.min(40, Math.max(2 * queries.length, Math.ceil(limit / 10)));
    let requests = 0;
    let fetchFailed = false;
    let rawPoolCapped = false;
    // Round-robin prevents the first title variant from consuming the page
    // budget before other configured variants receive a first page.
    outer: for (let page = 1; page <= maxPagesPerQuery; page += 1) {
      for (const term of queries) {
        if (exhausted.has(term)) continue;
        if (requests >= maxRequests) break outer;
        const url = new URL("https://himalayas.app/jobs/api/search");
        if (country) url.searchParams.set("country", country.toLowerCase());
        url.searchParams.set("q", term);
        for (const key of ["worldwide", "exclude_worldwide", "seniority", "employment_type",
          "company", "timezone", "sort"]) {
          if (query[key]) url.searchParams.set(key, query[key]);
        }
        if (!query.sort) url.searchParams.set("sort", "recent");
        url.searchParams.set("page", String(page));
        let body;
        try {
          requests += 1;
          const response = await fetchImpl(url, {
            headers: { "user-agent": "job-application-server/0.2 (+private personal use)" },
            signal: AbortSignal.timeout(20_000)
          });
          if (!response.ok) throw new Error(`Himalayas returned HTTP ${response.status}`);
          body = await response.json();
        } catch (error) {
          if (!unique.size) throw error;
          onError({ stage: "pagination", term, page,
            reason: "partial_fetch_failure", error: error.message });
          fetchFailed = true;
          break outer;
        }
        const batch = body.jobs ?? [];
        const stats = queryStats.get(term);
        stats.pages += 1;
        stats.rawRows += batch.length;
        rawRows += batch.length;
        for (const row of batch) {
          if (!row?.title || !row?.applicationLink) {
            adapterPrescreenRejected += 1;
            continue;
          }
          const id = String(row.guid ?? row.applicationLink);
          if (unique.has(id) || isHandled({ source: "himalayas", externalId: id,
            applyUrl: row.applicationLink, listingUrl: row.applicationLink })) continue;
          unique.set(id, row);
          stats.uniqueRows += 1;
        }
        if (body.pagination?.hasMore === false || batch.length < 20) exhausted.add(term);
      }
      if (page >= 2 && unique.size >= limit) { rawPoolCapped = true; break; }
    }
    if (rawPoolCapped && exhausted.size < queries.length) {
      onError({ stage: "selection", reason: "partial_raw_pool_cap",
        rawRows: unique.size, requestsMade: requests });
    } else if (!fetchFailed && requests >= maxRequests && exhausted.size < queries.length) {
      onError({ stage: "pagination", reason: "partial_request_cap", requestsMade: requests });
    } else if (!fetchFailed && exhausted.size < queries.length && unique.size < limit) {
      onError({ stage: "pagination", reason: "partial_page_cap", pagesPerQuery: maxPagesPerQuery });
    }
    onStats({ rawRows, adapterPrescreenRejected, pagesVisited: requests,
      queryStats: [...queryStats.values()], skippedTerms: plan.skippedTerms,
      coverageBlocked: plan.coverageBlocked });
    return [...unique.values()].slice(0, limit).map((row) => ({
      source: "himalayas",
      externalId: String(row.guid ?? row.applicationLink),
      title: row.title,
      company: row.companyName || "Unknown company",
      listingUrl: row.applicationLink,
      applyUrl: row.applicationLink,
      applicationDestinationPending: needsEmployerApplyUrl(row.applicationLink, "himalayas.app"),
      description: plainText(row.description || row.excerpt),
      tags: [
        ...(row.categories ?? []),
        ...(row.parentCategories ?? []),
        ...(row.seniority ?? [])
      ],
      location: row.locationRestrictions?.length
        ? row.locationRestrictions.join(", ")
        : "Worldwide",
      remote: true,
      employmentType: row.employmentType,
      postedAt: postedAt(row.pubDate),
      compensation: row.minSalary || row.maxSalary
        ? {
            minimum: row.minSalary || undefined,
            maximum: row.maxSalary || undefined,
            currency: row.currency,
            period: row.salaryPeriod
          }
        : undefined
    }));
  }
};
