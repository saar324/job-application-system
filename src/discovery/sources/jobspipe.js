import { plainText } from "../text.js";
import { searchTitleQueryPlan } from "../search-title-queries.js";
import { redactSecrets } from "../source-credentials.js";
import { officialAtsIdentityFromUrl } from "../official-ats.js";

export const JOBSPIPE_ENDPOINT = "https://api.jobspipe.dev/v1/jobs/search";
// Published plan ceilings. Private config may lower the rate and credits of
// the declared plan (Free by default) but never raise them.
export const JOBSPIPE_PLANS = Object.freeze({
  free: Object.freeze({ perSecond: 2, monthlyCredits: 1_000, pageSize: 25 }),
  builder: Object.freeze({ perSecond: 10, monthlyCredits: 25_000, pageSize: 100 }),
  growth: Object.freeze({ perSecond: 10, monthlyCredits: 100_000, pageSize: 100 }),
  scale: Object.freeze({ perSecond: 50, monthlyCredits: 300_000, pageSize: 100 }),
  business: Object.freeze({ perSecond: 50, monthlyCredits: 500_000, pageSize: 100 })
});
export const JOBSPIPE_ARRAY_FILTERS = Object.freeze(["job_title_or", "job_title_not", "description_or",
  "description_not", "job_country_code_or", "job_location_or", "work_arrangement_or", "employment_type_or",
  "job_seniority_or", "visa_sponsorship_or", "language_or", "company_name_or", "employer_type_not", "source_not"]);
export const JOBSPIPE_FILTERS = Object.freeze([...JOBSPIPE_ARRAY_FILTERS, "remote", "posted_at_max_age_days",
  "min_salary_usd", "max_ghost_score"]);
export const JOBSPIPE_FILTER_OPTIONS = Object.freeze({ remote: ["true", "false"],
  work_arrangement_or: ["remote", "hybrid", "onsite"],
  employment_type_or: ["full-time", "part-time", "contract", "temporary", "internship"],
  job_seniority_or: ["entry_level", "mid_level", "senior", "director", "executive"],
  visa_sponsorship_or: ["offers", "no", "citizenship_required"],
  employer_type_not: ["employer", "agency", "broker"] });
export const JOBSPIPE_FILTER_FORMATS = Object.freeze({ job_country_code_or: "^[A-Za-z]{2}$",
  language_or: "^[a-z]{2}$", source_not: "^[a-z0-9][a-z0-9_.-]{0,59}$", posted_at_max_age_days: "^\\d{1,3}$",
  min_salary_usd: "^\\d{1,9}$", max_ghost_score: "^\\d{1,3}$" });

const NUMBER_RANGES = { posted_at_max_age_days: [1, 365], min_salary_usd: [0, 999_999_999], max_ghost_score: [0, 100] };
const OPTION_KEYS = ["plan", "monthlyCredits", "perSecond", "maxPages", "excludeSources", "defaultCountries",
  "defaults"];
const DEFAULT_FILTERS = Object.freeze({ posted_at_max_age_days: 7 });
const DEFAULT_EXCLUDED_SOURCES = Object.freeze(["linkedin"]);
const PASSTHROUGH = new Set(["code", "window", "resetAt", "status", "retryable"]);
// Credits the provider bills for a failed request: a 400 costs one; the rest
// (401, 402, 429, 5xx) are free or refunded.
const CHARGED_ON_ERROR = { 400: 1 };
const STATUS_CODES = { 400: "invalid_request", 401: "key_rejected", 402: "quota_exhausted", 429: "rate_limited",
  502: "provider_timeout", 504: "provider_timeout" };

const rejected = (key) => Object.assign(new Error(`unsupported filter: ${key}`), { status: 400 });

// Converts query values (strings or string arrays from the agent API, or
// native values from a server-side plan) into the provider's body types.
export function validateJobspipeFilters(filters = {}) {
  const body = {};
  for (const [key, value] of Object.entries(filters ?? {})) {
    if (!JOBSPIPE_FILTERS.includes(key)) throw rejected(key);
    const format = JOBSPIPE_FILTER_FORMATS[key] && new RegExp(JOBSPIPE_FILTER_FORMATS[key]);
    const options = JOBSPIPE_FILTER_OPTIONS[key];
    if (JOBSPIPE_ARRAY_FILTERS.includes(key)) {
      const items = Array.isArray(value) ? value : [value];
      if (!items.length || items.length > 20 || items.some((item) => typeof item !== "string" || !item.trim()
        || item.length > 200 || (format && !format.test(item)) || (options && !options.includes(item)))) throw rejected(key);
      body[key] = [...new Set(items.map((item) => key === "job_country_code_or" ? item.toUpperCase() : item.trim()))];
    } else if (key === "remote") {
      if (![true, false, "true", "false"].includes(value)) throw rejected(key);
      body.remote = value === true || value === "true";
    } else {
      const number = typeof value === "number" ? value : typeof value === "string" && format.test(value) ? Number(value) : NaN;
      const [minimum, maximum] = NUMBER_RANGES[key];
      if (!Number.isInteger(number) || number < minimum || number > maximum) throw rejected(key);
      body[key] = number;
    }
  }
  return body;
}

