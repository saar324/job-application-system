import { discoveryTitleRelevant } from "../title-preferences.js";
import { normalizeApplicationQuestions } from "../normalization.js";

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
  async search({ limit = 50, fetchImpl = fetch, profile, sourceConfig, query = {},
    isHandled = () => false, onError = () => {} }) {
    const boards = configuredBoards(sourceConfig).filter((board) => !query.board || board.slug === query.board);
    const settled = await Promise.allSettled(boards.map(async (board) => {
      const response = await fetchImpl(`https://api.ashbyhq.com/posting-api/job-board/${board.slug}`, {
        headers: { "user-agent": "job-application-system/0.1" },
        signal: AbortSignal.timeout(20_000)
      });
      if (!response.ok) throw new Error(`Ashby ${board.slug} returned HTTP ${response.status}`);
      const body = await response.json();
      return (body.jobs ?? []).map((job) => ({ board, job }));
    }));
    settled.forEach((result, index) => {
      if (result.status === "rejected") onError({ board: boards[index]?.slug, error: result.reason.message });
    });
    return settled
      .flatMap((result) => result.status === "fulfilled" ? result.value : [])
      .filter(({ board, job }) => job?.id && job?.title && job?.applyUrl && job.isRemote
        && job.isListed !== false && discoveryTitleRelevant(job.title, profile)
        && (!query.title || job.title.toLowerCase().includes(query.title.toLowerCase()))
        && (!query.location || locationOf(job).toLowerCase().includes(query.location.toLowerCase()))
        && !isHandled({ source: "ashby", externalId: `${board.slug}:${job.id}`,
          applyUrl: job.applyUrl, listingUrl: job.jobUrl }))
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
        postedAt: job.publishedAt,
        applicationQuestions: normalizeApplicationQuestions(
          job.applicationQuestions ?? job.applicationForm?.questions ?? job.questions ?? []
        )
      }));
  }
};
