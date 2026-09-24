## Why

JobsPipe is a paid aggregation API that normalizes postings from more than 30 ATSs and job boards (Greenhouse, Lever, Ashby, Workday, SmartRecruiters, iCIMS and others) into one schema. Unlike the other aggregators in this batch, it returns full descriptions, ATS apply URLs, an active/closed status, verification timestamps, seniority, visa-sponsorship stance, annualized salary and a "ghost" likelihood score. Those fields match the service's eligibility gates and the preference for official ATS destinations. It could replace much of the per-employer board configuration. The free plan (1,000 distinct jobs a month, 2 requests a second, pages of 25) is enough to evaluate it.

## What Changes

- Add a `jobspipe` discovery adapter that calls `POST https://api.jobspipe.dev/v1/jobs/search` with `Authorization: Bearer <key>` and a JSON filter body. Pagination uses cursors (`next_cursor`).
- Read the key only from the environment variable `JOBSPIPE_API_KEY`. Keys begin with `jp_live_`.
- Expose an allowlisted subset of the documented filters: `job_title_or`, `job_title_not`, `description_or`, `description_not`, `job_country_code_or`, `job_location_or`, `remote`, `work_arrangement_or`, `posted_at_max_age_days`, `employment_type_or`, `job_seniority_or`, `min_salary_usd`, `visa_sponsorship_or`, `language_or`, `company_name_or`, `max_ghost_score`, `employer_type_not`, `source_not`. Always send `status: "active"`.
- **Credit budget:** JobsPipe charges per distinct job returned each calendar month, not per request. Keep a durable monthly credit ledger from `metadata.credits_charged` and stop before the configured monthly allowance (default 1,000, the free plan). Map 402 (quota) and 429 (rate) to their existing diagnostic and cooldown paths.
- By default, exclude postings JobsPipe sourced from LinkedIn (`source_not: ["linkedin"]`). This keeps to the existing rule that LinkedIn stays under the owner's control until the owner explicitly changes that rule.
- Normalize into the opportunity model and keep the richer evidence: `status`, `verified_at`, `last_seen_at`, `expires_at`, `ghost_score`, `visa_sponsorship`, `seniority`, `employment_statuses`, annualized salary in the original currency, and origin `source`. When `apply_url`/`url` resolves to a known official ATS, run the existing official-ATS verification before preparation.
- Exclude contact data (`recruiter_emails`) from the stored record. It is not needed and is personal data.

## Capabilities

### New Capabilities

- `discovery-source-adapters`: this change adds the JobsPipe requirements. The capability is shared with the sibling source proposals.

### Modified Capabilities

- None.

## Impact

- New `src/discovery/sources/jobspipe.js`, registered in `src/discovery/service.js`.
- Uses the shared `source-credentials.js` and `source-quota.js`, adding a monthly credits window.
- `src/discovery/official-ats.js`: reuse `officialAtsIdentityFromUrl` to promote JobsPipe results with ATS URLs.
- `.env.example` and `docs/discovery.md`: the key, plans and credit accounting.
- Tests: `test/jobspipe.test.js`.
- Prerequisite for operators: sign in at https://jobspipe.dev/dashboard, go to Settings → API Keys → Generate API key (shown once, `jp_live_…`), and store it in `.env` as `JOBSPIPE_API_KEY`. The free plan needs no payment. Paid plans raise page size (100) and monthly credits.
