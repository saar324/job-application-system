import { plainText } from "../text.js";
import { profileSearchTerms } from "../title-preferences.js";
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
  async search({ limit = 50, fetchImpl = fetch, profile, query = {} }) {
    const country = query.country ?? candidateCountry(profile);
    const queries = query.q ? [query.q] : profileSearchTerms(profile);
    if (!queries.length) return [];
    const perQuery = Math.max(1, Math.ceil(Math.min(limit, 200) / queries.length));
    const jobs = [];
    for (const term of queries) {
      const pages = Math.ceil(perQuery / 20);
      for (let page = 1; page <= pages; page += 1) {
        const url = new URL("https://himalayas.app/jobs/api/search");
        if (country) url.searchParams.set("country", country.toLowerCase());
        url.searchParams.set("q", term);
        for (const key of ["worldwide", "exclude_worldwide", "seniority", "employment_type",
          "company", "timezone", "sort"]) {
          if (query[key]) url.searchParams.set(key, query[key]);
        }
        if (!query.sort) url.searchParams.set("sort", "recent");
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
