# All-source application campaign

## Goal

Build one high-quality candidate pool from every configured autonomous source before preparing applications. Each source
may contribute up to 10 roles after deterministic removal of known, handled, duplicate, stale, location-ineligible, title-
ineligible, and compensation-conflicting records.

## Flow

1. `run-all-source-campaign.js` reads the private source catalog and creates one campaign.
2. The seven server adapters search their official or public feeds with a limit of 10 per source.
3. The browser runner visits each visible source sequentially. It uses the source's prefiltered URL, applies a broad job
   query when a visible search box exists, reads schema.org `JobPosting` data, follows likely job links, and follows explicit
   next-page controls.
4. The server records paging and request telemetry, filters known roles before storage, scores the listing from profile and
   listing evidence, and keeps the best 10 accepted roles from that source.
5. When every planned source has a terminal coverage record, the server globally ranks the combined pool and prepares the
   best campaign target plus reserve with one sequential worker.
6. Complete previews are reviewed as one exact batch. Submission remains sequential and each success requires a receipt.

## Source safety budget

Browser discovery runs one source at a time. Defaults per source are five result pages, 35 detail pages, 45 navigations,
and a minimum 1.5-second interval for the same host. Images, fonts, and video are blocked to reduce traffic. HTTP 403 and
429 stop the source immediately. The runner does not bypass login, CAPTCHA, access controls, or manual-only catalog rules.
An optional dedicated Chrome profile or CDP connection can preserve legitimate signed-in sessions.

## Commands

Run against a non-production server first:

```bash
npm run campaign:all-sources -- \
  --catalog /private/path/sources.json \
  --server http://127.0.0.1:4310 \
  --token-file /private/path/token \
  --target 10 --reserve 10 --query engineer
```

For an authenticated dedicated Chrome profile, add `--headed --user-data-dir /private/path/browser-profile`. The runner
prints one JSON progress line per source and a final campaign summary with coverage, pool size, application count, and
timings.

## Acceptance criteria

- Every configured autonomous source has a coverage outcome.
- No source contributes more than 10 accepted candidates.
- Result pagination is followed within the safety budget.
- Previously seen or handled canonical roles do not enter the new pool.
- No application is prepared until browser-source coverage finishes.
- The combined pool is ranked globally; source order cannot determine the selected applications.
- Application work stays sequential and submission receipts remain mandatory.
