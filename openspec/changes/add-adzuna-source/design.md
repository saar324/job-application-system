## Context

Discovery adapters live in `src/discovery/sources/*.js`. Each exports `{ id, search({ limit, fetchImpl, profile, query, sourceConfig, onError }) }` and is registered in the `SOURCES` map and the `describeSources` capability table in `src/discovery/service.js`. None of the current sources needs a secret. The only precedent for secrets is optional environment-only settings such as `JOB_SEMANTIC_TOKEN`, which is read in `semanticEnricherFromEnv`. `.env` is gitignored and loaded with `--env-file-if-exists`; Compose uses `env_file: .env`. Committed config (`config/default.json`) and the privacy gate must never contain keys.

Facts about the Adzuna API as of 2026-09, from developer.adzuna.com:
- Endpoint: `GET https://api.adzuna.com/v1/api/jobs/{country}/search/{page}?app_id=…&app_key=…`. Authentication uses query parameters, not a header.
- Parameters: `what`, `what_and`, `what_or`, `what_phrase`, `what_exclude`, `title_only`, `where`, `distance`, `max_days_old`, `category`, `sort_by` (`date`, `salary` or `relevance`), `salary_min`, `salary_max`, `salary_include_unknown`, `full_time`, `part_time`, `permanent`, `contract`, and `results_per_page` (maximum 50; 100 returns HTTP 400).
- Response: `{ count, mean, results[] }`. Each result has `id`, `title`, `description` (a snippet), `created`, `redirect_url`, `company.display_name`, `location.display_name`, `location.area[]`, `category.label/tag`, `salary_min`, `salary_max`, `salary_is_predicted`, `contract_type` and `contract_time`.
- Default limits: 25 hits/minute, 250/day, 1,000/week, 2,500/month. Personal research is a permitted use. Publishing requires attribution to Adzuna.

## Goals / Non-Goals

**Goals:**
- A first-class `adzuna` source that follows the same filter-descriptor, budgeting and normalization rules as Himalayas.
- A reusable way to handle environment credentials and quota ledgers, which the Jooble, Careerjet and JobsPipe proposals can share.
- Never exceed the provider quota, even across restarts or concurrent scans.

**Non-Goals:**
- The histogram, top-companies and categories endpoints (the category list can be static config).
- Scraping Adzuna detail pages for full descriptions.
- Per-profile Adzuna keys. Keys are per deployment.

## Decisions

1. **Credentials are injected by the service, not pulled by the adapter.** A new `sourceCredentials(sourceId, env)` in `src/discovery/source-credentials.js` maps source IDs to required environment names and returns either a frozen credentials object or `null`. `DiscoveryService.scan` passes `credentials` into `search()` next to `sourceConfig`. Adapters never read `process.env`, which keeps tests hermetic and the attack surface in one place. *Alternative:* a secrets section in config JSON. Rejected because config files are sometimes committed and are shown to agents through descriptors.
2. **Redaction happens at the adapter boundary.** Because Adzuna authenticates with query parameters, the adapter builds URLs itself and wraps every thrown error with a message that never includes the URL. The service also runs a generic `redactSecrets(message, credentials)` before storing `errors[]`. The in-memory `fetchCache` key contains the URL but is never persisted or logged.
3. **A durable quota ledger is kept per provider window.** `src/discovery/source-quota.js` stores counters keyed by `{sourceId, window, windowStart}` in the SQLite store, using the same persistence layer as audit events. `reserve(sourceId, n)` atomically checks every window (minute, day, week, month) before a request is made and increments after it is sent. The limits come from provider defaults, which private `sourceOptions.adzuna.quota` can lower but not raise. *Alternative:* reuse the in-memory `maxRequestsPerSource` budget. Rejected because it resets on each scan and restart.
4. **Country fan-out is explicit.** A query runs against one country. With no `country` filter, the adapter iterates the configured countries in order until `limit` is met, and quota is spent on the first countries first. The profile's preferred titles supply `what`, following the `himalayas.searchQueries` pattern.
5. **Predicted salary is stored as an estimate only.** When `salary_is_predicted === "1"`, the normalizer puts the numbers in `compensationEstimate` rather than `compensation`. Compensation gates see only stated pay, and this change does not alter how those gates behave.
6. **Destination resolution comes later.** `redirect_url` points at an Adzuna landing page that then redirects to the employer. The first version marks results `applicationDestinationPending` and relies on the existing browser fallback and official-ATS verification. HEAD-redirect chasing for `adzuna.*` hosts is added to `BOARD_REDIRECTS` only if fixtures show a clean 3xx chain.

