import { plainText } from "../text.js";
import { needsEmployerApplyUrl } from "../application-destination.js";

export const arbeitnow = {
  id: "arbeitnow",
  async search({ limit = 50, fetchImpl = fetch, isHandled = () => false, onError = () => {},
    onStats = () => {} }) {
    const origin = "https://www.arbeitnow.com";
    const path = "/api/job-board-api";
    let next = `${origin}${path}`;
    const visited = new Set();
    const unique = new Map();
    let rawRows = 0; let adapterPrescreenRejected = 0;
    const maxPages = 3;
    for (let page = 0; next && page < maxPages && unique.size < limit; page += 1) {
      const url = new URL(next, origin);
      // Follow only this provider's API pages; never fetch a returned third-party URL.
      if (url.origin !== origin || url.pathname !== path || visited.has(url.href)) {
        onError({ stage: "pagination", reason: "invalid_next_page" });
        break;
      }
      visited.add(url.href);
      let body;
      try {
        const response = await fetchImpl(url.href, {
          headers: { "user-agent": "job-application-server/0.2 (+private personal use)" },
          signal: AbortSignal.timeout(20_000)
        });
        if (!response.ok) throw new Error(`Arbeitnow returned HTTP ${response.status}`);
        body = await response.json();
      } catch (error) {
        if (!unique.size) throw error;
        onError({ stage: "pagination", reason: "partial_fetch_failure", error: error.message });
        break;
      }
      const batch = body.data ?? [];
      rawRows += batch.length;
      for (const row of batch) {
        if (!row?.slug || !row?.title) { adapterPrescreenRejected += 1; continue; }
        if (unique.has(row.slug)
          || isHandled({ source: "arbeitnow", externalId: row.slug,
            applyUrl: row.url, listingUrl: row.url })) continue;
        unique.set(row.slug, row);
      }
      next = body.links?.next ?? null;
      if (next && page + 1 >= maxPages && unique.size < limit) {
        onError({ stage: "pagination", reason: "partial_page_cap", pagesVisited: maxPages });
      }
    }
    if (next && unique.size >= limit) onError({ stage: "selection",
      reason: "partial_raw_pool_cap", rawRows: unique.size });
    onStats({ rawRows, adapterPrescreenRejected, pagesVisited: visited.size });
    return [...unique.values()].slice(0, limit).map((row) => ({
      source: "arbeitnow",
      externalId: row.slug,
      title: row.title,
      company: row.company_name || "Unknown company",
      listingUrl: row.url,
      applyUrl: row.url,
      applicationDestinationPending: needsEmployerApplyUrl(row.url, "arbeitnow.com"),
      description: plainText(row.description),
      tags: [...(row.tags ?? []), ...(row.job_types ?? [])],
      location: row.location || (row.remote ? "Remote" : "Unknown"),
      remote: row.remote === true,
      employmentType: (row.job_types ?? []).join(", ") || "full_time",
      postedAt: row.created_at ? new Date(row.created_at * 1000).toISOString() : undefined
    }));
  }
};