export function jobspipeSettings(options = {}) {
  const plan = JOBSPIPE_PLANS[options.plan ?? "free"] ?? JOBSPIPE_PLANS.free;
  const lowered = (value, ceiling) => Number.isInteger(value) && value >= 0 && value < ceiling ? value : ceiling;
  return {
    pageSize: plan.pageSize,
    perSecond: Math.max(1, lowered(options.perSecond, plan.perSecond)),
    monthlyCredits: lowered(options.monthlyCredits, plan.monthlyCredits),
    maxPages: Number.isInteger(options.maxPages) && options.maxPages >= 1 && options.maxPages <= 10 ? options.maxPages : 2,
    excludeSources: Array.isArray(options.excludeSources) ? options.excludeSources : [...DEFAULT_EXCLUDED_SOURCES],
    defaultCountries: Array.isArray(options.defaultCountries) ? options.defaultCountries.map((item) => item.toUpperCase()) : [],
    // Owner-set standing filters. A scan cannot carry filters of its own, so
    // without these every scheduled scan would search worldwide and on-site.
    defaults: options.defaults ? validateJobspipeFilters(options.defaults) : {}
  };
}

export function validateJobspipeOptions(options) {
  const prefix = "discovery.sourceOptions.jobspipe";
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error(`${prefix} must be an object`);
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.includes(key)) {
      throw new Error(`${prefix}.${key} is not supported; JobsPipe credentials belong in the server environment`);
    }
  }
  if (options.plan !== undefined && !Object.hasOwn(JOBSPIPE_PLANS, options.plan)) {
    throw new Error(`${prefix}.plan must be one of: ${Object.keys(JOBSPIPE_PLANS).join(", ")}`);
  }
  const plan = JOBSPIPE_PLANS[options.plan ?? "free"];
  for (const [key, minimum, maximum] of [["monthlyCredits", 0, plan.monthlyCredits], ["perSecond", 1, plan.perSecond],
    ["maxPages", 1, 10]]) {
    const value = options[key];
    if (value !== undefined && (!Number.isInteger(value) || value < minimum || value > maximum)) {
      throw new Error(`${prefix}.${key} must be an integer from ${minimum} to ${maximum}`);
    }
  }
  for (const key of ["excludeSources", "defaultCountries"]) {
    const value = options[key];
    const format = new RegExp(JOBSPIPE_FILTER_FORMATS[key === "excludeSources" ? "source_not" : "job_country_code_or"]);
    if (value !== undefined && (!Array.isArray(value) || value.length > 20 || new Set(value).size !== value.length
      || value.some((item) => typeof item !== "string" || !format.test(item)))) {
      throw new Error(`${prefix}.${key} must list unique ${key === "excludeSources"
        ? "lowercase source names" : "two-letter country codes"}`);
    }
  }
  if (options.defaults !== undefined) {
    if (!options.defaults || typeof options.defaults !== "object" || Array.isArray(options.defaults)) {
      throw new Error(`${prefix}.defaults must be an object`);
    }
    for (const [key, instead] of [["job_country_code_or", `${prefix}.defaultCountries`],
      ["job_title_or", "the profile's preferred titles"]]) {
      if (Object.hasOwn(options.defaults, key)) {
        throw new Error(`${prefix}.defaults.${key} is not supported; use ${instead}`);
      }
    }
    try { validateJobspipeFilters(options.defaults); }
    catch (error) { throw new Error(`${prefix}.defaults: ${error.message}`); }
  }
  return options;
}

export function jobspipeQuotaLimits(options = {}) {
  const settings = jobspipeSettings(options);
  return { second: settings.perSecond, credits_month: settings.monthlyCredits };
}

const timestamp = (value) => {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
};
const amount = (value) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value
  : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) && Number(value) > 0 ? Number(value) : undefined;
const strings = (value, size = 30) => (Array.isArray(value) ? value : [])
  .filter((item) => typeof item === "string" && item.trim()).map((item) => plainText(item).slice(0, 100)).slice(0, size);

function httpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function payRange(minimum, maximum, currency, extra = {}) {
  if (minimum === undefined && maximum === undefined) return undefined;
  return { minimum: minimum ?? maximum, maximum: maximum ?? minimum, currency, period: "year", ...extra };
}

// Builds the stored record from an explicit field list, so contact data
// (`recruiter_emails`), applicant counts and company financials never cross
// the adapter boundary.
function normalize(row) {
  const candidates = [row.apply_url, row.url, row.source_url].map(httpsUrl).filter(Boolean);
  const official = candidates.find((url) => officialAtsIdentityFromUrl(url));
  const applyUrl = official ?? candidates[0];
  const currency = /^[A-Z]{3}$/.test(row.salary_currency ?? "") ? row.salary_currency : undefined;
  const stated = currency ? payRange(amount(row.min_annual_salary), amount(row.max_annual_salary), currency) : undefined;
  const median = amount(row.estimated_median_annual_salary_usd);
  const estimate = payRange(amount(row.estimated_min_annual_salary_usd) ?? median,
    amount(row.estimated_max_annual_salary_usd) ?? median, "USD",
    { ...(median ? { median } : {}), estimated: true, provider: "jobspipe" });
  const countryCodes = [...new Set(strings(Array.isArray(row.country_codes) ? row.country_codes : [row.country_code])
    .filter((code) => /^[A-Za-z]{2}$/.test(code)).map((code) => code.toUpperCase()))];
  const employmentStatuses = strings(row.employment_statuses, 10);
  const originSources = [...new Set((Array.isArray(row.sources) ? row.sources : [])
    .map((item) => typeof item === "string" ? item : item?.name ?? item?.source)
    .filter((item) => typeof item === "string" && /^[A-Za-z0-9 _.-]{1,60}$/.test(item))
    .map((item) => item.toLowerCase()))].slice(0, 20);
  const company = typeof row.company === "string" ? row.company : row.company?.name;
  return {
    source: "jobspipe",
    externalId: String(row.id),
    title: plainText(row.job_title ?? row.normalized_title),
    company: plainText(company) || "Unknown company",
    ...(typeof row.company_domain === "string" && /^[a-z0-9.-]{1,253}$/i.test(row.company_domain)
      ? { companyDomain: row.company_domain.toLowerCase() } : {}),
    listingUrl: httpsUrl(row.url) ?? applyUrl,
    applyUrl,
    applicationDestinationPending: true,
    ...(official ? { officialAtsCandidateUrl: official } : {}),
    applicationFlow: official ? "verify_official_ats_before_prepare" : "resolve_employer_url_before_prepare",
    description: plainText(row.description),
    location: plainText(row.location) || strings(row.cities, 5).join(", ") || countryCodes.join(", "),
    remote: row.remote === true || row.work_arrangement === "remote",
    employmentType: employmentStatuses[0],
    postedAt: timestamp(row.date_posted ?? row.discovered_at),
    ...(timestamp(row.expires_at) ? { validThrough: timestamp(row.expires_at) } : {}),
    ...(typeof row.status === "string" ? { postingStatus: row.status } : {}),
    postingEvidence: {
      status: row.status, verifiedAt: timestamp(row.verified_at), lastSeenAt: timestamp(row.last_seen_at),
      expiresAt: timestamp(row.expires_at), ghostScore: Number.isFinite(row.ghost_score) ? row.ghost_score : undefined,
      visaSponsorship: typeof row.visa_sponsorship === "string" ? row.visa_sponsorship : undefined,
      seniority: typeof row.seniority === "string" ? row.seniority : undefined,
      employmentStatuses, countryCodes, originSources,
      workArrangement: typeof row.work_arrangement === "string" ? row.work_arrangement : undefined,
      hybrid: row.hybrid === true
    },
    tags: [...new Set([...strings(row.keyword_slugs), ...strings(row.technology_slugs)])].slice(0, 40),
    ...(stated ? { compensation: stated } : {}),
    ...(!stated && estimate ? { compensationEstimate: estimate } : {}),
    uncertainties: ["employer_application_url_unverified", ...(official ? ["official_ats_unverified"] : []),
      ...(!stated && estimate ? ["compensation_estimated"] : [])]
  };
}

function open(row, now) {
  if (row?.id === undefined || row?.id === null || !(row.job_title ?? row.normalized_title)) return false;
  if (row.status !== undefined && row.status !== "active") return false;
  for (const value of [row.expires_at, row.closed_at]) {
    const at = Date.parse(value ?? "");
    if (Number.isFinite(at) && at <= now) return false;
  }
  return true;
}

