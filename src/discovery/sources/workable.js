import { plainText } from "../text.js";
import { labeledAnnualSalary } from "../labeled-compensation.js";
import { workableRoleUrls, workableShortcode, workableSlug } from "../workable-identity.js";

const MAX_BODY_CHARS = 10 * 1024 * 1024;

function configuredBoards(sourceConfig) {
  const boards = sourceConfig?.boards ?? [];
  if (!Array.isArray(boards)) throw new Error("Workable sourceOptions.boards must be an array");
  return boards.map((board) => ({ slug: workableSlug(board?.slug),
    company: typeof board?.company === "string" ? board.company.trim() : "" }))
    .filter((board) => board.slug);
}

// Hidden locations are internal to the employer's Workable account. Only the
// top-level fields are used when the feed omits the locations list entirely.
function locationOf(job) {
  const entries = Array.isArray(job.locations)
    ? job.locations.filter((item) => item && item.hidden !== true) : [job];
  return [...new Set(entries.map((item) => [item.city, item.region ?? item.state, item.country]
    .filter((part) => typeof part === "string" && part.trim()).map((part) => part.trim()).join(", "))
    .filter(Boolean))].join("; ");
}

async function readAccount(board, fetchImpl) {
  // Workable documents this public endpoint for careers pages. It redirects to
  // apply.workable.com/api/v1/widget/accounts/{account} and returns every job.
  const response = await fetchImpl(`https://www.workable.com/api/accounts/${board.slug}?details=true`, {
    headers: { "user-agent": "job-application-system/0.2", accept: "application/json" },
    signal: AbortSignal.timeout(20_000)
  });
  if (response.status === 404) throw new Error(`Workable ${board.slug} returned HTTP 404 (unknown account)`);
  if (!response.ok) throw new Error(`Workable ${board.slug} returned HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > MAX_BODY_CHARS) throw new Error(`Workable ${board.slug} returned an oversized response`);
  let body;
  try { body = JSON.parse(text); } catch {
    throw new Error(`Workable ${board.slug} returned invalid_official_response (non-JSON body, possible challenge)`);
  }
  if (!body || !Array.isArray(body.jobs)) {
    throw new Error(`Workable ${board.slug} returned invalid_official_response`);
  }
  const company = board.company || (typeof body.name === "string" && body.name.trim()) || board.slug;
  return body.jobs.map((job) => ({ board: { ...board, company }, job,
    shortcode: workableShortcode(job?.shortcode) }));
}

export const workable = {
  id: "workable",
  async search({ limit = 50, fetchImpl = fetch, sourceConfig, query = {},
    isHandled = () => false, onError = () => {}, onStats = () => {} }) {
    const requested = query.board ? workableSlug(query.board) : null;
    const boards = configuredBoards(sourceConfig).filter((board) => !query.board || board.slug === requested);
    const settled = await Promise.allSettled(boards.map((board) => readAccount(board, fetchImpl)));
    settled.forEach((result, index) => {
      if (result.status === "rejected") onError({ board: boards[index]?.slug, error: result.reason.message });
    });
    const rows = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    // Workable's telecommuting flag is the only remote evidence. Location text
    // such as "Remote" on an office-based job does not make it remote.
    const prescreened = rows.filter(({ job, shortcode }) => shortcode
      && typeof job?.title === "string" && job.title.trim() && job.telecommuting === true
      && (!query.title || job.title.toLowerCase().includes(query.title.toLowerCase()))
      && (!query.location || locationOf(job).toLowerCase().includes(query.location.toLowerCase())));
    const selected = prescreened.filter(({ board, shortcode }) => !isHandled({ source: "workable",
      externalId: `${board.slug}:${shortcode}`, ...workableRoleUrls(board.slug, shortcode) }))
      .sort((left, right) => Date.parse(right.job.published_on ?? "") - Date.parse(left.job.published_on ?? ""));
    onStats({ rawRows: rows.length, adapterPrescreenRejected: rows.length - prescreened.length,
      pagesVisited: settled.filter((result) => result.status === "fulfilled").length });
    if (selected.length > limit) onError({ stage: "selection", reason: "partial_response_cap",
      rawRows: selected.length });
    return selected.slice(0, limit).map(({ board, job, shortcode }) => ({
      source: "workable",
      externalId: `${board.slug}:${shortcode}`,
      title: job.title.trim(),
      company: board.company,
      ...workableRoleUrls(board.slug, shortcode),
      description: plainText(job.description ?? ""),
      compensation: labeledAnnualSalary(job.description ?? ""),
      tags: [...new Set([job.department, job.function, job.industry]
        .filter((tag) => typeof tag === "string" && tag.trim()))],
      location: locationOf(job),
      remote: true,
      employmentType: job.employment_type || undefined,
      postedAt: job.published_on || job.created_at,
      applicationQuestions: []
    }));
  }
};
