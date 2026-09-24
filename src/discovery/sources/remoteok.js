import { plainText } from "../text.js";
import { needsEmployerApplyUrl } from "../application-destination.js";

export const remoteok = {
  id: "remoteok",
  async search({ limit = 50, fetchImpl = fetch, isHandled = () => false,
    onError = () => {}, onStats = () => {} }) {
    const response = await fetchImpl("https://remoteok.com/api", {
      headers: { "user-agent": "job-application-server/0.2 (+private personal use)" },
      signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) throw new Error(`Remote OK returned HTTP ${response.status}`);
    const rows = await response.json();
    onStats({ rawRows: rows.length, pagesVisited: 1,
      adapterPrescreenRejected: rows.filter((row) => !row?.position || !row?.id).length });
    const selected = rows.filter((row) => row?.position && row?.id)
      .filter((row) => !isHandled({ source: "remoteok", externalId: String(row.id),
        applyUrl: row.apply_url || row.url, listingUrl: row.url }));
    if (selected.length > limit) onError({ stage: "selection", reason: "partial_raw_pool_cap",
      rawRows: selected.length, omittedRows: selected.length - limit });
    return selected.slice(0, limit).map((row) => ({
      source: "remoteok",
      externalId: String(row.id),
      title: row.position,
      company: row.company || "Unknown company",
      listingUrl: row.url,
      applyUrl: row.apply_url || row.url,
      applicationDestinationPending: needsEmployerApplyUrl(row.apply_url || row.url, "remoteok.com"),
      description: plainText(row.description),
      tags: row.tags ?? [],
      location: row.location || "Remote",
      remote: true,
      employmentType: "full_time",
      postedAt: row.date,
      compensation: row.salary_min || row.salary_max
        ? { minimum: row.salary_min || undefined, maximum: row.salary_max || undefined, period: "year", currency: "USD" }
        : undefined
    }));
  }
};
