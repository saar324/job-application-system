import { discoveryTitleRelevant } from "../title-preferences.js";

function configuredBoards(sourceConfig) {
  const boards = sourceConfig?.boards ?? [];
  if (!Array.isArray(boards)) throw new Error("Ashby sourceOptions.boards must be an array");
  return boards.filter((board) => board && typeof board.slug === "string" && board.slug.trim())
    .map((board) => ({ slug: board.slug.trim(), company: board.company?.trim() || board.slug.trim() }));
}

function locationOf(job) {
  return [job.location, ...(job.secondaryLocations ?? []).map((item) => item.location ?? item.name ?? item)]
    .filter(Boolean).join(", ");
}

export const ashby = {
  id: "ashby",
  async search({ limit = 50, fetchImpl = fetch, profile, sourceConfig }) {
    const settled = await Promise.allSettled(configuredBoards(sourceConfig).map(async (board) => {
      const response = await fetchImpl(`https://api.ashbyhq.com/posting-api/job-board/${board.slug}`, {
        headers: { "user-agent": "job-application-system/0.1" },
        signal: AbortSignal.timeout(20_000)
      });
      if (!response.ok) throw new Error(`Ashby ${board.slug} returned HTTP ${response.status}`);
      const body = await response.json();
      return (body.jobs ?? []).map((job) => ({ board, job }));
    }));
    return settled
      .flatMap((result) => result.status === "fulfilled" ? result.value : [])
      .filter(({ job }) => job?.id && job?.title && job?.applyUrl && job.isRemote
        && discoveryTitleRelevant(job.title, profile))
      .sort((left, right) => Date.parse(right.job.publishedAt ?? "") - Date.parse(left.job.publishedAt ?? ""))
      .slice(0, limit)
      .map(({ board, job }) => ({
        source: "ashby",
        externalId: `${board.slug}:${job.id}`,
        title: job.title,
        company: board.company,
        listingUrl: job.jobUrl,
        applyUrl: job.applyUrl,
        description: job.descriptionPlain ?? "",
        tags: [job.department, job.team].filter(Boolean),
        location: locationOf(job) || "Remote",
        remote: true,
        employmentType: job.employmentType || "Full-Time",
        postedAt: job.publishedAt
      }));
  }
};
