import { plainText } from "../text.js";
import { profileSearchTerms } from "../title-preferences.js";
import { redactSecrets } from "../source-credentials.js";

export const ADZUNA_COUNTRIES = Object.freeze(["at", "au", "be", "br", "ca", "ch", "de", "es", "fr", "gb",
  "in", "it", "mx", "nl", "nz", "pl", "sg", "us", "za"]);
export const ADZUNA_FILTERS = Object.freeze(["what", "what_or", "what_exclude", "where", "distance",
  "max_days_old", "salary_min", "full_time", "part_time", "permanent", "contract", "category", "sort_by", "country"]);
export const ADZUNA_FILTER_OPTIONS = Object.freeze({ sort_by: ["date", "salary", "relevance"],
  full_time: ["1"], part_time: ["1"], permanent: ["1"], contract: ["1"] });
export const ADZUNA_FILTER_FORMATS = Object.freeze({ distance: "^\\d{1,4}$", max_days_old: "^\\d{1,3}$",
  salary_min: "^\\d{1,9}$", category: "^[a-z0-9-]{1,80}$" });
export const ADZUNA_PAGE_SIZE = 50;

const DEFAULT_FILTERS = Object.freeze({ max_days_old: "7", sort_by: "date" });
const CURRENCIES = { at: "EUR", au: "AUD", be: "EUR", br: "BRL", ca: "CAD", ch: "CHF", de: "EUR", es: "EUR",
  fr: "EUR", gb: "GBP", in: "INR", it: "EUR", mx: "MXN", nl: "EUR", nz: "NZD", pl: "PLN", sg: "SGD",
  us: "USD", za: "ZAR" };
const PASSTHROUGH = new Set(["code", "window", "resetAt", "status"]);

const rejected = (key) => Object.assign(new Error(`unsupported filter: ${key}`), { status: 400 });

export function adzunaCountries(sourceConfig) {
  return [...new Set(Array.isArray(sourceConfig?.countries) ? sourceConfig.countries : [])]
    .filter((country) => ADZUNA_COUNTRIES.includes(country));
}

export function validateAdzunaFilters(filters, { allowCountry = true } = {}) {
  for (const [key, value] of Object.entries(filters ?? {})) {
    if (!ADZUNA_FILTERS.includes(key) || (!allowCountry && key === "country") || typeof value !== "string"
      || !value.trim() || value.length > 500 || (ADZUNA_FILTER_OPTIONS[key] && !ADZUNA_FILTER_OPTIONS[key].includes(value))
      || (ADZUNA_FILTER_FORMATS[key] && !new RegExp(ADZUNA_FILTER_FORMATS[key]).test(value))) throw rejected(key);
  }
  return filters;
}

export function validateAdzunaOptions(options) {
  const prefix = "discovery.sourceOptions.adzuna";
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error(`${prefix} must be an object`);
  for (const key of Object.keys(options)) {
    if (!["countries", "defaults", "quota"].includes(key)) {
      throw new Error(`${prefix}.${key} is not supported; Adzuna credentials belong in the server environment`);
    }
  }
  const countries = options.countries ?? [];
  if (!Array.isArray(countries) || new Set(countries).size !== countries.length
    || countries.some((country) => !ADZUNA_COUNTRIES.includes(country))) {
    throw new Error(`${prefix}.countries must list unique supported country codes: ${ADZUNA_COUNTRIES.join(", ")}`);
  }
  if (options.defaults !== undefined) {
    if (!options.defaults || typeof options.defaults !== "object" || Array.isArray(options.defaults)) {
      throw new Error(`${prefix}.defaults must be an object`);
    }
    try { validateAdzunaFilters(options.defaults, { allowCountry: false }); }
    catch (error) { throw new Error(`${prefix}.defaults: ${error.message}`); }
  }
  return options;
}

function postedAt(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function sanitizedUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    for (const key of ["app_id", "app_key"]) url.searchParams.delete(key);
    return url.href;
  } catch { return null; }
}

function employmentType(row) {
  if (row.contract_type === "contract") return "contract";
  return row.contract_time ?? row.contract_type;
}

function normalize(row, country) {
  const url = sanitizedUrl(row.redirect_url);
  const minimum = Number(row.salary_min);
  const maximum = Number(row.salary_max);
  const predicted = String(row.salary_is_predicted ?? "0") === "1";
  const pay = Number.isFinite(minimum) || Number.isFinite(maximum) ? {
    minimum: Number.isFinite(minimum) ? minimum : maximum,
    maximum: Number.isFinite(maximum) ? maximum : minimum,
    currency: CURRENCIES[country], period: "year"
  } : undefined;
  return {
    source: "adzuna",
    externalId: `${country}:${row.id}`,
    title: plainText(row.title),
    company: plainText(row.company?.display_name) || "Unknown company",
    listingUrl: url,
    applyUrl: url,
    applicationDestinationPending: true,
    description: plainText(row.description),
    descriptionSnippet: true,
    location: plainText(row.location?.display_name) || [...(row.location?.area ?? [])].reverse().join(", "),
    employmentType: employmentType(row),
    contractType: row.contract_type,
    contractTime: row.contract_time,
    category: row.category?.label,
    tags: [row.category?.label].filter(Boolean),
    postedAt: postedAt(row.created),
    searchCountry: country,
    ...(pay && !predicted ? { compensation: pay } : {}),
    ...(pay && predicted ? { compensationEstimate: { ...pay, predicted: true, provider: "adzuna" } } : {}),
    uncertainties: ["description_snippet_only", "employer_application_url_unverified",
      ...(pay && predicted ? ["compensation_predicted"] : [])]
  };
}

