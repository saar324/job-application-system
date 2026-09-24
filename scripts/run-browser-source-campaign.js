#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { extractSourcePage, isBlockingStatus, isChallengePage,
  sourceAutomationPolicy } from "../src/discovery/browser-source.js";
import { parsePublicFeed, publicFeedUrl } from "../src/discovery/public-feeds.js";
import { SourceProgress } from "../src/discovery/source-progress.js";
import { SourceJournal } from "../src/discovery/source-journal.js";
import { SourceBudget, SourceTimeoutError } from "../src/discovery/source-budget.js";
import { settleSourcePage } from "../src/discovery/browser-settle.js";
import { nextQueryPage } from "../src/discovery/query-pagination.js";
import { searchTitleQueryPlan } from "../src/discovery/search-title-queries.js";
import { browserListingPlan } from "../src/discovery/browser-listing-plan.js";

const options = argumentsOf(process.argv.slice(2));
if (!options.campaign || !options.catalog) {
  console.error("usage: run-browser-source-campaign --campaign ID --catalog FILE [--server URL] [--token-file FILE] [--source-timeout-ms 50000] [--headed]");
  process.exit(2);
}
const catalog = JSON.parse(await readFile(path.resolve(options.catalog), "utf8"));
const querySeed = options.queryPlanFile
  ? JSON.parse(await readFile(path.resolve(options.queryPlanFile), "utf8")) : null;
const sourceContext = { residenceCountry: catalog.searchPolicy?.residenceCountry };
const priority = catalog.autonomousDiscovery?.priorityOrder ?? [];
const sources = [...(catalog.autonomousDiscovery?.visibleBrowserSources ?? [])]
  .sort((left, right) => rank(priority, left.id) - rank(priority, right.id));
const server = options.server ?? process.env.JOB_SERVER_URL ?? "http://127.0.0.1:4310";
const token = process.env.JOB_SERVER_TOKEN || (options.tokenFile
  ? (await readFile(path.resolve(options.tokenFile), "utf8")).trim() : "");
let browser; let context; let externallyOwned = false;
const hostLastRequest = new Map();

async function ensureContext() {
  if (context) return;
  if (options.cdpEndpoint) {
    browser = await chromium.connectOverCDP(options.cdpEndpoint);
    externallyOwned = true;
    context = browser.contexts()[0] ?? await browser.newContext({ locale: "en-US", timezoneId: "UTC" });
  } else if (options.userDataDir) {
    context = await chromium.launchPersistentContext(path.resolve(options.userDataDir), {
      headless: options.headed !== true, channel: options.channel ?? "chrome",
      locale: "en-US", timezoneId: "UTC"
    });
  } else {
    browser = await chromium.launch({ headless: options.headed !== true });
    context = await browser.newContext({ locale: "en-US", timezoneId: "UTC" });
  }
  await context.route(/\.(?:png|jpe?g|gif|webp|svg|woff2?|ttf|mp4|webm)(?:\?|$)/i,
    (route) => route.abort());
}

