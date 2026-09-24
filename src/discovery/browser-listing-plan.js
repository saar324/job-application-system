// The private source catalog may offer several reviewed listing pages for a
// source. Keep the choice bounded and on the catalog source's HTTPS origin.
export function browserListingPlan(source, cycle = 0) {
  const fallback = { url: source.url, origin: "catalog", roleFamily: null };
  let base;
  try { base = new URL(source.url); } catch { return fallback; }
  if (base.protocol !== "https:") return fallback;
  const candidates = (Array.isArray(source.roleListingUrls) ? source.roleListingUrls : [])
    .slice(0, 8).filter((candidate) => {
      try {
        const parsed = new URL(candidate);
        return parsed.protocol === "https:" && parsed.origin === base.origin;
      } catch { return false; }
    });
  if (!candidates.length) return fallback;
  const ordinal = Number.isInteger(cycle) && cycle >= 0 ? cycle : 0;
  return { url: candidates[ordinal % candidates.length], origin: "configured_role_page_rotation",
    roleFamily: null, cycle: ordinal };
}