async function request({ country, page, size, term, filters, credentials, fetchImpl }) {
  const url = new URL(`https://api.adzuna.com/v1/api/jobs/${country}/search/${page}`);
  url.searchParams.set("app_id", credentials.appId);
  url.searchParams.set("app_key", credentials.appKey);
  url.searchParams.set("results_per_page", String(Math.min(ADZUNA_PAGE_SIZE, size)));
  if (term) url.searchParams.set("what", term);
  for (const key of ADZUNA_FILTERS) {
    if (!["what", "country"].includes(key) && filters[key] !== undefined) url.searchParams.set(key, filters[key]);
  }
  url.searchParams.set("content-type", "application/json");
  const response = await fetchImpl(url, {
    headers: { accept: "application/json", "user-agent": "job-application-server/0.2 (+private personal use)" },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) {
    throw Object.assign(new Error(`Adzuna returned HTTP ${response.status}`), { status: response.status,
      code: response.status === 429 ? "rate_limited" : response.status === 400 ? "parse_drift" : "provider_error" });
  }
  try { return await response.json(); }
  catch { throw Object.assign(new Error("Adzuna returned an unreadable response"), { code: "parse_drift" }); }
}

// The error never carries the request URL; any echoed credential in a message
// is replaced before it leaves the adapter.
function diagnostic(error, country, credentials) {
  return { stage: "provider_request", country,
    ...Object.fromEntries(Object.entries(error ?? {}).filter(([key]) => PASSTHROUGH.has(key))),
    code: error?.code ?? "provider_error",
    ...(error?.code === "parse_drift" ? { parseDrift: true } : {}),
    error: redactSecrets(String(error?.message ?? error), credentials).slice(0, 500) };
}

export const adzuna = {
  id: "adzuna",
  async search({ limit = 50, fetchImpl = fetch, profile, query = {}, sourceConfig = {}, credentials, onError = () => {} }) {
    if (!credentials?.appId || !credentials?.appKey) {
      throw Object.assign(new Error("source_not_configured"), { code: "source_not_configured" });
    }
    validateAdzunaFilters(query);
    validateAdzunaFilters(sourceConfig.defaults, { allowCountry: false });
    const configured = adzunaCountries(sourceConfig);
    if (query.country && !configured.includes(query.country)) throw rejected("country");
    const countries = query.country ? [query.country] : configured;
    const filters = { ...DEFAULT_FILTERS, ...(sourceConfig.defaults ?? {}), ...query };
    // `what` is the keyword slot each per-term request fills, and `what_or` is sent
    // alongside it, so only `what` decides the terms. A standing default narrows the
    // profile's titles rather than replacing them: replacing loses role targeting
    // entirely, while an explicit query asks for those keywords and is honoured.
    const standingWhat = sourceConfig.defaults?.what;
    const titles = profileSearchTerms(profile);
    const terms = query.what ? [query.what]
      : titles.length ? titles.map((title) => standingWhat ? `${title} ${standingWhat}` : title)
        : standingWhat ? [standingWhat] : [];
    if (!terms.length || !countries.length) return [];
    const capped = Math.max(1, Math.min(Number(limit) || 50, 200));
    const perTerm = Math.max(1, Math.ceil(capped / terms.length));
    const size = Math.min(ADZUNA_PAGE_SIZE, perTerm);
    const rows = [];
    fanOut: for (const country of countries) {
      for (const term of terms) {
        for (let page = 1; (page - 1) * size < perTerm; page += 1) {
          let body;
          try { body = await request({ country, page, size, term, filters, credentials, fetchImpl }); }
          catch (error) { onError(diagnostic(error, country, credentials)); break fanOut; }
          const results = Array.isArray(body?.results) ? body.results : [];
          rows.push(...results.map((row) => ({ row, country })));
          if (rows.length >= capped) break fanOut;
          if (results.length < size) break;
        }
      }
    }
    const unique = new Map(rows.filter(({ row }) => row?.id !== undefined && row?.title && sanitizedUrl(row.redirect_url))
      .map(({ row, country }) => [`${country}:${row.id}`, normalize(row, country)]));
    return [...unique.values()].slice(0, capped);
  }
};
