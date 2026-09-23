#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";
import { extractSourcePage, isBlockingStatus, sourceAutomationPolicy } from "../src/discovery/browser-source.js";
import { parsePublicFeed, publicFeedUrl } from "../src/discovery/public-feeds.js";

const options = argumentsOf(process.argv.slice(2));
if (!options.campaign || !options.catalog) {
  console.error("usage: run-browser-source-campaign --campaign ID --catalog FILE [--server URL] [--token-file FILE] [--headed]");
  process.exit(2);
}
const catalog = JSON.parse(await readFile(path.resolve(options.catalog), "utf8"));
const priority = catalog.autonomousDiscovery?.priorityOrder ?? [];
const sources = [...(catalog.autonomousDiscovery?.visibleBrowserSources ?? [])]
  .sort((left, right) => rank(priority, left.id) - rank(priority, right.id));
const server = options.server ?? process.env.JOB_SERVER_URL ?? "http://127.0.0.1:4310";
const token = process.env.JOB_SERVER_TOKEN || (options.tokenFile
  ? (await readFile(path.resolve(options.tokenFile), "utf8")).trim() : "");
let browser; let context; let externallyOwned = false;
if (options.cdpEndpoint) {
  browser = await chromium.connectOverCDP(options.cdpEndpoint);
  externallyOwned = true;
  context = browser.contexts()[0] ?? await browser.newContext({ locale: "en-US", timezoneId: "Europe/Sofia" });
} else if (options.userDataDir) {
  context = await chromium.launchPersistentContext(path.resolve(options.userDataDir), {
    headless: options.headed !== true, channel: options.channel ?? "chrome",
    locale: "en-US", timezoneId: "Europe/Sofia"
  });
} else {
  browser = await chromium.launch({ headless: options.headed !== true });
  context = await browser.newContext({ locale: "en-US", timezoneId: "Europe/Sofia" });
}
await context.route(/\.(?:png|jpe?g|gif|webp|svg|woff2?|ttf|mp4|webm)(?:\?|$)/i, (route) => route.abort());
const hostLastRequest = new Map();

try {
  for (const source of sources) {
    const current = await api("GET", `/v1/campaigns/${options.campaign}`);
    if (!current.sourceCoverage?.fallbackRemaining?.includes(source.id)) continue;
    const policy = sourceAutomationPolicy(source, options);
    if (policy.manual) {
      const recorded = await report(source.id, [], { completed: true, exhausted: true,
        errors: [{ error: "source policy requires manual browser search" }] });
      progress(source.id, 0, accepted(recorded, source.id), "manual-policy");
      continue;
    }
    const result = await searchSource(source, policy);
    const recorded = await report(source.id, result.items, { completed: true, exhausted: result.exhausted,
      pagesVisited: result.pagesVisited, requestsMade: result.requestsMade,
      rateLimited: result.rateLimited, errors: result.errors });
    progress(source.id, result.items.length, accepted(recorded, source.id),
      result.rateLimited ? "rate-limited" : "complete");
  }
} finally {
  if (!externallyOwned) {
    await context.close();
    await browser?.close();
  }
}

