import { plainText } from "../text.js";
import { preferredTitleGroups } from "../title-preferences.js";
import { needsEmployerApplyUrl } from "../application-destination.js";

export const jobicy = {
  id: "jobicy",
  async search({ limit = 50, fetchImpl = fetch, profile }) {
    const groups = preferredTitleGroups(profile);
    const preferred = groups.primary.length
      ? groups.primary
      : profile?.preferences?.jobTitles ?? [];
    const primary = [...new Map(preferred
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => [value.trim().toLowerCase(), value.trim()])).values()].slice(0, 8);
    const secondary = groups.secondary
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => value.trim()).slice(0, 4);
    const tags = [...new Map([...primary, ...secondary]
      .map((value) => [value.toLowerCase(), value])).values()];
    if (!tags.length) return [];
    const count = Math.max(1, Math.ceil(Math.min(limit, 200) / tags.length));
    const rows = [];
    for (const tag of tags) {
      const url = new URL("https://jobicy.com/api/v2/remote-jobs");
      url.searchParams.set("count", String(Math.min(count, 200)));
      url.searchParams.set("tag", tag);
      const response = await fetchImpl(url, {
        headers: { "user-agent": "job-application-server/0.2 (+self-hosted)" },
        signal: AbortSignal.timeout(20_000)
      });
      if (!response.ok) throw new Error(`Jobicy returned HTTP ${response.status}`);
      const body = await response.json();
      rows.push(...(body.jobs ?? []));
    }
    const unique = [...new Map(rows.filter((row) => row?.id).map((row) => [String(row.id), row])).values()];
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
