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
   next-page controls. It reports small candidate batches after each page or detail. The server returns the count that passed
   eligibility, destination, and handled-role gates; the runner continues until 10 have been accepted or the source budget ends.
4. The server records paging and request telemetry, filters known roles before storage, scores the listing from profile and
   listing evidence, and keeps the best 10 accepted roles from that source. When a browser result links to an official
   Ashby, Greenhouse, or Lever role, the server independently fetches that exact board and role. It uses the ATS title,
   location, description, and destination to rescore; browser-supplied score, source, and authorization flags cannot
   promote a role. Closed, mismatched, or inaccessible ATS roles are excluded. The import shares official responses
   within one batch and stops after 20 distinct official requests by default.
5. When every planned source has a terminal coverage record, the server globally ranks the combined pool and prepares the
   best campaign target plus reserve with one sequential worker. A held or failed preparation pulls the next unused role
   from that recorded pool. Restart recovery resumes the queue and checks whether a replacement is needed.
6. Covered verified official ATS forms pass the owner standing-policy gate. Uncovered forms wait for exact preview review.
   Submission remains sequential and each success requires a receipt.

## Source safety budget

Browser discovery runs one source at a time. Defaults per source are five result pages, 35 detail pages, 45 navigations,
and a minimum 1.5-second interval for the same host. Images, fonts, and video are blocked to reduce traffic. HTTP 403,
429, and challenge pages stop the source immediately. The runner does not bypass login, CAPTCHA, access controls, or manual-only catalog rules.
An optional dedicated Chrome profile or CDP connection can preserve legitimate signed-in sessions.

Campaign status and `workflow-report` include per-source health with pages, requests, found, selected, handled,
excluded, missing employer destinations, parse drift, rate limits, and challenges. `zero_extractable` means the bounded
scan produced no candidate records; it does not prove the source has no jobs. Browser-imported roles without independent
official ATS verification still require exact manual submission review. A visible HTTPS Apply link on a different host is
a basic destination check, not independent server verification for standing automatic submission.
Official adapter diagnostics split hard exclusions, below-score roles, and opportunistic-role failures; handled roles and
unverified destinations have separate counts. Campaign reserve selection remains bounded by the requested target plus
reserve, and verified official ATS roles are rechecked when their discovery evidence is stale before preparation.

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