try {
  for (const source of sources) {
    const sourceStarted = performance.now();
    const policy = sourceAutomationPolicy(source, options);
    const journal = new SourceJournal({ campaignId: options.campaign,
      sourceId: source.id, directory: options.progressDirectory });
    const totalBudget = new SourceBudget(policy.sourceTimeoutMs);
    const current = await api("GET", `/v1/campaigns/${options.campaign}`,
      undefined, undefined, totalBudget.timeoutMs(5_000));
    if (!current.sourceCoverage?.fallbackRemaining?.includes(source.id)) {
      await journal.clear();
      continue;
    }
    const cooldown = current.sourceCoverage.cooldowns?.[source.id];
    if (cooldown) {
      const discarded = (await journal.load()).length;
      const recorded = await report(source.id, [], { completed: true, cooldownSkipped: true,
        pagesVisited: 0, requestsMade: 0, exhausted: false,
        elapsedMs: Math.round(performance.now() - sourceStarted),
        discardedObservedCandidates: discarded,
        ...(discarded ? { discardReason: "source_cooldown" } : {}) }, totalBudget.timeoutMs(7_000));
      await journal.clear();
      progress(source.id, 0, accepted(recorded, source.id), "cooldown", {
        reason: cooldown.reason, until: cooldown.until });
      continue;
    }
    if (policy.manual) {
      const discarded = (await journal.load()).length;
      const recorded = await report(source.id, [], { completed: true, exhausted: false, manual: true,
        elapsedMs: Math.round(performance.now() - sourceStarted),
        discardedObservedCandidates: discarded,
        ...(discarded ? { discardReason: "manual_source_policy" } : {}),
        errors: [{ error: "source policy requires manual browser search" }] },
      totalBudget.timeoutMs(7_000));
      await journal.clear();
      progress(source.id, 0, accepted(recorded, source.id), "manual-policy");
      continue;
    }
    await ensureContext();
    const budget = new SourceBudget(Math.max(1_000, totalBudget.remainingMs() - 7_000));
    const pending = await journal.load();
    const progressState = new SourceProgress({ sourceId: source.id,
      maxAcceptedResults: policy.maxAcceptedResults, maxBatch: Math.min(10, policy.maxCandidates),
      journal, pending,
      report: (sourceId, items, metadata) => report(sourceId, items, metadata,
        metadata.completed ? totalBudget.timeoutMs(7_000) : budget.timeoutMs(120_000)) });
    if (pending.length) await progressState.flush();
    const result = await searchSource(source, policy, progressState, budget,
      current.sourceCycles?.[source.id] ?? 0);
    if (!result.timedOut && progressState.pending.length && budget.remainingMs() < 2_000) {
      result.timedOut = true;
      result.exhausted = false;
      result.errors.push({ error: "source wall-clock budget exceeded before final batch" });
    }
    const recorded = await progressState.finish({ exhausted: result.exhausted,
      elapsedMs: Math.round(performance.now() - sourceStarted),
      pagesVisited: result.pagesVisited, requestsMade: result.requestsMade,
      rateLimited: result.rateLimited, challenge: result.challenge, timedOut: result.timedOut,
      parseDrift: result.parseDrift, sourceFailure: result.errors.length > 0,
      stopReason: result.stopReason, partialReasons: result.partialReasons,
      queryStats: result.queryStats,
      errors: result.errors });
    progress(source.id, progressState.found, accepted(recorded, source.id),
      result.rateLimited ? "rate-limited" : result.challenge ? "challenge"
        : result.timedOut ? "timed-out" : "complete");
  }
} finally {
  if (!externallyOwned) {
    await context?.close();
    await browser?.close();
  }
}

