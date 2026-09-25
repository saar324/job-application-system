export function publicFeedUrl(sourceId, { query = "", page = 1, limit = 25,
  residenceCountry, geographyScope } = {}) {
  if (sourceId === "jobgether") {
    const url = new URL("https://jobgether.com/api/v1/jobs");
    const country = String(residenceCountry ?? "").trim().toLowerCase();
    const location = geographyScope === "residence" && country ? country
      : geographyScope === "worldwide" ? null
        : geographyScope && geographyScope !== "residence" ? String(geographyScope).toLowerCase()
          : country || null;
    const parameters = new URLSearchParams({ remoteType: "full-remote",
      sort: "relevance", page: String(page), limit: String(Math.min(25, limit)) });
    if (location) parameters.set("locations", location);
    if (String(query).trim()) parameters.set("keyword", String(query).trim());
    url.search = parameters.toString();
    return url.toString();
  }
  if (sourceId === "remotive") {
    return `https://remotive.com/api/remote-jobs?limit=${Math.min(100, limit)}`;
  }
  if (sourceId === "weworkremotely") {
    return "https://weworkremotely.com/remote-jobs.rss";
  }
  return null;
}

export function jobgetherGeographyScope(residenceCountry, queryIndex = 0, sourceCycle = 0,
  preferredRegions = []) {
  const regions = Array.isArray(preferredRegions) ? preferredRegions
    .map((value) => {
      const label = String(value).trim();
      if (/\b(?:eu|eea|europe|european)\b/i.test(label)) return "europe";
      if (/\b(?:worldwide|global|anywhere)\b/i.test(label)) return "worldwide";
      return null;
    }).filter(Boolean).slice(0, 3) : [];
  const scopes = [...new Set([...regions,
    ...(String(residenceCountry ?? "").trim() ? ["residence"] : []), "worldwide"])];
  const cycle = Number.isInteger(sourceCycle) && sourceCycle >= 0 ? sourceCycle : 0;
  return scopes[(queryIndex + cycle) % scopes.length];
}

export function parsePublicFeed(sourceId, payload) {
  if (sourceId === "jobgether") return parseJobgether(payload);
  if (sourceId === "remotive") return parseRemotive(payload);
  if (sourceId === "weworkremotely") return parseWeWorkRemotely(payload);
  return { items: [], detailLinks: [], hasMore: false };
}

function parseJobgether(payload) {
  const data = typeof payload === "string" ? JSON.parse(payload) : payload;
  const items = (data.jobs ?? []).map((job) => ({
    source: "jobgether", externalId: String(job.id ?? job.url), title: job.title,
    company: job.company, description: [job.experience, ...(job.jobFunctions ?? [])].filter(Boolean).join(" "),
    location: normalizeLocation(job.location), remote: /full remote/i.test(job.remote ?? ""),
    employmentType: job.contractType, postedAt: job.postedAt,
    listingUrl: job.url, applyUrl: job.url,
    uncertainties: ["employer_application_url_unverified"]
  })).filter(valid);
  return { items, detailLinks: items.map((item) => item.listingUrl),
    hasMore: data.pagination?.hasMore === true };
}

function parseRemotive(payload) {
  const data = typeof payload === "string" ? JSON.parse(payload) : payload;
  const items = (data.jobs ?? []).map((job) => ({
    source: "remotive", externalId: String(job.id ?? job.url), title: job.title,
    company: job.company_name, description: decode(job.description),
    location: normalizeLocation(job.candidate_required_location), remote: true,
    employmentType: job.job_type, postedAt: job.publication_date,
    listingUrl: job.url, applyUrl: job.url, tags: job.tags,
    ...(parseSalary(job.salary) ? { compensation: parseSalary(job.salary) } : {}),
    uncertainties: ["employer_application_url_unverified"]
  })).filter(valid);
  return { items, detailLinks: [], hasMore: false };
}

function parseWeWorkRemotely(payload) {
  const items = [...String(payload).matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((match) => {
    const item = match[1];
    const combinedTitle = decode(tag(item, "title"));
    const separator = combinedTitle.indexOf(":");
    const company = separator > 0 ? combinedTitle.slice(0, separator).trim() : "Unknown";
    const title = separator > 0 ? combinedTitle.slice(separator + 1).trim() : combinedTitle;
    const url = decode(tag(item, "link") || tag(item, "guid"));
    return {
      source: "weworkremotely", externalId: url, title, company,
      description: decode(tag(item, "description")),
      location: normalizeLocation(decode(tag(item, "region"))), remote: true,
      employmentType: "full_time", postedAt: decode(tag(item, "pubDate")),
      listingUrl: url, applyUrl: url,
      uncertainties: ["employer_application_url_unverified"]
    };
  }).filter(valid);
  return { items, detailLinks: [], hasMore: false };
}

function parseSalary(value) {
  const text = String(value ?? "").replaceAll(",", "");
  const numbers = [...text.matchAll(/(?:[$€£]\s*)?(\d+(?:\.\d+)?)\s*([kK])?/g)]
    .map((match) => Number(match[1]) * (match[2] ? 1000 : 1)).filter(Number.isFinite);
  if (!numbers.length) return null;
  const currency = text.includes("€") || /\bEUR\b/i.test(text) ? "EUR"
    : text.includes("£") || /\bGBP\b/i.test(text) ? "GBP" : "USD";
  return { minimum: numbers[0], maximum: numbers[1] ?? numbers[0], currency, period: "year" };
}

function tag(input, name) {
  return String(input).match(new RegExp(`<${name}(?:\\s[^>]*)?>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${name}>`, "i"))?.[1] ?? "";
}

function normalizeLocation(value) {
  const text = decode(value).trim();
  return /anywhere in the world|worldwide/i.test(text) ? "Worldwide" : text;
}

function decode(value) {
  return String(value ?? "").replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&amp;/gi, "&")
    .replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function valid(item) {
  return Boolean(item.title && item.company && /^https:\/\//i.test(item.applyUrl ?? ""));
}
