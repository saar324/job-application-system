import { plainText } from "../text.js";
import { preferredTitleGroups } from "../title-preferences.js";

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

function searchQueries(profile) {
  const groups = preferredTitleGroups(profile);
  const preferred = groups.primary.length
    ? groups.primary
    : profile?.preferences?.jobTitles ?? [];
  const primaryValues = [...preferred]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim());
  const primary = [...new Map(primaryValues.map((value) => [value.toLowerCase(), value])).values()].slice(0, 8);
  const secondary = groups.secondary
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim()).slice(0, 4);
  return [...new Map([...primary, ...secondary].map((value) => [value.toLowerCase(), value])).values()];
}

export const himalayas = {
  id: "himalayas",
  async search({ limit = 50, fetchImpl = fetch, profile }) {
    const country = candidateCountry(profile);
    const queries = searchQueries(profile);
    if (!queries.length) return [];
    const perQuery = Math.max(1, Math.ceil(Math.min(limit, 200) / queries.length));
    const jobs = [];
    for (const query of queries) {
      const pages = Math.ceil(perQuery / 20);
      for (let page = 1; page <= pages; page += 1) {
        const url = new URL("https://himalayas.app/jobs/api/search");
        if (country) url.searchParams.set("country", country.toLowerCase());
        url.searchParams.set("q", query);
        url.searchParams.set("sort", "recent");
        url.searchParams.set("page", String(page));
        const response = await fetchImpl(url, {
          headers: { "user-agent": "job-application-server/0.2 (+private personal use)" },
          signal: AbortSignal.timeout(20_000)
        });
        if (!response.ok) throw new Error(`Himalayas returned HTTP ${response.status}`);
        const body = await response.json();
        jobs.push(...(body.jobs ?? []));
        if (!(body.jobs ?? []).length || page * 20 >= perQuery) break;
      }
    }
    const unique = [...new Map(jobs
      .filter((row) => row?.title && row?.applicationLink)
      .map((row) => [String(row.guid ?? row.applicationLink), row])).values()];
    return unique.slice(0, limit).map((row) => ({
      source: "himalayas",
      externalId: String(row.guid ?? row.applicationLink),
      title: row.title,
      company: row.companyName || "Unknown company",
      listingUrl: row.applicationLink,
      applyUrl: row.applicationLink,
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
