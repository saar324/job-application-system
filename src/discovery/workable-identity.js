// Workable serves every role at apply.workable.com/{account}/j/{shortcode}/
// and at the account-less short link apply.workable.com/j/{shortcode}. The
// short link resolves on its own, so the shortcode is the stable role identity.
export const WORKABLE_HOST = "apply.workable.com";
const SLUG = /^[a-z0-9_-]{1,100}$/;
const SHORTCODE = /^[0-9A-Z]{4,32}$/;

export function workableSlug(value) {
  const slug = typeof value === "string" ? value.trim().toLowerCase() : "";
  return SLUG.test(slug) ? slug : null;
}

export function workableShortcode(value) {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  return SHORTCODE.test(code) ? code : null;
}

export function workableRoleUrls(slug, shortcode) {
  const listingUrl = `https://${WORKABLE_HOST}/${slug}/j/${shortcode}/`;
  return { listingUrl, applyUrl: `${listingUrl}apply/` };
}

// Accepts /{account}/j/{code}, /j/{code} and either with a trailing apply/.
export function workableKeyFromUrl(url) {
  if (url.hostname.toLowerCase() !== WORKABLE_HOST) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.at(-1)?.toLowerCase() === "apply") parts.pop();
  const offset = parts[0]?.toLowerCase() === "j" ? 0 : 1;
  if (parts.length !== offset + 2 || parts[offset].toLowerCase() !== "j"
    || (offset === 1 && !workableSlug(parts[0]))) return null;
  const code = workableShortcode(parts[offset + 1]);
  return code ? `workable:${code}` : null;
}

export function workableIdentity(role) {
  if (String(role?.source ?? "") !== "workable") return null;
  const externalId = String(role?.externalId ?? "");
  const separator = externalId.lastIndexOf(":");
  if (separator < 1) return null;
  const slug = workableSlug(externalId.slice(0, separator));
  const shortcode = workableShortcode(externalId.slice(separator + 1));
  return slug && shortcode ? { slug, shortcode, key: `workable:${shortcode}` } : null;
}

// A Workable role read from its own account feed names a known employer
// destination. It is not an official ATS destination for automatic submission:
// no Workable submission adapter exists, so callers keep it in the manual lane.
export function workableDestination(role) {
  const parsed = workableIdentity(role);
  if (!parsed) return false;
  let url;
  try { url = new URL(role.applyUrl); } catch { return false; }
  return url.protocol === "https:" && !url.username && !url.password && !url.search
    && url.pathname.split("/").filter(Boolean)[0]?.toLowerCase() === parsed.slug
    && workableKeyFromUrl(url) === parsed.key;
}