async function searchSource(source, policy, progressState, budget, sourceCycle = 0) {
  let page;
  const visitedListings = new Set(); const visitedDetails = new Set(); const errors = [];
  let observedNextPage = false;
  const listingPlan = browserListingPlan(source, sourceCycle, sourceContext);
  let nextUrl = listingPlan.url; let pagesVisited = 0; let requestsMade = 0;
  let rateLimited = false; let challenge = false; let parseDrift = false; let timedOut = false;
  let stopReason = null; let queryStats = [];
  try {
    page = await budget.run(() => context.newPage());
    const queryPlan = source.id === "jobgether"
      ? jobgetherQueryPlan(options.query, policy, sourceCycle) : null;
    const feedQueries = queryPlan ? queryPlan.queries.map((item) => item.term)
      : [options.query ?? "engineer"];
    if (queryPlan) {
      progress(source.id, 0, 0, "query-plan", { cycle: queryPlan.cycle,
        queries: queryPlan.queries.map(({ term, origin }) => ({ term, origin })),
        skippedTerms: queryPlan.skippedTerms,
        coverageBlocked: queryPlan.coverageBlocked });
    }
    if (listingPlan.origin !== "catalog") {
      progress(source.id, 0, 0, "listing-plan", { cycle: listingPlan.cycle,
        origin: listingPlan.origin, roleFamily: listingPlan.roleFamily,
        url: listingPlan.url });
    }
    if (!feedQueries.length) {
      errors.push({ error: "no verified or configured browser search titles" });
      nextUrl = null;
      return result(false);
    }
    const feedUrl = publicFeedUrl(source.id, { query: feedQueries[0], ...sourceContext,
      limit: source.id === "jobgether" ? 25
        : source.id === "remotive" || source.id === "weworkremotely" ? 100 : 10 });
    if (feedUrl) {
      requestsMade += 1;
      const response = await politeFeedFetch(feedUrl, policy, budget);
      pagesVisited += 1;
      if (isBlockingStatus(response.status)) { rateLimited = true; return result(); }
      else if (!response.ok) {
        errors.push({ error: `feed returned HTTP ${response.status}: ${feedUrl}` });
        return result();
      }
      else {
        const feedText = await budget.run(() => response.text());
        if (isChallengePage(feedText)) { challenge = true; return result(); }
        const feed = parsePublicFeed(source.id, feedText);
        if (source.id !== "jobgether") {
          await budget.run(() => progressState.add(feed.items));
          await budget.run(() => progressState.flush());
          return result(!feed.hasMore);
        }
        nextUrl = null;
        const seeds = new Map();
        const linksByQuery = feedQueries.map(() => []);
        queryStats = feedQueries.map((term) => ({ term, pages: 0, rawRows: 0,
          uniqueRows: 0, detailAttempts: 0, extractedJobs: 0 }));
        const firstQueryForLink = new Map();
        const addSeeds = (items, queryIndex) => {
          queryStats[queryIndex].pages += 1;
          queryStats[queryIndex].rawRows += items.length;
          for (const item of items) {
            if (!seeds.has(item.listingUrl)) {
              linksByQuery[queryIndex].push(item.listingUrl);
              firstQueryForLink.set(item.listingUrl, queryIndex);
              queryStats[queryIndex].uniqueRows += 1;
            }
            seeds.set(item.listingUrl, item);
          }
        };
        addSeeds(feed.items, 0);
        const cursors = feedQueries.map((query, index) => ({ query,
          page: index === 0 ? 2 : 1,
          hasMore: index === 0 ? feed.hasMore : true }));
        let lastQueryIndex = 0;
        while (pagesVisited < policy.maxListingPages && requestsMade < policy.maxRequests
          && !progressState.done) {
          budget.timeoutMs(1);
          const next = nextQueryPage(cursors, lastQueryIndex);
          if (!next) break;
          const pageUrl = publicFeedUrl(source.id, { query: next.query, ...sourceContext,
            page: next.page, limit: 25 });
          requestsMade += 1;
          const pageResponse = await politeFeedFetch(pageUrl, policy, budget);
          pagesVisited += 1;
          if (isBlockingStatus(pageResponse.status)) { rateLimited = true; break; }
          if (!pageResponse.ok) {
            errors.push({ error: `feed returned HTTP ${pageResponse.status}: ${pageUrl}` });
            break;
          }
          const nextText = await budget.run(() => pageResponse.text());
          if (isChallengePage(nextText)) { challenge = true; break; }
          const nextFeed = parsePublicFeed(source.id, nextText);
          addSeeds(nextFeed.items, next.index);
          cursors[next.index].page += 1;
          cursors[next.index].hasMore = nextFeed.hasMore;
          lastQueryIndex = next.index;
        }
        const detailLinks = [];
        while (linksByQuery.some((links) => links.length)) {
          for (const links of linksByQuery) {
            if (links.length) detailLinks.push(links.shift());
          }
        }
        const detailQueue = detailLinks.slice(0, policy.maxDetailPages);
        while (detailQueue.length && requestsMade < policy.maxRequests && !progressState.done
          && !challenge && !rateLimited) {
          budget.timeoutMs(1);
          const link = detailQueue.shift();
          const queryIndex = firstQueryForLink.get(link);
          if (queryIndex !== undefined) queryStats[queryIndex].detailAttempts += 1;
          requestsMade += 1;
          const detail = await navigate(page, link, policy, budget);
          if (isBlockingStatus(detail.status)) { rateLimited = true; break; }
          if (detail.challenge) { challenge = true; break; }
          if (!detail.ok) continue;
          const extracted = extractSourcePage(await budget.run(() => page.content()),
            page.url(), source.id, sourceContext);
          if (queryIndex !== undefined) queryStats[queryIndex].extractedJobs += extracted.jobs.length;
          if (extracted.jobs.length) {
            await budget.run(() => progressState.add(extracted.jobs.map((job) => ({ ...seeds.get(link), ...job,
              location: job.location || seeds.get(link)?.location,
              listingUrl: link, externalId: seeds.get(link)?.externalId ?? job.externalId }))));
          } else if (seeds.has(link)) await budget.run(() => progressState.add([seeds.get(link)]));
          await budget.run(() => progressState.flush());
        }
        progress(source.id, progressState.found, progressState.accepted, "query-yield",
          { queries: queryStats });
        if (detailLinks.length > policy.maxDetailPages) stopReason = "detail_page_cap";
        return result(!cursors.some((cursor) => cursor.hasMore)
          && detailLinks.length <= policy.maxDetailPages && detailQueue.length === 0);
      }
    }
    while (nextUrl && pagesVisited < policy.maxListingPages && requestsMade < policy.maxRequests
      && !progressState.done) {
      budget.timeoutMs(1);
      if (visitedListings.has(nextUrl)) break;
      visitedListings.add(nextUrl);
      requestsMade += 1;
      const listing = await navigate(page, nextUrl, policy, budget);
      if (isBlockingStatus(listing.status)) { rateLimited = true; break; }
      if (listing.challenge) { challenge = true; break; }
      if (!listing.ok) { errors.push({ error: `listing returned HTTP ${listing.status}: ${nextUrl}` }); break; }
      if (pagesVisited === 0) await budget.run(() => applyBroadSearch(page,
        options.query ?? "engineer", options.location ?? "", budget));
      pagesVisited += 1;
      const extracted = extractSourcePage(await budget.run(() => page.content()),
        page.url(), source.id, sourceContext);
      await budget.run(() => progressState.add(extracted.jobs));
      await budget.run(() => progressState.flush());
      const detailQueue = [...extracted.jobLinks];
      while (detailQueue.length) {
        const link = detailQueue.shift();
        if (progressState.done || visitedDetails.size >= policy.maxDetailPages
          || requestsMade >= policy.maxRequests) break;
        if (visitedDetails.has(link)) continue;
        visitedDetails.add(link);
        budget.timeoutMs(1);
        requestsMade += 1;
        const detail = await navigate(page, link, policy, budget);
        if (isBlockingStatus(detail.status)) { rateLimited = true; break; }
        if (detail.challenge) { challenge = true; break; }
        if (!detail.ok) continue;
        const detailPage = extractSourcePage(await budget.run(() => page.content()),
          page.url(), source.id, sourceContext);
        await budget.run(() => progressState.add(detailPage.jobs));
        await budget.run(() => progressState.flush());
        if (!detailPage.jobs.length) {
          const nestedLinks = [];
          for (const nested of detailPage.jobLinks) {
            if (!visitedDetails.has(nested) && !detailQueue.includes(nested)) nestedLinks.push(nested);
          }
          detailQueue.unshift(...nestedLinks);
        }
      }
      if (rateLimited || challenge) break;
      if (extracted.nextUrl) observedNextPage = true;
      nextUrl = extracted.nextUrl;
    }
  } catch (error) {
    if (error instanceof SourceTimeoutError || budget.remainingMs() <= 0) timedOut = true;
    else errors.push({ error: String(error.message ?? error).slice(0, 500) });
  } finally {
    if (page) await Promise.race([page.close().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2_000))]);
  }
  if (timedOut) errors.push({ error: "source wall-clock budget exceeded" });
  parseDrift = visitedDetails.size > 0 && progressState.found === 0
    && !rateLimited && !challenge && !timedOut;
  // A single static browser page with no visible Next control does not prove
  // the provider's result set is complete (many sites use infinite scroll).
  return result(observedNextPage && !nextUrl);

  function result(exhausted = false) {
    if (budget.remainingMs() <= 0 && !rateLimited && !challenge) {
      timedOut = true;
      if (!errors.some((item) => item.error === "source wall-clock budget exceeded")) {
        errors.push({ error: "source wall-clock budget exceeded" });
      }
    }
    const complete = exhausted && !timedOut && !rateLimited && !challenge;
    stopReason ??= timedOut ? "timeout" : rateLimited ? "rate_limit"
      : challenge ? "challenge" : parseDrift ? "parse_drift"
        : complete ? "provider_exhausted" : progressState.done ? "accepted_target"
          : requestsMade >= policy.maxRequests ? "request_cap"
            : pagesVisited >= policy.maxListingPages ? "listing_page_cap"
              : visitedDetails.size >= policy.maxDetailPages ? "detail_page_cap"
                : errors.length ? "partial_error" : "unknown_partial";
    return { pagesVisited, requestsMade, rateLimited, challenge, timedOut, parseDrift,
      exhausted: complete, stopReason,
      partialReasons: stopReason.endsWith("_cap") ? [stopReason] : [],
      queryStats, errors };
  }
}

