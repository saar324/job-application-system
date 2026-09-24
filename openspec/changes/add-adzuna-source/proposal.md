## Why

The current discovery sources are mostly remote-only boards and configured employer ATS boards. Adzuna's official Search API aggregates on-site, hybrid and remote roles across 19 national markets. It has structured salary, contract and category fields, and its terms explicitly allow personal research. That fills the biggest gap in coverage for country-bound searches.

## What Changes

- Add an `adzuna` discovery adapter that calls the official Search API (`GET https://api.adzuna.com/v1/api/jobs/{country}/search/{page}`) using `app_id` and `app_key`.
- Read the credentials from the deployment environment (`ADZUNA_APP_ID` and `ADZUNA_APP_KEY` in `.env`, Compose `env_file`, or the systemd `EnvironmentFile`). Do not read them from config JSON, profiles or request content.
- Put the country list and optional default filters under `discovery.sourceOptions.adzuna` in private config.
- Expose a bounded, provider-side filter set in the source descriptor: `what`, `what_or`, `what_exclude`, `where`, `distance`, `max_days_old`, `salary_min`, `full_time`, `part_time`, `permanent`, `contract`, `category`, `sort_by`, `country`.
- Enforce Adzuna's default quota (25/minute, 250/day, 1,000/week, 2,500/month) with a durable, deployment-wide request ledger. Stop cleanly when a window is exhausted.
- Normalize results. Keep `salary_is_predicted` as evidence, so a predicted salary is never treated as a stated one. Mark descriptions as snippets, and mark the `redirect_url` destination as unverified until employer resolution.
- If credentials are missing, the source reports `source_not_configured` and makes no network call. Other sources keep running.

## Capabilities

### New Capabilities

- `discovery-source-adapters`: provider-specific discovery source contracts, covering credentials, quota, normalization and destination handling. This change adds the Adzuna requirements. The sibling proposals (`add-jooble-source`, `add-careerjet-source`, `add-jobspipe-source`) add their own requirements to the same capability. Whichever change is archived first creates the spec.

### Modified Capabilities

- None. The existing `opportunity-eligibility` gates apply unchanged.

## Impact

- New `src/discovery/sources/adzuna.js`, registered in `src/discovery/service.js` (`SOURCES` map and `describeSources` capabilities).
- A shared helper for keyed-source credentials and quota (`src/discovery/source-credentials.js`, `src/discovery/source-quota.js`). The first keyed-source change to be implemented creates it.
- `src/discovery/application-destination.js`: Adzuna redirect handling.
- `.env.example`, `docs/discovery.md`, `docs/deployment.md`: document the new variables and the private `sourceOptions` shape.
- Tests: `test/adzuna.test.js`, which covers normalization, missing credentials, quota exhaustion, secret redaction and predicted-salary handling.
- Prerequisite for operators: register at https://developer.adzuna.com/signup to get an `app_id`/`app_key` pair. It is issued immediately.
