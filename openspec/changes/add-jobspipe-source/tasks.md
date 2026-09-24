## 0. Pre-check

- [x] 0.1 Read the JobsPipe terms of service about retaining data and record the outcome in `design.md` Open Questions

## 1. Shared keyed-source foundation (skip any item already delivered by a sibling source change)

- [x] 1.1 Ensure `source-credentials.js` exists with `JOBSPIPE_API_KEY` mapped and redaction in place
- [x] 1.2 Ensure `source-quota.js` supports a per-month credits window with `reserve` and `settle` (clamp before the request, record `credits_charged` after)
- [x] 1.3 Ensure scan passes `credentials` and reports `source_not_configured` without fetching

## 2. JobsPipe adapter

- [x] 2.1 Create `src/discovery/sources/jobspipe.js`: the Bearer header, the filter allowlist, `status: "active"`, profile-derived `job_title_or`, cursor paging with a page cap, per-second pacing
- [x] 2.2 Map 401, 402, 429 and 504 to a key-rejected pause, quota exhausted, cooldown and a retryable error respectively
- [x] 2.3 Remove `recruiter_emails`, `applicant_count` and company financials; normalize stated salary only; keep verification evidence
- [x] 2.4 Promote ATS URLs through `officialAtsIdentityFromUrl`; mark other results destination pending; block expired or closed roles
- [x] 2.5 Register `jobspipe` in `SOURCES` and add its descriptor (filters, remaining credits, `applicationFlow`)
- [x] 2.6 Validate `sourceOptions.jobspipe` (`monthlyCredits`, `perSecond`, `maxPages`, `excludeSources`, `defaultCountries`) in `src/config.js`

## 3. Tests

- [x] 3.1 Add fixture normalization tests (sandbox-captured data made anonymous with `example.test`)
- [x] 3.2 Test that a missing key sends no request, and that the key is redacted on 401 and network errors
- [x] 3.3 Test credit ledger clamping, 402 handling, and persistence across a restart
- [x] 3.4 Test that the default LinkedIn exclusion is present in the request body
- [x] 3.5 Test that recruiter emails never reach the store or audit
- [x] 3.6 Test that a Greenhouse-URL result requires official verification, and that an expired result is not queued

## 4. Docs and config

- [x] 4.1 Add a commented `JOBSPIPE_API_KEY=` placeholder to `.env.example`
- [x] 4.2 Document the key generation, plans and credit accounting in `docs/discovery.md`
- [x] 4.3 Run `npm run check`
