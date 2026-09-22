import { plainText } from "../text.js";

export const arbeitnow = {
  id: "arbeitnow",
  async search({ limit = 50, fetchImpl = fetch }) {
    const response = await fetchImpl("https://www.arbeitnow.com/api/job-board-api", {
      headers: { "user-agent": "job-application-server/0.2 (+private personal use)" },
      signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) throw new Error(`Arbeitnow returned HTTP ${response.status}`);
    const body = await response.json();
    return (body.data ?? []).slice(0, limit).map((row) => ({
      source: "arbeitnow",
      externalId: row.slug,
      title: row.title,
      company: row.company_name || "Unknown company",
      listingUrl: row.url,
      applyUrl: row.url,
      description: plainText(row.description),
      tags: [...(row.tags ?? []), ...(row.job_types ?? [])],
      location: row.location || (row.remote ? "Remote" : "Unknown"),
      remote: row.remote === true,
      employmentType: (row.job_types ?? []).join(", ") || "full_time",
      postedAt: row.created_at ? new Date(row.created_at * 1000).toISOString() : undefined
    }));
  }
};
