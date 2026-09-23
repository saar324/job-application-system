import { parseJobPostingsJsonLd } from "./normalization.js";

const JOB_PATH = /\/(?:jobs?|careers?|positions?|vacanc(?:y|ies)|openings?|opportunities?|offers?|remote-jobs|job-search)(?:\/|\?|$)/i;
const EXCLUDED_PATH = /\/(?:login|sign-?in|register|about|privacy|terms|blog|employers?|companies)(?:\/|\?|$)/i;
const NEXT_TEXT = /^(?:next|next page|older|more|›|»|→)$/i;
const ATS_HOST = /(?:ashbyhq\.com|greenhouse\.io|lever\.co|workable\.com|smartrecruiters\.com)$/i;

export function extractSourcePage(html, pageUrl, sourceId) {
  const jobs = parseJobPostingsJsonLd(html, { source: sourceId, pageUrl })
    .filter((job) => job.title && job.company && /^https:\/\//i.test(job.applyUrl ?? ""));
  const anchors = [...String(html).matchAll(/<a\b([^>]*?)href\s*=\s*["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi)]
    .map((match) => ({ attributes: `${match[1]} ${match[3]}`, href: absoluteUrl(match[2], pageUrl),
      text: plain(match[4]) })).filter((item) => item.href);
  const pageHost = new URL(pageUrl).hostname.replace(/^www\./, "");
  let jobLinks = [...new Set(anchors.filter((item) => {
    const url = new URL(item.href);
    const sameHost = url.hostname.replace(/^www\./, "") === pageHost;
    return !EXCLUDED_PATH.test(url.pathname) && JOB_PATH.test(`${url.pathname}${url.search}`)
      && (sameHost || ATS_HOST.test(url.hostname));
  }).map((item) => item.href))];
  const explicitNext = anchors.find((item) => /\brel\s*=\s*["']?next\b/i.test(item.attributes)
    || /\baria-label\s*=\s*["'][^"']*next/i.test(item.attributes));
  const textNext = anchors.find((item) => NEXT_TEXT.test(item.text));
  const nextUrl = explicitNext?.href ?? textNext?.href;
  const normalizedPage = absoluteUrl(pageUrl, pageUrl);
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
      ?? source.automation?.navigationTimeoutMs, 5_000, 120_000, 30_000)
  };
}

export function isBlockingStatus(status) { return status === 403 || status === 429; }

function uniqueJobs(jobs) {
  return [...new Map(jobs.map((job) => [job.externalId ?? job.applyUrl, job])).values()];
}

function absoluteUrl(raw, base) {
  try {
    const url = new URL(raw, base);
    if (url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch { return null; }
}

function plain(value) { return String(value).replace(/<[^>]*>/g, " ").replace(/&(?:nbsp|amp|lt|gt);/g, " ")
  .replace(/\s+/g, " ").trim(); }
function bounded(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, Math.trunc(number))) : fallback;
}