async function request({ body, credentials, fetchImpl }) {
  const response = await fetchImpl(JOBSPIPE_ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${credentials.apiKey}`, "content-type": "application/json",
      accept: "application/json", "user-agent": "job-application-server/0.2 (+private personal use)" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) {
    const code = STATUS_CODES[response.status] ?? "provider_error";
    const message = response.status === 401
      ? "JobsPipe rejected the API key; the source is paused until JOBSPIPE_API_KEY changes"
      : response.status === 402 ? "JobsPipe monthly credits are exhausted until the next UTC month"
        : `JobsPipe returned HTTP ${response.status}`;
    throw Object.assign(new Error(message), { status: response.status, code,
      charged: CHARGED_ON_ERROR[response.status] ?? 0,
      ...(code === "provider_timeout" || response.status >= 500 ? { retryable: true } : {}) });
  }
  try { return await response.json(); }
  catch { throw Object.assign(new Error("JobsPipe returned an unreadable response"), { code: "parse_drift" }); }
}

function diagnostic(error, credentials) {
  return { stage: "provider_request",
    ...Object.fromEntries(Object.entries(error ?? {}).filter(([key]) => PASSTHROUGH.has(key))),
    code: error?.code ?? "provider_error",
    ...(error?.code === "parse_drift" ? { parseDrift: true } : {}),
    error: redactSecrets(String(error?.message ?? error), credentials).slice(0, 500) };
}

export const jobspipe = {
  id: "jobspipe",
  quotaLimits: jobspipeQuotaLimits,
  // `quota` is the service's credit ledger for this source: `reserve(credits)`
  // grants at most the remaining monthly credits (or throws), `settle` records
  // the provider's charge, and `hold` pauses the source.
  async search({ limit = 25, fetchImpl = fetch, profile, query = {}, sourceConfig = {}, credentials, quota,
    searchTitles = [], searchCycle = 0,
    onError = () => {} }) {
    if (!credentials?.apiKey) throw Object.assign(new Error("source_not_configured"), { code: "source_not_configured" });
    if (!quota) throw new Error("jobspipe requires the durable credit ledger");
    const filters = validateJobspipeFilters(query);
    const settings = jobspipeSettings(sourceConfig);
    const plan = searchTitleQueryPlan(profile, searchTitles, { maximum: 16, cycle: searchCycle });
    const titles = filters.job_title_or ?? plan.queries.map((item) => item.term);
    if (!titles.length) return [];
    const excluded = [...new Set([...settings.excludeSources, ...(settings.defaults.source_not ?? []),
      ...(filters.source_not ?? [])])];
    const body = { ...DEFAULT_FILTERS,
      ...(settings.defaultCountries.length ? { job_country_code_or: settings.defaultCountries } : {}),
      ...settings.defaults,
      ...filters, job_title_or: titles, status: "active" };
    if (excluded.length) body.source_not = excluded;
    else delete body.source_not;
    const wanted = Math.max(1, Math.min(Number(limit) || 25, 200, settings.maxPages * settings.pageSize));
    const rows = [];
    let cursor = null;
    for (let page = 0; page < settings.maxPages && rows.length < wanted; page += 1) {
      let reservation;
      try { reservation = await quota.reserve(Math.min(settings.pageSize, wanted - rows.length)); }
      catch (error) { onError(diagnostic(error, credentials)); break; }
      let result;
      try {
        result = await request({ body: { ...body, limit: reservation.credits, ...(cursor ? { cursor } : {}) },
          credentials, fetchImpl });
      } catch (error) {
        // A request that never left the server costs nothing; one whose outcome
        // is unknown keeps its whole reservation.
        if (error?.notSent) await quota.settle(reservation, 0);
        else if (error?.charged !== undefined) await quota.settle(reservation, error.charged);
        if (error?.code === "key_rejected") await quota.hold("key_rejected");
        if (error?.status === 402) await quota.hold("quota_exhausted", { window: "credits_month" });
        onError(diagnostic(error, credentials));
        break;
      }
      const data = Array.isArray(result?.data) ? result.data : [];
      const charged = result?.metadata?.credits_charged;
      await quota.settle(reservation, Number.isFinite(charged) ? charged : data.length);
      rows.push(...data);
      cursor = typeof result?.metadata?.next_cursor === "string" ? result.metadata.next_cursor : null;
      if (!cursor || data.length < reservation.credits) break;
    }
    const now = Date.now();
    const unique = new Map(rows.filter((row) => open(row, now) && [row.apply_url, row.url, row.source_url].some(httpsUrl))
      .map((row) => [String(row.id), normalize(row)]));
    return [...unique.values()].slice(0, wanted);
  }
};
