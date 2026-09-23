import { roleKeys } from "./handled-roles.js";
import { plainText } from "./text.js";
import { normalizeApplicationQuestions } from "./normalization.js";

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

export function officialAtsIdentityFromUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const key = [...roleKeys({ applyUrl: url.toString() })]
    .find((value) => /^(ashby|greenhouse|lever):/.test(value));
  if (!key) return null;
  const separator = key.lastIndexOf(":");
  const source = key.split(":", 1)[0];
  const parsed = identity({ source, externalId: `${key.slice(source.length + 1, separator)}:${key.slice(separator + 1)}` });
  return parsed && ATS_HOSTS[source].has(url.hostname.toLowerCase()) ? parsed : null;
}

// Browser candidates provide only a URL hint. Every field used for automatic
// eligibility comes from this fresh official ATS response or configured board.
export async function fetchVerifiedOfficialAtsRole(rawUrl, sourceOptions = {}, fetchImpl = fetch) {
  const parsed = officialAtsIdentityFromUrl(rawUrl);
  if (!parsed) return null;
  const endpoint = parsed.source === "ashby"
    ? `https://api.ashbyhq.com/posting-api/job-board/${parsed.board}`
    : parsed.source === "greenhouse"
      ? `https://boards-api.greenhouse.io/v1/boards/${parsed.board}/jobs/${parsed.id}`
      : `https://api.lever.co/v0/postings/${parsed.board}/${parsed.id}?mode=json`;
  try {
    const response = await fetchImpl(endpoint, { headers: { "user-agent": "job-application-system/0.2" },
      signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    const body = await response.json();
    const row = parsed.source === "ashby"
      ? (body.jobs ?? []).find((job) => String(job.id).toLowerCase() === parsed.id && job.isListed !== false)
      : body;
    if (!row || String(row.id).toLowerCase() !== parsed.id) return null;
    const configured = parsed.source === "greenhouse"
      ? sourceOptions.greenhouse?.boards?.find((item) => item.token?.toLowerCase() === parsed.board)
      : parsed.source === "lever"
        ? sourceOptions.lever?.sites?.find((item) => item.slug?.toLowerCase() === parsed.board)
        : sourceOptions.ashby?.boards?.find((item) => item.slug?.toLowerCase() === parsed.board);
    const company = configured?.company || body.companyName || body.organizationName
      || row.companyName || row.organizationName || parsed.board;
    const role = parsed.source === "ashby" ? {
      title: row.title, applyUrl: row.applyUrl, listingUrl: row.jobUrl || row.applyUrl,
      description: row.descriptionPlain ?? "", location: [row.location,
        ...(row.secondaryLocations ?? []).map((item) => item.location ?? item.name ?? item)].filter(Boolean).join(", "),
      remote: row.isRemote === true, employmentType: row.employmentType || "Full-Time",
      postedAt: row.publishedAt, tags: [row.department, row.team].filter(Boolean),
      applicationQuestions: normalizeApplicationQuestions(row.applicationQuestions
        ?? row.applicationForm?.questions ?? row.questions ?? [])
    } : parsed.source === "greenhouse" ? {
      title: row.title,
      applyUrl: row.absolute_url || `https://job-boards.greenhouse.io/${parsed.board}/jobs/${parsed.id}`,
      listingUrl: row.absolute_url || `https://job-boards.greenhouse.io/${parsed.board}/jobs/${parsed.id}`,
      description: plainText(`${row.content ?? ""} ${(row.departments ?? []).map((item) => item.name).join(" ")}`),
      location: row.location?.name ?? "", remote: /\b(remote|distributed|work from home)\b/i.test(row.location?.name ?? ""),
      employmentType: "Full-Time", postedAt: row.updated_at,
      tags: [...(row.departments ?? []).map((item) => item.name), ...(row.offices ?? []).map((item) => item.name)],
      applicationQuestions: normalizeApplicationQuestions(row.questions ?? [])
    } : {
      title: row.text, applyUrl: row.applyUrl, listingUrl: row.hostedUrl || row.applyUrl,
      description: `${row.descriptionPlain ?? ""} ${row.additionalPlain ?? ""} ${(row.lists ?? [])
        .map((item) => `${item.text ?? ""} ${item.content ?? ""}`).join(" ")}`,
      location: row.categories?.location ?? "", remote: row.workplaceType === "remote",
      employmentType: row.categories?.commitment || "Full-Time", postedAt: row.createdAt,
      tags: [row.categories?.team, row.categories?.department].filter(Boolean),
      applicationQuestions: normalizeApplicationQuestions(row.applicationQuestions ?? row.questions ?? [])
    };
    const verified = { source: parsed.source, externalId: `${parsed.board}:${parsed.id}`,
      company, ...role, applicationDestinationVerified: true, applicationDestinationPending: false };
    if (!verified.title || !verified.remote || !officialAtsDestination(verified)
      || (role.listingUrl && officialAtsIdentityFromUrl(role.listingUrl)?.key !== parsed.key)) return null;
    return verified;
  } catch { return null; }
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
