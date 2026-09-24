# Discovery adapters

Discovery adapters normalize provider-specific listings into one opportunity model and fail independently, so one unavailable provider does not stop a scan.

The codebase includes adapter implementations for public feeds and configurable ATS boards. No adapter is enabled in the repository defaults, and no employer board is preconfigured. Select source IDs and employer boards only in a private config file.

## Private configuration

Mode-level `sources` chooses enabled adapter IDs. ATS board selections live under `discovery.sourceOptions`:

```json
{
  "discovery": {
    "sourceOptions": {
      "ashby": { "boards": [{ "slug": "REPLACE_ME", "company": "REPLACE_ME" }] },
      "greenhouse": { "boards": [{ "token": "REPLACE_ME", "company": "REPLACE_ME" }] },
      "lever": { "sites": [{ "slug": "REPLACE_ME", "company": "REPLACE_ME" }] }
    }
  },
  "modes": {
    "full_time": { "sources": ["REPLACE_WITH_SOURCE_IDS"] }
  }
}
```

## Keyed API sources

Some providers need deployment-wide API credentials. The server reads them only from its process environment (`.env`, the Compose `env_file`, or the systemd `EnvironmentFile`) and passes them to the adapter. They are never accepted from config JSON, profiles, or MCP or HTTP requests, and they are redacted from scan errors, audit events, and source descriptors. If a selected keyed source has no credentials, the scan reports `source_not_configured` for it without a network request, and the other sources run normally.

Each keyed source has a durable, deployment-wide request ledger stored in the SQLite database (`source_quota_usage` and `source_quota_holds`). Every request is reserved against all of the provider's UTC calendar windows before it is sent, so concurrent scans and restarts cannot exceed the allowance. When a window is full, the source returns a `quota_exhausted` error with the `window` and `resetAt`. An HTTP 429 response puts the source into the standard six-hour `rate_limited` cooldown. The source descriptor shows `configured`, the remaining allowance per window, and any active cooldown.

### Adzuna

Adzuna's Search API covers on-site, hybrid, and remote roles in 19 countries. To enable it:

1. Register at <https://developer.adzuna.com/signup> to get an `app_id` and `app_key`.
2. Set `ADZUNA_APP_ID` and `ADZUNA_APP_KEY` in the server environment.
3. Add private options and add `adzuna` to a mode's `sources`:

```json
{
  "discovery": {
    "sourceOptions": {
      "adzuna": {
        "countries": ["REPLACE_WITH_COUNTRY_CODES"],
        "defaults": { "max_days_old": "7", "sort_by": "date" },
        "quota": { "day": 200 }
      }
    }
  }
}
```

- `countries` accepts `at`, `au`, `be`, `br`, `ca`, `ch`, `de`, `es`, `fr`, `gb`, `in`, `it`, `mx`, `nl`, `nz`, `pl`, `sg`, `us`, and `za`. It is empty by default. A query without a `country` filter tries the configured countries in order until its limit is met, so the first countries use the quota first. A query for any country not in this list is rejected.
- `defaults` holds optional provider filters used on every request. Without them, the adapter sends `max_days_old: "7"` and `sort_by: "date"`.
- `quota` can lower the default allowance of 25 requests per minute, 250 per day, 1,000 per week (Monday to Sunday, UTC), and 2,500 per month. It cannot raise it. Other keys, including credentials, are rejected at startup.

Agents can use the provider filters `what`, `what_or`, `what_exclude`, `where`, `distance`, `max_days_old`, `salary_min`, `full_time`, `part_time`, `permanent`, `contract`, `category`, `sort_by`, and `country`. Any other filter is rejected. Without `what` or `what_or`, the adapter searches for the profile's preferred titles, and with no titles it makes no request. Each request asks for at most 50 results.

Adzuna results use the external ID `{country}:{id}`. Their descriptions are snippets, marked with the `description_snippet_only` uncertainty. Each result's `redirect_url` is both the listing URL and a pending application URL, marked `employer_application_url_unverified`, so no application is prepared until an employer or official ATS destination is verified. A salary with `salary_is_predicted` is stored only as `compensationEstimate` evidence and does not count as stated pay for compensation checks.

Adzuna's terms allow personal research use. Anything published from its data must be attributed to Adzuna, as those terms require. The source descriptor includes an `attribution` label for that purpose.

The installed skill's `references/sources.json` is intentionally empty. A deployment can maintain a private copy with its own browser sources, regions, screening rules, and priorities.

Additional official ATS boards may be admitted from a profile's recent verified official role or real employer receipt. The owner may also put a reviewed official role URL in the private server configuration for that profile:

```json
{
  "discovery": {
    "sourceOptions": {
      "ashby": {
        "boards": [],
        "ownerCuratedBoards": [{
          "profileId": "PROFILE_ID",
          "officialRoleUrl": "https://jobs.ashbyhq.com/BOARD/ROLE_UUID/application",
          "company": "EMPLOYER",
          "reviewedAt": "2026-09-24T08:00:00Z"
        }],
        "disabledBoardKeys": ["ashby:BOARD_TO_ROLL_BACK"]
      }
    }
  }
}
```

This configuration is server owned and cannot be supplied by an agent's search request. The URL must identify one role on a recognized official Ashby, Greenhouse, or Lever host. Owner-curated reviews expire after seven days; other verified-role and receipt seeds expire after 30 days. Each profile gets at most five added boards per ATS source per completed search cycle. An added board receives at most two list requests in a rolling 24 hours, recorded in the durable audit log before fetch. Configured boards retain the ordinary source request budget. Every returned role still goes through current posting, geography, fit, destination, and handled-role checks. To roll back an added board immediately, set `enabled: false` on its curated seed or add its lowercase `source:board` key to `disabledBoardKeys`; remove the key after review. A 403 or 429 still triggers the existing six-hour board cooldown and stops queued requests to that origin for the scan.

The scan response includes `learnedBoardYield` with each added board's seed provenance, list requests, and count of distinct eligible, unhandled, verified-destination roles. Inspect this count and the actual roles in a read-only shadow before promoting a board. A board with zero eligible roles has zero measured application supply even if its feed returned many postings.

## Normalized records

Every adapter returns a provider ID, external ID, role title, company, listing URL, application URL, description, location, work type, and posting time when available. These stable fields support deduplication and attribution.

## Scoring

Scoring is explainable and uses applicant-owned configuration:

- skill overlap
- preferred-title overlap
- location eligibility
- recency
- compensation fit

Unknown compensation is never invented. Hard exclusions and thresholds come from the private profile and config.

## Adding an adapter

Create a module in `src/discovery/sources/` that exports an object with an `id` and async `search` function. Return normalized opportunities containing at least `title`, `company`, and `applyUrl`, register the adapter in `src/discovery/service.js`, and add isolated regression tests. Follow the provider's current terms and preserve source links.

A keyed adapter receives `credentials` in `search()` and must not read `process.env`. Add its environment names to `SOURCE_CREDENTIAL_ENV` in `src/discovery/source-credentials.js` (the systemd environment split picks them up automatically) and its provider allowance to `SOURCE_QUOTA_DEFAULTS` in `src/discovery/source-quota.js`. The service then handles `source_not_configured`, quota reservation, 429 cooldowns, and error redaction.
