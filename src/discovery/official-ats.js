import { roleKeys } from "./handled-roles.js";

const ATS_HOSTS = {
  ashby: new Set(["jobs.ashbyhq.com"]),
  greenhouse: new Set(["job-boards.greenhouse.io", "job-boards.eu.greenhouse.io",
    "boards.greenhouse.io", "boards.eu.greenhouse.io"]),
  lever: new Set(["jobs.lever.co", "jobs.eu.lever.co"])
};

function identity(role) {
  const source = String(role?.source ?? "");
  const separator = String(role?.externalId ?? "").lastIndexOf(":");
  if (!ATS_HOSTS[source] || separator < 1) return null;
  const board = role.externalId.slice(0, separator).toLowerCase();
  const id = role.externalId.slice(separator + 1).toLowerCase();
  if (!/^[a-z0-9_-]{1,100}$/.test(board)
    || !(source === "greenhouse" ? /^\d+$/.test(id)
      : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))) return null;
  return { source, board, id, key: `${source}:${board}:${id}` };
}

export function officialAtsDestination(role) {
  const parsed = identity(role);
  if (!parsed) return false;
  let url;
  try { url = new URL(role.applyUrl); } catch { return false; }
  return url.protocol === "https:" && !url.username && !url.password
    && ATS_HOSTS[parsed.source].has(url.hostname.toLowerCase())
    && roleKeys({ applyUrl: url.toString() }).has(parsed.key);
}

export async function revalidateOfficialAtsRole(role, fetchImpl = fetch) {
  const parsed = identity(role);
  if (!parsed || !officialAtsDestination(role)) return false;
  let endpoint;
  if (parsed.source === "ashby") endpoint = `https://api.ashbyhq.com/posting-api/job-board/${parsed.board}`;
  if (parsed.source === "greenhouse") endpoint =
    `https://boards-api.greenhouse.io/v1/boards/${parsed.board}/jobs/${parsed.id}`;
  if (parsed.source === "lever") endpoint =
    `https://api.lever.co/v0/postings/${parsed.board}/${parsed.id}?mode=json`;
  try {
    const response = await fetchImpl(endpoint, { headers: { "user-agent": "job-application-system/0.2" },
      signal: AbortSignal.timeout(5000) });
    if (!response.ok) return false;
    const body = await response.json();
    const row = parsed.source === "ashby"
      ? (body.jobs ?? []).find((job) => String(job.id).toLowerCase() === parsed.id && job.isListed !== false)
      : body;
    if (!row || String(row.id).toLowerCase() !== parsed.id) return false;
    const title = parsed.source === "lever" ? row.text : row.title;
    if (String(title ?? "").trim() !== String(role.title ?? "").trim()) return false;
    if (parsed.source !== "greenhouse" && !officialAtsDestination({ ...role, applyUrl: row.applyUrl })) return false;
    return true;
  } catch { return false; }
}