async function navigate(page, url, policy, budget) {
  const host = new URL(url).hostname;
  const elapsed = Date.now() - (hostLastRequest.get(host) ?? 0);
  const wait = policy.minDelayMs + Math.floor(Math.random() * 500) - elapsed;
  if (wait > 0) await budget.sleep(wait);
  const response = await budget.run(() => page.goto(url, { waitUntil: "domcontentloaded",
    timeout: budget.timeoutMs(policy.navigationTimeoutMs) }));
  await settleSourcePage(page, budget);
  hostLastRequest.set(host, Date.now());
  const status = response?.status() ?? 0;
  const challenge = status >= 200 && status < 400
    && isChallengePage(await budget.run(() => page.content()));
  return { status, challenge, ok: status >= 200 && status < 400 && !challenge };
}

async function politeFeedFetch(url, policy, budget) {
  const host = new URL(url).hostname;
  const elapsed = Date.now() - (hostLastRequest.get(host) ?? 0);
  const wait = policy.minDelayMs + Math.floor(Math.random() * 500) - elapsed;
  if (wait > 0) await budget.sleep(wait);
  const response = await budget.run(() => fetch(url, { headers: {
    "user-agent": "job-application-system/1.0"
  }, signal: AbortSignal.timeout(budget.timeoutMs(policy.navigationTimeoutMs)) }));
  hostLastRequest.set(host, Date.now());
  return response;
}

