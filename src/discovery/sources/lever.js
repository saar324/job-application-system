import { discoveryTitleRelevant } from "../title-preferences.js";
import { normalizeApplicationQuestions } from "../normalization.js";

function configuredSites(sourceConfig) {
  const sites = sourceConfig?.sites ?? [];
  if (!Array.isArray(sites)) throw new Error("Lever sourceOptions.sites must be an array");
  return sites.filter((site) => site && typeof site.slug === "string" && site.slug.trim())
    .map((site) => ({ slug: site.slug.trim(), company: site.company?.trim() || site.slug.trim() }));
}

function descriptionOf(job) {
  const lists = (job.lists ?? []).map((item) => `${item.text ?? ""} ${item.content ?? ""}`).join(" ");
  return `${job.descriptionPlain ?? ""} ${job.additionalPlain ?? ""} ${lists}`;
}

export const lever = {
  id: "lever",
  async search({ limit = 50, fetchImpl = fetch, profile, sourceConfig, query = {},
    isHandled = () => false, onError = () => {} }) {
    const sites = configuredSites(sourceConfig).filter((site) => !query.board || site.slug === query.board);
    const settled = await Promise.allSettled(sites.map(async (site) => {
      const url = new URL(`https://api.lever.co/v0/postings/${site.slug}`);
      url.searchParams.set("mode", "json");
      for (const key of ["location", "team", "department", "commitment", "level"]) {
        for (const value of (Array.isArray(query[key]) ? query[key] : query[key] ? [query[key]] : [])) {
          url.searchParams.append(key, value);
        }
      }
      const response = await fetchImpl(url, {
        headers: { "user-agent": "job-application-system/0.1" },
        signal: AbortSignal.timeout(20_000)
      });
      if (!response.ok) throw new Error(`Lever ${site.slug} returned HTTP ${response.status}`);
      const jobs = await response.json();
      return jobs.map((job) => ({ site, job }));
    }));
    settled.forEach((result, index) => {
      if (result.status === "rejected") onError({ board: sites[index]?.slug, error: result.reason.message });
    });
    return settled
      .flatMap((result) => result.status === "fulfilled" ? result.value : [])
      .filter(({ site, job }) => job?.id && job?.text && job?.applyUrl && job.workplaceType === "remote"
        && discoveryTitleRelevant(job.text, profile)
        && ["location", "team", "department", "commitment", "level"].every((key) => {
          if (!query[key]) return true;
          const allowed = Array.isArray(query[key]) ? query[key] : [query[key]];
          const actual = key === "location" ? (job.categories?.allLocations ?? [job.categories?.location])
            : [job.categories?.[key]];
          return actual.some((value) => allowed.includes(value));
        }) && !isHandled({ source: "lever", externalId: `${site.slug}:${job.id}`,
          applyUrl: job.applyUrl, listingUrl: job.hostedUrl }))
      .sort((left, right) => Date.parse(right.job.createdAt ?? "") - Date.parse(left.job.createdAt ?? ""))
      .slice(0, limit)
      .map(({ site, job }) => ({
        source: "lever",
        externalId: `${site.slug}:${job.id}`,
        title: job.text,
        company: site.company,
        listingUrl: job.hostedUrl,
        applyUrl: job.applyUrl,
        description: descriptionOf(job),
        tags: [job.categories?.department, job.categories?.team].filter(Boolean),
        location: (job.categories?.allLocations ?? [job.categories?.location]).filter(Boolean).join(", ") || "Remote",
        remote: true,
        employmentType: job.categories?.commitment || "Full-Time",
        postedAt: job.createdAt,
        applicationQuestions: normalizeApplicationQuestions(job.applicationQuestions ?? job.questions ?? [])
      }));
  }
};