## Risks / Trade-offs

- [2,500 requests/month is small] → Default to `max_days_old: 7`, `sort_by: date` and one page per title and country. Surface the remaining quota in the source descriptor so agents can plan around it.
- [Snippets hide requirements] → The `description_snippet_only` uncertainty blocks auto-apply decisions that depend on full-text checks, and the official-ATS fetch provides the full text before preparation.
- [Keys leaked through URL logging] → Redact at the boundary, add a regression test that asserts the key never appears in `scan()` output or audit, and use no request-URL telemetry.
- [Adzuna changes parameters] → Record fixture-based contract tests. A 400 response is recorded as `parseDrift`, and the source is downgraded as `source-query-discovery` already describes.

## Migration Plan

This change is additive. Operators add `ADZUNA_APP_ID` and `ADZUNA_APP_KEY` to `.env`, set `discovery.sourceOptions.adzuna.countries` in private config, and add `adzuna` to a mode's `sources`. Rollback means removing `adzuna` from `sources`. The ledger table is left in place and is harmless.

## Open Questions

- Should the quota defaults be tightened by default below the provider limits (for example 200/day) to leave headroom for manual testing?
- Which countries should the private config start with? This is left to the operator. The repo default stays empty.

## Implementation notes

- **Ledger storage.** The ledger lives in two dedicated SQLite tables, `source_quota_usage` and `source_quota_holds` (schema version 3), rather than in audit events. Audit rows need a profile ID, and the ledger is deployment-wide. `JsonStore` keeps the same data under `state.sourceQuota` for tests and legacy use. Both stores expose `reserveSourceQuota`, `holdSourceQuota` and `sourceQuotaUsage`, and `SourceQuota` wraps them.
- **Reserve before sending.** `reserve()` checks and increments every window in one transaction before the request is sent, not after it. Failed requests therefore count against the allowance. This is the conservative reading of "never exceed the provider quota".
- **Window boundaries.** Windows are UTC calendar windows: minute, day, week (Monday to Sunday) and month. Adzuna does not document whether its windows are calendar or rolling. A new window kind, such as `lifetime` or a billing-anchored month, only needs a new entry in `QUOTA_WINDOWS`. `reserve()` already takes a `cost` for credit-based providers.
- **429 cooldown.** The existing `rate_limited` cooldown is profile-scoped and based on campaign audit events. For keyed sources, a 429 stores a deployment-wide hold in the ledger for the same `SOURCE_COOLDOWN_MS.rate_limited` (six hours). `reserve()` refuses with code `rate_limited` and a `resetAt` until the hold ends.
- **Partial results.** The first failed request (quota, cooldown, HTTP or network) stops the country fan-out. The adapter reports it through `onError` and returns the results it already has. A 400 response is reported with `code: "parse_drift"` and `parseDrift: true`.
- **Descriptor.** Adzuna uses the new kind `keyed_api`. Keyed sources also carry `configured`, `quota` (remaining allowance per window and any cooldown), `filterFormats` for numeric and category values (now checked by `query()`), and an `attribution` label. Credentials never appear in them.
- **Search terms.** `what_or` alone counts as a search term. Otherwise the profile's preferred titles are used through `profileSearchTerms`, which was moved unchanged from the Himalayas adapter to `title-preferences.js`.
- **Stated salary.** A salary without `salary_is_predicted` is stored as `compensation`, with the currency inferred from the searched country and an annual period. The compensation gates are unchanged.
- **Snippet mismatch.** Scoring has no rule that excludes a role because a skill is missing from its description. The `description_snippet_only` uncertainty is surfaced in `scoreDetails.uncertainties` and needs no scoring change.
- **Redirect handling.** No `BOARD_REDIRECTS` entry was added for Adzuna, so `application-destination.js` is unchanged. No fixture shows a clean 3xx chain, so results stay `applicationDestinationPending`.
- **Deployment.** `scripts/split-production-env.js` now adds every name in `SOURCE_CREDENTIAL_ENV_NAMES` to the API environment. Without this, systemd deployments would drop the keys. The worker never receives them.
- **Open question on defaults.** The quota defaults stay at the provider limits. Operators can lower them with `sourceOptions.adzuna.quota`.