async function applyBroadSearch(page, query, location, budget) {
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
        await budget.sleep(400);
        const option = page.getByRole("option", { name: new RegExp(`^${escapePattern(location)}$`, "i") })
          .filter({ visible: true }).first();
        if (await option.isVisible().catch(() => false)) await option.click({ timeout: 2_000 }).catch(() => undefined);
      }
      const submit = page.locator("button[data-submit]").filter({ visible: true }).first();
      if (await submit.isVisible().catch(() => false)) {
        await submit.click({ timeout: 3_000, noWaitAfter: true }).catch(() => undefined);
      } else await input.press("Enter");
      await settleSourcePage(page, budget);
      if (page.url() === before) {
        const button = page.getByRole("button", { name: /^search$/i }).filter({ visible: true }).first();
        if (await button.isVisible().catch(() => false)) {
          await button.click({ timeout: 3_000, noWaitAfter: true }).catch(() => undefined);
          await settleSourcePage(page, budget);
        }
      }
      return true;
    }
  }
  return false;
}

function escapePattern(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function jobgetherQueryPlan(query, policy, sourceCycle = 0) {
  if (query && String(query).trim().toLowerCase() !== "engineer") {
    return { queries: [{ term: String(query).trim(), origin: "explicit" }],
      skippedTerms: [], coverageBlocked: false, cycle: null };
  }
  if (querySeed) {
    const titles = querySeed.verifiedSubmittedTitles ?? [];
    if (!querySeed.profile || !Array.isArray(titles)
      || Object.keys(querySeed.profile).some((key) => key !== "preferences")
      || titles.some((title) => typeof title !== "string")) {
      throw new Error("query plan file requires preference-only profile and verifiedSubmittedTitles");
    }
    const cycle = Number(options.searchCycle ?? querySeed.cycle ?? sourceCycle);
    if (!Number.isInteger(cycle) || cycle < 0) throw new Error("search-cycle must be nonnegative");
    return searchTitleQueryPlan(querySeed.profile, titles,
      { maximum: Math.min(16, policy.maxListingPages), cycle });
  }
  return { queries: ["engineer", "developer", "programmer", "software"]
    .slice(0, policy.maxListingPages).map((term) => ({ term, origin: "default" })),
  skippedTerms: [], coverageBlocked: false, cycle: null };
}

async function report(sourceId, items, metadata, timeoutMs = 120_000) {
  const body = {
    sourceId, items: items.map(compactJob), ...metadata
  };
  const digest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return api("POST", `/v1/campaigns/${options.campaign}/source-results`, body,
    `source-${options.campaign}-${sourceId}-${digest}`, timeoutMs);
}

async function api(method, pathname, body, idempotencyKey, timeoutMs = 120_000) {
  const response = await fetch(`${server}${pathname}`, { method, headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body ? { "content-type": "application/json" } : {}),
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {})
  }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
  return payload;
}

function compactJob(job) {
  return {
    source: job.source, externalId: clipped(job.externalId, 500), title: clipped(job.title, 300),
    company: clipped(job.company, 300), description: clipped(job.description, 12_000),
    location: clipped(job.location, 500), employmentType: clipped(job.employmentType, 100),
    remote: job.remote === true, postedAt: clipped(job.postedAt, 100),
    listingUrl: job.listingUrl, applyUrl: job.applyUrl, sourceUrl: job.sourceUrl,
    compensation: job.compensation,
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

function progress(source, found, acceptedCount, status, extra = {}) {
  process.stdout.write(`${JSON.stringify({ source, found, accepted: acceptedCount, status, ...extra })}\n`);
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
