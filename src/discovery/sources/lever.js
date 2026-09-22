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
  async search({ limit = 50, fetchImpl = fetch, profile, sourceConfig, onError = () => {} }) {
    const sites = configuredSites(sourceConfig);
    const settled = await Promise.allSettled(sites.map(async (site) => {
      const response = await fetchImpl(`https://api.lever.co/v0/postings/${site.slug}?mode=json`, {
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
      .filter(({ job }) => job?.id && job?.text && job?.applyUrl && job.workplaceType === "remote"
        && discoveryTitleRelevant(job.text, profile))
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
