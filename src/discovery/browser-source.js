import { parseJobPostingsJsonLd } from "./normalization.js";

const JOB_PATH = /\/(?:jobs?|careers?|positions?|vacanc(?:y|ies)|openings?|opportunities?|offers?|remote-jobs|job-search)(?:\/|\?|$)/i;
const EXCLUDED_PATH = /\/(?:login|sign-?in|register|about|privacy|terms|blog)(?:\/|\?|$)/i;
const NEXT_TEXT = /^(?:next|next page|older|more|›|»|→)$/i;
const ATS_HOST = /(?:ashbyhq\.com|greenhouse\.io|lever\.co|workable\.com|smartrecruiters\.com)$/i;

export function extractSourcePage(html, pageUrl, sourceId) {
  const visible = visibleText(html);
  const currentText = visible.split(/\n(?:similar|recommended|related) jobs?\b/i)[0];
  const currentLocation = isDetailPage(pageUrl) ? currentPostingLocation(html, sourceId) : null;
  const compatibleLocation = isDetailPage(pageUrl) ? explicitRemoteLocation(currentText) : null;
  const structured = parseJobPostingsJsonLd(html, { source: sourceId, pageUrl })
    .filter((job) => meaningful(job.title) && meaningful(job.company) && /^https:\/\//i.test(job.applyUrl ?? ""));
  for (const job of structured) {
    if (compatibleLocation && (!job.location || job.remote !== true)) {
      job.location = compatibleLocation;
      job.remote = true;
      job.uncertainties = [...new Set([...(job.uncertainties ?? []), "remote_scope_from_visible_page"])];
    }
  }
  const fallback = structured.length ? null : fallbackJob(html, pageUrl, sourceId, currentText, currentLocation);
  let jobs = fallback ? [...structured, fallback] : structured;
  const anchors = [...String(html).matchAll(/<a\b([^>]*?)href\s*=\s*["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi)]
    .map((match) => ({ attributes: `${match[1]} ${match[3]}`, href: absoluteUrl(match[2], pageUrl),
      text: plain(match[4]) })).filter((item) => item.href);
  const pageHost = new URL(pageUrl).hostname.replace(/^www\./, "");
  const linkScores = new Map(anchors.map((item) => {
    const url = new URL(item.href);
    const sameHost = url.hostname.replace(/^www\./, "") === pageHost;
    const score = !EXCLUDED_PATH.test(url.pathname) && (sameHost || ATS_HOST.test(url.hostname))
      ? jobLinkScore(url, item.text) : 0;
    return [item.href, score];
  }).filter(([, score]) => score > 0));
  let jobLinks = [...linkScores.entries()]
    .sort((left, right) => right[1] - left[1]).map(([url]) => url);
  const explicitNext = anchors.find((item) => /\brel\s*=\s*["']?next\b/i.test(item.attributes)
    || /\baria-label\s*=\s*["'][^"']*next/i.test(item.attributes));
  const textNext = anchors.find((item) => NEXT_TEXT.test(item.text));
  const nextUrl = explicitNext?.href ?? textNext?.href;
  const normalizedPage = absoluteUrl(pageUrl, pageUrl);
  const applyLink = isDetailPage(pageUrl) ? anchors.find((item) => /^apply(?:\s+(?:now|for|to))?\b/i.test(item.text)
    && item.href !== normalizedPage) : null;
  if (applyLink) jobs = jobs.map((job) => ({ ...job, listingUrl: pageUrl,
    applyUrl: applyLink.href, applicationDestinationVerified: true }));
  jobLinks = jobLinks.filter((url) => url !== nextUrl && url !== normalizedPage);
  return { jobs: uniqueJobs(jobs), jobLinks, nextUrl };
}

export function sourceAutomationPolicy(source, overrides = {}) {
  const manual = /use manually|prohibits? (?:scraping|automated)/i.test(source.screeningNote ?? "")
    || source.automation?.mode === "manual";
  return {
    manual, maxAcceptedResults: 10,
    maxCandidates: bounded(overrides.maxCandidates ?? source.automation?.maxCandidates, 10, 100, 50),
    maxListingPages: bounded(overrides.maxListingPages ?? source.automation?.maxListingPages, 1, 10, 5),
    maxDetailPages: bounded(overrides.maxDetailPages ?? source.automation?.maxDetailPages, 1, 100, 35),
    maxRequests: bounded(overrides.maxRequests ?? source.automation?.maxRequests, 1, 150, 45),
    minDelayMs: bounded(overrides.minDelayMs ?? source.automation?.minDelayMs, 500, 30_000, 1_500),
    navigationTimeoutMs: bounded(overrides.navigationTimeoutMs
      ?? source.automation?.navigationTimeoutMs, 5_000, 120_000, 15_000)
  };
}

export function isBlockingStatus(status) { return status === 403 || status === 429; }

function fallbackJob(html, pageUrl, sourceId, currentText = visibleText(html), currentLocation) {
  const visible = currentText;
  const pageTitle = plain(first(html, /<title[^>]*>([\s\S]*?)<\/title>/i));
  const heading = plain(first(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i));
  const combined = meta(html, "og:title") || pageTitle;
  const at = combined.match(/^(.{2,200}?)\s+at\s+(.{2,160}?)(?:\s+[|—–-]\s+|$)/i);
  const title = clean(heading || at?.[1], 300);
  const company = clean(at?.[2], 300);
  const location = currentLocation ?? explicitRemoteLocation(visible);
  if (!meaningful(title) || !meaningful(company) || !location || /\bjobs?\s*$/i.test(title)) return null;
  return { source: sourceId, title, company, description: visible.slice(0, 50_000),
    location: compatibleRemoteLocation(location), remote: true, employmentType: employmentType(visible),
    listingUrl: pageUrl, applyUrl: pageUrl, uncertainties: ["dom_fallback_extraction"] };
}

function currentPostingLocation(html, sourceId) {
  if (sourceId !== "workingnomads") return null;
  const match = String(html).match(/fa-map-marker[\s\S]{0,300}?<span[^>]*>([\s\S]*?)<\/span>/i);
  return meaningful(plain(match?.[1])) ? plain(match[1]) : null;
}

function compatibleRemoteLocation(location) {
  return /\b(remote|distributed)\b/i.test(location) ? location
    : /\b(Bulgaria|EU|EEA|Europe|European|EMEA|worldwide|anywhere|global)\b/i.test(location)
      ? `Remote, ${location}` : location;
}

function visibleText(html) {
  return plain(String(html).replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<\/(?:p|div|li|section|h[1-6]|main|article)>/gi, "\n"));
}

function isDetailPage(pageUrl) {
  try {
    const path = new URL(pageUrl).pathname;
    if (/\/remote-jobs\//i.test(path)) return false;
    return /\/(?:job|jobs|offer|offers|position|positions|vacancy|vacancies)\/[^/?#]+/i.test(path);
  }
  catch { return false; }
}

function explicitRemoteLocation(text) {
  const labelled = text.match(/(?:remote\s+location|location|eligible\s+locations?|work\s+from)\s*:?\s*([^\n]{0,140})/i)?.[1];
  const region = String(labelled ?? "").match(/\b(Bulgaria|EU|EEA|Europe|European|EMEA|worldwide|anywhere|global)\b/i)?.[1]
    ?? text.match(/\b(?:remote|distributed)[^\n]{0,80}\b(Bulgaria|EU|EEA|Europe|European|EMEA|worldwide|anywhere|global)\b/i)?.[1]
    ?? text.match(/\b(Bulgaria|EU|EEA|Europe|European|EMEA|worldwide|anywhere|global)\b[^\n]{0,80}\b(?:remote|distributed)\b/i)?.[1];
  return region ? `Remote, ${region}` : null;
}

function employmentType(text) {
  if (/\bfull[ -]?time\b/i.test(text)) return "full_time";
  if (/\bpart[ -]?time\b/i.test(text)) return "part_time";
  if (/\b(contract|freelance)\b/i.test(text)) return "contract";
  return undefined;
}

function clean(value, maximum) {
  const text = plain(value).replace(/\s+[|—–]\s+.*$/, "").trim();
  return text.length >= 2 && text.length <= maximum && /[a-z]/i.test(text) ? text : null;
}

function meta(html, name) {
  for (const tag of String(html).match(/<meta\b[^>]*>/gi) ?? []) {
    const key = first(tag, /(?:property|name)\s*=\s*["']([^"']+)["']/i);
    if (String(key).toLowerCase() === name.toLowerCase()) {
      return plain(first(tag, /content\s*=\s*["']([^"']*)["']/i));
    }
  }
  return "";
}

function first(value, pattern) { return String(value).match(pattern)?.[1] ?? ""; }

function uniqueJobs(jobs) {
  return [...new Map(jobs.map((job) => [job.externalId ?? job.applyUrl, job])).values()];
}

function jobLinkScore(url, text) {
  const path = `${url.pathname}${url.search}`;
  if (/\/(?:offers?|positions?|vacanc(?:y|ies)|openings?)\/[^/?#]+/i.test(path)) return 100;
  if (/\/companies\/[^/]+\/jobs\/[^/?#]+/i.test(path)) return 95;
  if (/\/jobs?\/(?!company-|companies|categories|locations?)[^/?#]+/i.test(path)) return 90;
  if (/\/remote-jobs\/(?!company-|companies|categories|locations?)[^/?#]+/i.test(path)
    && /\b(?:engineer|developer|scientist|architect|manager|analyst)\b/i.test(text)
    && !/\bjobs?\s*$/i.test(text)) return 80;
  if (JOB_PATH.test(path) && /\b(?:apply|engineer|developer|scientist|architect|manager|analyst)\b/i.test(text)) return 60;
  return 0;
}

function meaningful(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return Boolean(text && !["undefined", "null", "n/a", "unknown"].includes(text));
}

function absoluteUrl(raw, base) {
  try {
    const decoded = String(raw).replace(/&amp;/gi, "&").replace(/&#38;/g, "&");
    const url = new URL(decoded, base);
    if (url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch { return null; }
}

function plain(value) { return String(value).replace(/<[^>]*>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/[ \t\r\f\v]+/g, " ").replace(/ *\n */g, "\n").trim(); }
function bounded(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, Math.trunc(number))) : fallback;
}
