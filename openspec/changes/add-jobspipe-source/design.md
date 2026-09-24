## Context

The JobsPipe API (docs.jobspipe.dev, checked 2026-09) works as follows:
- `POST https://api.jobspipe.dev/v1/jobs/search` with `Authorization: Bearer jp_live_…` and `Content-Type: application/json`. Every filter is optional and filters are combined with AND; each `*_or` array matches any of its values.
- Pagination: pass the `next_cursor` from the previous response's `metadata`. The `limit` cap depends on the plan (Free 25, credit plans 100).
- Response: `{ metadata{ total_results, truncated_results, next_cursor, credits_charged, jobs_already_paid, … }, data[] }`.
- Job fields: `id`, `job_title`, `normalized_title`, `url`, `source_url`, `company`, `company_domain`, `location`, `country_code(s)`, `cities`, `remote`, `hybrid`, `work_arrangement`, `salary_string`, `salary_currency`, `min/max_annual_salary`, `*_usd`, `estimated_*` (corpus estimates), `employment_statuses`, `seniority`, `date_posted`, `discovered_at`, `last_seen_at`, `verified_at`, `status`, `closed_at`, `expires_at`, `keyword_slugs`, `technology_slugs`, `visa_sponsorship`, `ghost_score`, `recruiter_emails`, `applicant_count`, `sources[]`.
- Plans: Free (2 req/s, 1,000 jobs/month), Builder (10/s, 25k), Growth (10/s, 100k), Scale and Business (50/s, 300k and 500k). One credit buys one distinct job for the rest of the calendar month (UTC). Empty results and repeats are free. A 400 costs 1 credit, and 502/504 are refunded. Status codes: 401 invalid key, 402 monthly quota, 429 rate limit, 504 upstream timeout.
- There is also a keyless `/v1/sandbox/jobs/search` endpoint, which is useful for fixture capture.

## Goals / Non-Goals

**Goals:** a high-yield source whose output feeds the official-ATS verification path, with strict credit accounting and no contact-data retention.

**Non-Goals:** the companies, insights and stack-scan endpoints (1 credit per call); the JobsPipe MCP server (the application server stays the system of record); automatic plan upgrades.

## Decisions

1. **Credits are counted, not requests.** The ledger records `credits_charged` per UTC month. Before each request, `limit` is clamped to `allowance − used`. When the remainder is 0, report `quota_exhausted`. A 400 is counted as 1 credit, matching the provider's rule.
2. **Filter allowlist.** Only filters that fit the eligibility model are exposed. Filters that target individuals (`has_recruiter_email`, `max_applicant_count`) or are unrelated to fit are excluded. The adapter derives `job_title_or` from the profile's preferred titles when the query gives none.
3. **Default LinkedIn exclusion.** `sourceOptions.jobspipe.excludeSources` defaults to `["linkedin"]`. Removing LinkedIn from that list is an explicit owner decision. This keeps to the `source-query-discovery` rule that LinkedIn stays under the owner's control.
4. **Promotion to official ATS.** Reuse `officialAtsIdentityFromUrl` on `url`, then `source_url`. A match sets `applicationFlow: verify_official_ats_before_prepare`. Anything else is marked destination pending.
5. **Evidence and privacy.** Map the stated salary only (`min/max_annual_salary` plus `salary_currency`, period `year`). Keep `estimated_*` out of `compensation` and optionally store it as `compensationEstimate`. Remove `recruiter_emails`, `applicant_count` and `company_object` financials at the adapter boundary, before normalization.
6. **Fixtures from the sandbox.** Capture contract fixtures from the keyless sandbox endpoint, then replace company names with fictional `example.test` data before committing.

## Risks / Trade-offs

