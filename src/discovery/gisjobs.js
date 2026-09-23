const HOSTS = new Set(["gjc.org", "www.gjc.org"]);

function page(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && HOSTS.has(url.hostname.toLowerCase()) ? url : null;
  } catch { return null; }
}

export function gisJobLinkScore(raw, text) {
  const url = page(raw);
  if (!url) return 0;
  if (url.pathname === "/cgi-bin/showjob.pl" && /^\d+$/.test(url.searchParams.get("id") ?? "")) {
    return 100;
  }
  return url.pathname === "/cgi-bin/listjobs.pl"
    && /\b(?:view|browse)\s+(?:all\s+)?(?:job postings|jobs)|available positions\b/i.test(text)
    ? 70 : 0;
}

export function extractGisJob(html, rawUrl) {
  const url = page(rawUrl);
  if (!url || url.pathname !== "/cgi-bin/showjob.pl"
    || !/^\d+$/.test(url.searchParams.get("id") ?? "")) return null;
  const main = String(html).match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];
  if (!main) return null;
  const field = (name) => {
    const value = main.match(new RegExp(`<(?:b|strong)>\\s*${name}:?\\s*<\\/(?:b|strong)>\\s*([^<]{1,500})`, "i"))?.[1];
    return value ? plain(value) : "";
  };
  const title = field("Title");
  const company = field("Organization");
  const location = field("Location");
  if (!title || !company || !location) return null;
  return { source: "gisjobs", externalId: url.searchParams.get("id"), title, company,
    description: plain(main).slice(0, 50_000), location,
    remote: /\b(?:remote|worldwide|anywhere)\b/i.test(location),
    ...( /^contract\b/i.test(title) ? { employmentType: "contract" } : {}),
    postedAt: field("Posted") || undefined,
    listingUrl: url.toString(), applyUrl: url.toString(),
    uncertainties: ["employer_application_url_unverified"] };
}

function plain(value) {
  return String(value).replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|#160);/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ").trim();
}
