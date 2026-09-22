import { plainText } from "../text.js";

export const remoteok = {
  id: "remoteok",
  async search({ limit = 50, fetchImpl = fetch }) {
    const response = await fetchImpl("https://remoteok.com/api", {
      headers: { "user-agent": "job-application-server/0.2 (+private personal use)" },
      signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) throw new Error(`Remote OK returned HTTP ${response.status}`);
    const rows = await response.json();
    return rows.filter((row) => row?.position && row?.id).slice(0, limit).map((row) => ({
      source: "remoteok",
      externalId: String(row.id),
      title: row.position,
      company: row.company || "Unknown company",
      listingUrl: row.url,
      applyUrl: row.apply_url || row.url,
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
