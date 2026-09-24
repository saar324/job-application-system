import { plainText } from "../text.js";
import { searchTitleQueryPlan } from "../search-title-queries.js";
import { needsEmployerApplyUrl } from "../application-destination.js";

export const jobicy = {
  id: "jobicy",
  async search({ limit = 50, fetchImpl = fetch, profile, searchTitles = [], isHandled = () => false,
    onError = () => {}, onStats = () => {}, searchCycle = 0 }) {
    const plan = searchTitleQueryPlan(profile, searchTitles, { maximum: 16, cycle: searchCycle });
    const tags = plan.queries.map((item) => item.term);
    if (!tags.length) return [];
    // This feed has no page parameter. Fetch a bounded raw pool for each term;
    // dividing the output cap by the number of terms hides late handled rows.
    const count = 200;
    const rows = [];
    const queryStats = [];
    for (const tag of tags) {
      const url = new URL("https://jobicy.com/api/v2/remote-jobs");
      url.searchParams.set("count", String(count));
      url.searchParams.set("tag", tag);
      let body;
      try {
        const response = await fetchImpl(url, {
          headers: { "user-agent": "job-application-server/0.2 (+self-hosted)" },
          signal: AbortSignal.timeout(20_000)
        });
        if (!response.ok) throw new Error(`Jobicy returned HTTP ${response.status}`);
        body = await response.json();
      } catch (error) {
        if (!rows.length) throw error;
        onError({ stage: "query", term: tag, reason: "partial_fetch_failure",
          error: error.message });
        break;
      }
      const batch = body.jobs ?? [];
      rows.push(...batch);
      queryStats.push({ term: tag, pages: 1, rawRows: batch.length,
        uniqueRows: new Set(batch.map((item) => String(item.id ?? "")).filter(Boolean)).size });
      if (batch.length >= count) onError({ stage: "pagination", term: tag,
        reason: "partial_response_cap", rawRows: batch.length });
    }
    const unique = [...new Map(rows.filter((row) => row?.id)
      .filter((row) => !isHandled({ source: "jobicy", externalId: String(row.id),
        applyUrl: row.url, listingUrl: row.url }))
      .map((row) => [String(row.id), row])).values()];
    if (unique.length > limit) onError({ stage: "selection", reason: "partial_raw_pool_cap",
      rawRows: unique.length, omittedRows: unique.length - limit });
    onStats({ rawRows: rows.length, pagesVisited: queryStats.length,
      adapterPrescreenRejected: rows.filter((row) => !row?.id).length,
      queryStats, skippedTerms: plan.skippedTerms,
      coverageBlocked: plan.coverageBlocked });
    return unique.slice(0, limit).map((row) => ({
      source: "jobicy",
      externalId: String(row.id),
      title: row.jobTitle,
      company: row.companyName || "Unknown company",
      listingUrl: row.url,
      applyUrl: row.url,
      applicationDestinationPending: needsEmployerApplyUrl(row.url, "jobicy.com"),
      description: plainText(row.jobDescription || row.jobExcerpt),
      tags: [...(row.jobIndustry ?? []), ...(row.jobType ?? [])],
      location: row.jobGeo || "Remote",
      remote: true,
      employmentType: (row.jobType ?? []).join(", ") || "full_time",
      postedAt: row.pubDate,
      compensation: row.salaryMin || row.salaryMax
        ? {
            minimum: row.salaryMin || undefined, maximum: row.salaryMax || undefined,
            currency: row.salaryCurrency, period: row.salaryPeriod
          }
        : undefined
    }));
  }
};
