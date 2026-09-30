// Workday careers sites live at {tenant}.wd{N}.myworkdayjobs.com/{locale?}/{site}.
// Every posting path ends in _{requisition}. The tenant and that requisition
// identify a role: the instance can change when a tenant moves cluster, and one
// requisition can be published on several sites of the same tenant.
const HOST = /^([a-z0-9_-]{1,100})\.(wd\d{1,3})\.myworkdayjobs\.com$/;
const NAME = /^[A-Za-z0-9_-]{1,100}$/;
// Workday locale segments name a language and a region, e.g. en-US or es-419.
const LOCALE = /^[a-z]{2}-[a-z0-9]{2,3}$/i;
const POSTING_KEY = /^[A-Z0-9-]{2,64}$/;
// A posting path is /job/{location}/{slug}_{requisition}; the location segment
// is optional so a tenant that omits it still parses.
const EXTERNAL_PATH = /^\/job\/(?:[^/?#\\\s]+\/)?[^/?#\\\s]+$/;

function hostParts(url) {
  const match = HOST.exec(url.hostname.toLowerCase());
  return match && NAME.test(match[1]) ? { tenant: match[1], instance: match[2] } : null;
}

function origin({ tenant, instance }) {
  return `https://${tenant}.${instance}.myworkdayjobs.com`;
}

// Parses an operator-configured careers-site URL. A /job/ path, /login, a query,
// a fragment, credentials or a port make the entry invalid.
export function workdaySite(raw) {
  let url;
  try { url = new URL(String(raw ?? "").trim()); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) return null;
  const host = hostParts(url);
  if (!host) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length === 2 && LOCALE.test(parts[0])) parts.shift();
  if (parts.length !== 1 || !NAME.test(parts[0])) return null;
  const site = parts[0];
  return { ...host, site, key: `${host.tenant}/${site}`, origin: origin(host) };
}

export function workdayPostingKey(externalPath) {
  const segment = String(externalPath ?? "").split("/").filter(Boolean).at(-1) ?? "";
  const separator = segment.lastIndexOf("_");
  if (separator < 0) return null;
  const key = segment.slice(separator + 1).toUpperCase();
  return POSTING_KEY.test(key) ? key : null;
}

export function workdayExternalPath(value) {
  const path = typeof value === "string" ? value.trim() : "";
  return EXTERNAL_PATH.test(path) && !path.split("/").some((part) => part === "." || part === "..")
    && workdayPostingKey(path) ? path : null;
}

// Both URLs are rebuilt from parsed parts, without a locale, so they are stable.
export function workdayRoleUrls(site, externalPath) {
  const listingUrl = new URL(`${origin(site)}/${site.site}${externalPath}`).href;
  return { listingUrl, applyUrl: `${listingUrl}/apply` };
}

// Accepts /{locale?}/{site}/job/.../{slug}_{key} with an optional trailing
// /apply or /apply/... path. The query string is ignored.
function postingParts(url) {
  const host = hostParts(url);
  if (!host) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  const jobIndex = parts[1]?.toLowerCase() === "job" ? 1
    : parts[2]?.toLowerCase() === "job" && LOCALE.test(parts[0]) ? 2 : -1;
  if (jobIndex < 0 || !NAME.test(parts[jobIndex - 1])) return null;
  const applyIndex = parts.findIndex((part, index) => index > jobIndex + 1 && part.toLowerCase() === "apply");
  const posting = applyIndex < 0 ? parts.slice(jobIndex) : parts.slice(jobIndex, applyIndex);
  if (posting.length < 2 || posting.length > 3) return null;
  const postingKey = workdayPostingKey(posting.at(-1));
  return postingKey ? { ...host, site: parts[jobIndex - 1], postingKey,
    localized: jobIndex === 2, apply: applyIndex >= 0 ? parts.slice(applyIndex) : null,
    externalPath: `/${posting.join("/")}` } : null;
}

export function workdayKeyFromUrl(url) {
  const parsed = postingParts(url);
  return parsed ? `workday:${parsed.tenant}:${parsed.postingKey}` : null;
}

export function workdayIdentity(role) {
  if (String(role?.source ?? "") !== "workday") return null;
  const externalId = String(role?.externalId ?? "");
  const separator = externalId.lastIndexOf(":");
  const slash = externalId.indexOf("/");
  if (separator < 1 || slash < 1 || slash > separator) return null;
  const tenant = externalId.slice(0, slash).toLowerCase();
  const site = externalId.slice(slash + 1, separator);
  const postingKey = externalId.slice(separator + 1).toUpperCase();
  if (!NAME.test(tenant) || !NAME.test(site) || !POSTING_KEY.test(postingKey)) return null;
  return { tenant, site, siteKey: `${tenant}/${site}`, postingKey, key: `workday:${tenant}:${postingKey}` };
}

// The role's canonical posting on its own site: no locale, no apply suffix.
// Returns the parsed site and external path, or null.
export function workdayCanonicalPosting(role, field = "listingUrl") {
  const parsed = workdayIdentity(role);
  if (!parsed) return null;
  let url;
  try { url = new URL(role[field]); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) return null;
  const posting = postingParts(url);
  if (!posting || posting.localized || posting.tenant !== parsed.tenant || posting.site !== parsed.site
    || posting.postingKey !== parsed.postingKey) return null;
  const urls = workdayRoleUrls(posting, posting.externalPath);
  const expected = field === "applyUrl" ? urls.applyUrl : urls.listingUrl;
  return role[field] === expected ? { ...posting, ...urls, origin: origin(posting) } : null;
}

// A Workday role read from its own careers site names a known employer
// destination. It is not an official ATS destination for automatic submission:
// no Workday submission adapter exists, so callers keep it in the manual lane.
export function workdayDestination(role) {
  return Boolean(workdayCanonicalPosting(role, "applyUrl"));
}
