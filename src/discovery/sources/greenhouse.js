import { plainText } from "../text.js";
import { discoveryTitleRelevant } from "../title-preferences.js";
import { normalizeApplicationQuestions } from "../normalization.js";
import { greenhouseRemoteRole } from "../greenhouse-remote.js";

function configuredBoards(sourceConfig) {
  const boards = sourceConfig?.boards ?? [];
  if (!Array.isArray(boards)) throw new Error("Greenhouse sourceOptions.boards must be an array");
  return boards.filter((board) => board && typeof board.token === "string" && board.token.trim())
    .map((board) => ({ token: board.token.trim(), company: board.company?.trim() || board.token.trim() }));
}

function descriptionOf(job) {
  const departments = (job.departments ?? []).map((item) => item.name).join(" ");
  const offices = (job.offices ?? []).map((item) => item.name).join(" ");
  return plainText(`${job.content ?? ""} ${departments} ${offices}`);
}

export const greenhouse = {
  id: "greenhouse",
  async search({ limit = 50, fetchImpl = fetch, profile, sourceConfig, query = {},
    isHandled = () => false, onError = () => {} }) {
    const boards = configuredBoards(sourceConfig).filter((board) => !query.board || board.token === query.board);
    const settled = await Promise.allSettled(boards.map(async (board) => {
      const url = new URL(`https://boards-api.greenhouse.io/v1/boards/${board.token}/jobs`);
      url.searchParams.set("content", "true");
      const response = await fetchImpl(url, {
        headers: { "user-agent": "job-application-system/0.1" },
        signal: AbortSignal.timeout(20_000)
      });
      if (!response.ok) throw new Error(`Greenhouse ${board.token} returned HTTP ${response.status}`);
      const body = await response.json();
      return (body.jobs ?? []).map((job) => ({ board, job }));
    }));
    settled.forEach((result, index) => {
      if (result.status === "rejected") onError({ board: boards[index]?.token, error: result.reason.message });
    });
    const rows = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    const selected = rows
      .filter(({ board, job }) => job?.id && job?.title && greenhouseRemoteRole(job)
        && discoveryTitleRelevant(job.title, profile)
        && (!query.title || job.title.toLowerCase().includes(query.title.toLowerCase()))
        && (!query.location || String(job.location?.name ?? "").toLowerCase().includes(query.location.toLowerCase()))
        && !isHandled({ source: "greenhouse", externalId: `${board.token}:${job.id}`,
          applyUrl: `https://job-boards.greenhouse.io/${board.token}/jobs/${job.id}` }))
      .sort((left, right) => Date.parse(right.job.updated_at ?? "") - Date.parse(left.job.updated_at ?? ""))
      .slice(0, limit);
    // The live form remains authoritative. Detail requests are opt-in so a
    // discovery scan does not fan out one request per candidate by default.
    if (sourceConfig?.fetchQuestions === true) {
      await Promise.all(selected.map(async ({ board, job }) => {
        try {
          const detailUrl = new URL(`https://boards-api.greenhouse.io/v1/boards/${board.token}/jobs/${job.id}`);
          detailUrl.searchParams.set("questions", "true");
          const response = await fetchImpl(detailUrl, {
            headers: { "user-agent": "job-application-system/0.1" }, signal: AbortSignal.timeout(20_000)
          });
          if (!response.ok) throw new Error(`Greenhouse ${board.token}/${job.id} returned HTTP ${response.status}`);
          const detail = await response.json();
          job.applicationQuestions = normalizeApplicationQuestions(detail.questions ?? []);
        } catch (error) {
          onError({ board: board.token, job: String(job.id), stage: "job_detail", error: error.message });
        }
      }));
    }
    return selected
      .map(({ board, job }) => ({
        source: "greenhouse",
        externalId: `${board.token}:${job.id}`,
        title: job.title,
        company: board.company,
        listingUrl: `https://job-boards.greenhouse.io/${board.token}/jobs/${job.id}`,
        applyUrl: `https://job-boards.greenhouse.io/${board.token}/jobs/${job.id}`,
        description: descriptionOf(job),
        tags: [
          ...(job.departments ?? []).map((item) => item.name),
          ...(job.offices ?? []).map((item) => item.name)
        ],
        location: job.location?.name || "Remote",
        remote: true,
        employmentType: "Full-Time",
        postedAt: job.updated_at,
        applicationQuestions: job.applicationQuestions ?? []
      }));
  }
};