- [Paid dependency and vendor lock-in] → The source is optional and works like any other adapter. Removing it degrades coverage gracefully.
- [Free plan's 1,000 credits run out quickly with broad queries] → Default to `posted_at_max_age_days: 7`, narrow title filters, `limit` 25 and a page cap of 2. The descriptor reports remaining credits.
- [Aggregated duplicates of ATS roles already found via Greenhouse, Lever or Ashby] → The existing `roleKeys` and handled-role deduplication applies. After official-ATS promotion, the source-plus-external-ID pair converges on the ATS identity.
- [Terms on storing data] → Not documented in what we reviewed. Store only the fields listed above, and flag this for review (see Open Questions).

## Migration Plan

This change is additive. Generate a key, add `JOBSPIPE_API_KEY` to `.env`, optionally set `sourceOptions.jobspipe.{monthlyCredits,perSecond,maxPages,excludeSources,defaultCountries}`, and add `jobspipe` to `sources`. Rollback means removing it from `sources`.

## Open Questions

- Do JobsPipe's terms allow retaining returned postings beyond the billing month? **Checked 2026-09-24** against the Terms of Service (<https://jobspipe.dev/terms>) and Acceptable Use Policy (<https://jobspipe.dev/acceptable-use>), both last updated 2026-09-24. Neither sets a retention period, requires deletion at month end or after cancellation, or restricts caching or storage. The limits that apply: no reselling, sublicensing or redistributing the data in bulk or as a dataset, feed or API that competes with JobsPipe (Terms §3, AUP); anyone displaying postings must keep the link to the original posting (Terms §4); the customer is the independent controller of any personal data received and must delete data it no longer needs, and JobsPipe may ask for removal when a person asks it to (Terms §4, AUP). JobsPipe claims no ownership of posting content but keeps rights to its normalized schema and enrichment (Terms §7). Outcome: retaining the stored subset of each opportunity for the applicant's own records is allowed. The adapter already drops recruiter emails and applicant counts, which keeps the personal-data duty small, and the listing URL is kept. The service must not re-publish JobsPipe data as a feed. The credit month only affects billing, not retention.
- Which plan should be assumed by default? Resolved: Free (limit 25, 2 req/s, 1,000 credits). `sourceOptions.jobspipe.plan` declares a paid plan, and `monthlyCredits` and `perSecond` can only lower the declared plan's ceilings.

## Implementation notes

- **Ledger API.** `SourceQuota.reserve(sourceId, limits, cost = 1, { credits })` charges `cost` to request windows and, only when `credits` is given, charges credit windows (`credits_*`) with as much of `credits` as remains (at least 1). A success returns `{ reserved, credits, creditWindows, sourceId }`. `SourceQuota.settle(reservation, charged)` applies the difference to the reserved windows through the new store method `settleSourceQuota`. `SourceQuota.forSource(sourceId, limits, { fingerprint })` is the handle passed to keyed adapters as `quota` (`reserve(credits)`, `settle`, `hold(reason, { window })`). Adzuna's request-only path is unchanged.
- **Two reservations per request.** The credit reservation (adapter, before the body is built) and the request reservation (service `keyedFetch`, which also paces and applies the 429 hold) are separate atomic transactions. Neither can overspend. If the request reservation is refused, the service marks the error `notSent` and the adapter returns the credits.
- **Pacing.** The new `second` window uses calendar seconds. The service waits for a full `second` window to reset (at most 2 seconds, 10 attempts) instead of refusing. Two requests close to a second boundary can therefore land about a millisecond apart. Increase `perSecond` headroom only if JobsPipe returns 429s.
- **Unknown outcomes.** A network error, timeout or unreadable response keeps the whole credit reservation, because JobsPipe may have charged it. A 400 settles at 1 credit. Other HTTP errors settle at 0. A 200 response without `credits_charged` settles at the number of jobs returned.
- **401 pause.** "Until configuration changes" is stored as a `key_rejected:<fingerprint>` hold. The fingerprint is the first 12 hex characters of a SHA-256 of the key. At the start of each scan, a hold for a different fingerprint is released. Descriptors and errors show only `key_rejected`.
- **402 pause.** This is a `quota_exhausted` hold until the credit month's `resetAt`. A 429 uses the existing `rate_limited` hold (6 hours), as with Adzuna.
- **POST caching.** The scan's fetch cache is keyed by method, URL and body when a string body is present, and is skipped for other bodies. Adzuna's GET cache is unchanged.
- **Filter types.** The agent API accepts only strings and string arrays, so `remote` is `"true"`/`"false"` and the numeric filters are digit strings. The adapter converts them to booleans and integers. Descriptors gained `arrayFilters`, and `filterFormats` now applies to each array item.
- **Official ATS promotion.** Promotion happens during the scan, after the first screening, for qualifying results only. The official role replaces the JobsPipe record and is screened again on the official data. Only the JobsPipe expiry (`validThrough`) and `postingEvidence` carry over. JobsPipe's stated salary does not, so every eligibility field comes from the official feed. Official lookups count against the scan's overall request budget, not the JobsPipe ledger, and respect the existing ATS back-off.
- **Expiry at preparation.** `requestApplication` now refuses, with HTTP 409 and code `posting_expired` or `posting_closed`, any discovered opportunity whose `validThrough` has passed or whose `postingStatus` is not `active`. It records an `application.blocked` audit event and creates no application record. This applies to every source that sets these fields. Roles the applicant requested directly are exempt.
- **Fixtures.** The sandbox endpoint was not called from this environment. Test rows follow the documented job schema, using fictional `example.test` data.