async function searchSource(source, policy) {
  const page = await context.newPage();
  const items = new Map(); const visitedListings = new Set(); const visitedDetails = new Set(); const errors = [];
  let nextUrl = source.url; let pagesVisited = 0; let requestsMade = 0; let rateLimited = false;
  try {
    const feedQueries = source.id === "jobgether" ? jobgetherQueries(options.query) : [options.query ?? "engineer"];
    const feedUrl = publicFeedUrl(source.id, { query: feedQueries[0],
      limit: source.id === "remotive" || source.id === "weworkremotely" ? 100 : 10 });
    if (feedUrl) {
      const response = await fetch(feedUrl, { headers: { "user-agent": "job-application-system/1.0 personal search" },
        signal: AbortSignal.timeout(policy.navigationTimeoutMs) });
      requestsMade += 1; pagesVisited += 1;
      if (isBlockingStatus(response.status)) rateLimited = true;
      else if (!response.ok) errors.push({ error: `feed returned HTTP ${response.status}: ${feedUrl}` });
      else {
        const feed = parsePublicFeed(source.id, await response.text());
        if (source.id !== "jobgether") {
          for (const job of feed.items) add(items, job);
          return { items: [...items.values()].slice(0, policy.maxCandidates), pagesVisited, requestsMade,
            rateLimited, exhausted: !feed.hasMore, errors };
        }
        nextUrl = null;
        const seeds = new Map(feed.items.map((item) => [item.listingUrl, item]));
        let hasMore = feedQueries.length === 1 && feed.hasMore;
        while (pagesVisited < policy.maxListingPages && requestsMade < policy.maxRequests
          && seeds.size < policy.maxCandidates) {
          const query = feedQueries[pagesVisited] ?? feedQueries[0];
          if (!hasMore && pagesVisited >= feedQueries.length) break;
          const pageNumber = pagesVisited + 1;
          const pageUrl = publicFeedUrl(source.id, { query,
            page: feedQueries.length === 1 ? pageNumber : 1, limit: feedQueries.length === 1 ? 25 : 10 });
          const pageResponse = await fetch(pageUrl, { headers: {
            "user-agent": "job-application-system/1.0 personal search"
          }, signal: AbortSignal.timeout(policy.navigationTimeoutMs) });
          requestsMade += 1; pagesVisited += 1;
          if (isBlockingStatus(pageResponse.status)) { rateLimited = true; break; }
          if (!pageResponse.ok) {
            errors.push({ error: `feed returned HTTP ${pageResponse.status}: ${pageUrl}` });
            break;
          }
          const nextFeed = parsePublicFeed(source.id, await pageResponse.text());
          for (const item of nextFeed.items) seeds.set(item.listingUrl, item);
          hasMore = feedQueries.length === 1 && nextFeed.hasMore;
        }
        const detailQueue = [...seeds.keys()].slice(0, policy.maxDetailPages);
        while (detailQueue.length && requestsMade < policy.maxRequests && items.size < policy.maxCandidates) {
          const link = detailQueue.shift();
          const detail = await navigate(page, link, policy); requestsMade += 1;
          if (isBlockingStatus(detail.status)) { rateLimited = true; break; }
          if (!detail.ok) continue;
          const extracted = extractSourcePage(await page.content(), page.url(), source.id);
          if (extracted.jobs.length) {
            for (const job of extracted.jobs) add(items, { ...seeds.get(link), ...job,
              location: job.location || seeds.get(link)?.location,
              listingUrl: link, externalId: seeds.get(link)?.externalId ?? job.externalId });
          } else if (seeds.has(link)) add(items, seeds.get(link));
        }
        return { items: [...items.values()].slice(0, policy.maxCandidates), pagesVisited, requestsMade,
          rateLimited, exhausted: true, errors };
      }
    }
    while (nextUrl && pagesVisited < policy.maxListingPages && requestsMade < policy.maxRequests
      && items.size < policy.maxCandidates) {
      if (visitedListings.has(nextUrl)) break;
      visitedListings.add(nextUrl);
      const listing = await navigate(page, nextUrl, policy); requestsMade += 1;
      if (isBlockingStatus(listing.status)) { rateLimited = true; break; }
      if (!listing.ok) { errors.push({ error: `listing returned HTTP ${listing.status}: ${nextUrl}` }); break; }
      if (pagesVisited === 0) await applyBroadSearch(page, options.query ?? "engineer", options.location ?? "Bulgaria");
      pagesVisited += 1;
      const extracted = extractSourcePage(await page.content(), page.url(), source.id);
      for (const job of extracted.jobs) add(items, job);
      const detailQueue = [...extracted.jobLinks];
      while (detailQueue.length) {
        const link = detailQueue.shift();
        if (items.size >= policy.maxCandidates || visitedDetails.size >= policy.maxDetailPages
          || requestsMade >= policy.maxRequests) break;
        if (visitedDetails.has(link)) continue;
        visitedDetails.add(link);
        const detail = await navigate(page, link, policy); requestsMade += 1;
        if (isBlockingStatus(detail.status)) { rateLimited = true; break; }
        if (!detail.ok) continue;
        const detailPage = extractSourcePage(await page.content(), page.url(), source.id);
        for (const job of detailPage.jobs) add(items, job);
        if (!detailPage.jobs.length) {
          const nestedLinks = [];
          for (const nested of detailPage.jobLinks) {
            if (!visitedDetails.has(nested) && !detailQueue.includes(nested)) nestedLinks.push(nested);
          }
          detailQueue.unshift(...nestedLinks);
        }
      }
      if (rateLimited) break;
      nextUrl = extracted.nextUrl;
    }
  } catch (error) {
    errors.push({ error: String(error.message ?? error).slice(0, 500) });
  } finally { await page.close(); }
  return { items: [...items.values()].slice(0, policy.maxCandidates), pagesVisited, requestsMade,
    rateLimited, exhausted: !nextUrl || pagesVisited >= policy.maxListingPages || requestsMade >= policy.maxRequests,
    errors };
}

async function navigate(page, url, policy) {
  const host = new URL(url).hostname;
  const elapsed = Date.now() - (hostLastRequest.get(host) ?? 0);
  const wait = policy.minDelayMs + Math.floor(Math.random() * 500) - elapsed;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: policy.navigationTimeoutMs });
  await settle(page);
  hostLastRequest.set(host, Date.now());
  const status = response?.status() ?? 0;
  return { status, ok: status >= 200 && status < 400 };
}

async function applyBroadSearch(page, query, location) {
  const selectors = [
    'input[type="search"]', 'input[name*="keyword" i]', 'input[name*="search" i]',
    'input[placeholder*="job" i]', 'input[placeholder*="role" i]', 'input[placeholder*="keyword" i]'
  ];
  for (const selector of selectors) {
    const inputs = page.locator(selector);
    for (let index = 0; index < Math.min(await inputs.count(), 4); index += 1) {
      const input = inputs.nth(index);
      if (!await input.isVisible().catch(() => false)) continue;
      const before = page.url();
      await input.fill(query);
      const locationInput = page.locator('input[placeholder*="location" i]').filter({ visible: true }).first();
      if (await locationInput.isVisible().catch(() => false)) {
        await locationInput.fill(location);
        await page.waitForTimeout(400);
        const option = page.getByRole("option", { name: new RegExp(`^${escapePattern(location)}$`, "i") })
          .filter({ visible: true }).first();
        if (await option.isVisible().catch(() => false)) await option.click({ timeout: 2_000 }).catch(() => undefined);
      }
      const submit = page.locator("button[data-submit]").filter({ visible: true }).first();
      if (await submit.isVisible().catch(() => false)) {
        await submit.click({ timeout: 3_000, noWaitAfter: true }).catch(() => undefined);
      } else await input.press("Enter");
      await settle(page);
      if (page.url() === before) {
        const button = page.getByRole("button", { name: /^search$/i }).filter({ visible: true }).first();
        if (await button.isVisible().catch(() => false)) {
          await button.click({ timeout: 3_000, noWaitAfter: true }).catch(() => undefined);
          await settle(page);
        }
      }
      return true;
    }
  }
  return false;
}

function escapePattern(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function jobgetherQueries(query) {
  if (query && String(query).trim().toLowerCase() !== "engineer") return [String(query).trim()];
  return ["AI engineer", "backend engineer", "full stack engineer", "frontend engineer", "GIS developer"];
}

async function settle(page) {
  await page.waitForLoadState("networkidle", { timeout: 1_500 }).catch(() => undefined);
  await page.evaluate(() => window.scrollTo(0, Math.min(document.body.scrollHeight, 4000))).catch(() => undefined);
  await page.waitForTimeout(250);
}

async function report(sourceId, items, metadata) {
  return api("POST", `/v1/campaigns/${options.campaign}/source-results`, {
    sourceId, items: items.map(compactJob), ...metadata
  }, `source-${options.campaign}-${sourceId}-${Date.now()}`);
}

async function api(method, pathname, body, idempotencyKey) {
  const response = await fetch(`${server}${pathname}`, { method, headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body ? { "content-type": "application/json" } : {}),
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {})
  }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(120_000) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
  return payload;
}

function add(items, job) {
  if (!job?.title || !job?.company || !job?.applyUrl) return;
  items.set(job.externalId ?? job.applyUrl, job);
}

function compactJob(job) {
  return {
    source: job.source, externalId: clipped(job.externalId, 500), title: clipped(job.title, 300),
    company: clipped(job.company, 300), description: clipped(job.description, 12_000),
    location: clipped(job.location, 500), employmentType: clipped(job.employmentType, 100),
    remote: job.remote === true, postedAt: clipped(job.postedAt, 100),
    listingUrl: job.listingUrl, applyUrl: job.applyUrl, compensation: job.compensation,
    applicationDestinationVerified: job.applicationDestinationVerified === true,
    tags: job.tags?.slice(0, 100), uncertainties: job.uncertainties?.slice(0, 50)
  };
}

function clipped(value, size) { return value === undefined ? undefined : String(value).slice(0, size); }
function rank(values, id) { const index = values.indexOf(id); return index < 0 ? Number.MAX_SAFE_INTEGER : index; }

function accepted(campaign, sourceId) {
  return campaign.sourceCoverage?.scans?.filter((scan) => scan.sourceId === sourceId)
    .reduce((sum, scan) => sum + Number(scan.selected ?? 0), 0) ?? 0;
}

function progress(source, found, acceptedCount, status) {
  process.stdout.write(`${JSON.stringify({ source, found, accepted: acceptedCount, status })}\n`);
}

function argumentsOf(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--headed") result.headed = true;
    else if (value.startsWith("--")) result[toCamel(value.slice(2))] = values[++index];
  }
  return result;
}
function toCamel(value) { return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()); }
