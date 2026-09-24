# Discovery adapters

Discovery adapters normalize provider-specific listings into one opportunity model and fail independently, so one unavailable provider does not stop a scan.

The codebase includes adapter implementations for public feeds and configurable ATS boards. No adapter is enabled in the base defaults, and no employer board is preconfigured. An optional `config/discovery.example.json` enables four public feeds in simulation. `skills/job-application/references/public-sources.json` lists broad public browser sources and the seven server adapter types without applicant filters. Select employer boards and personal source priorities only in a private config file.

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

The installed skill's `references/sources.json` remains an empty private template. A fresh installation can use `references/public-sources.json` as a general starter. A deployment can maintain a private `sources.json` with its own browser sources, regions, screening rules, and priorities; the public starter never replaces that private copy.

## Keyed API sources

Some providers need deployment-wide API credentials. The server reads them only from its process environment (`.env`, the Compose `env_file`, or the systemd `EnvironmentFile`) and passes them to the adapter. They are never accepted from config JSON, profiles, or MCP or HTTP requests, and they are redacted from scan errors, audit events, and source descriptors. If a selected keyed source has no credentials, the scan reports `source_not_configured` for it without a network request, and the other sources run normally.

Each keyed source has a durable, deployment-wide request ledger stored in the SQLite database (`source_quota_usage` and `source_quota_holds`). Every request is reserved against all of the provider's UTC calendar windows before it is sent, so concurrent scans and restarts cannot exceed the allowance. When a window is full, the source returns a `quota_exhausted` error with the `window` and `resetAt`. A full `second` window is waited out instead of refused. An HTTP 429 response puts the source into the standard six-hour `rate_limited` cooldown. The source descriptor shows `configured`, the remaining allowance per window, and any active cooldown.

### Country options filter where the job is, not where you may work

A keyed source's country option — Adzuna's `countries`, JobsPipe's `defaultCountries`, and the country
filters on Jooble and Careerjet — constrains the **employer's** advertised location. It does not mean
"a role I am eligible to hold from here". Setting it to the applicant's country of residence is the
natural first guess and is usually wrong for a remote search: an employer posting a worldwide-remote
role tags it with the employer's own country, so a residence pin excludes almost everything.

Residence eligibility is enforced after the fetch instead, and does not need a country option at all:
`locationExclusion` in `src/discovery/scoring.js` drops a remote posting whose stated restriction does
not include a country in the profile's `preferences.locations`.

What to do depends on whether the provider can express work arrangement, and the two behave very
differently:

- **JobsPipe** filters on `remote` and `work_arrangement_or`, and its country option is optional.
  Leave `defaultCountries` unset and put the real constraint in
  `"defaults": { "remote": "true", "work_arrangement_or": ["remote"] }`. Observed on this deployment:
  pinned to a single country of residence a remote program-manager search returned three postings and
  nothing above the score threshold; unpinned with `remote` kept it returned about fifty, including
  matches scoring 79 and 76.
- **Adzuna** has no remote or work-arrangement filter at all — its filters are `what`, `what_or`,
  `what_exclude`, `where`, `distance`, `max_days_old`, `salary_min`, `full_time`, `part_time`,
  `permanent`, `contract`, `category`, `sort_by` and `country` — and `countries` is required, because
  the adapter searches one country at a time and returns nothing without one. It is a
  commute-oriented, location-first provider. Expect on-site roles: a program-manager scan over four
  European countries returned fifty postings, every one of them `remote: false`, none scoring within
  fifteen points of the threshold. Adzuna suits an on-site or hybrid search in named countries; it is
  a poor fit for a remote-only search. `"defaults": { "what": "remote" }` narrows each preferred title
  to `"<title> remote"` and does surface genuinely remote adverts, but it does not rescue the source:
  measured over the same four countries it returned twenty-four rows against fifty, and the top score
  fell from 45 to 37 because narrowing shrinks the pool.

  The deeper reason is normalization, not configuration. The Adzuna adapter never sets a `remote`
  flag, and `normalizeOpportunity` derives `remote` from the location string alone
  (`src/discovery/normalization.js`). Adzuna reports a place — `Deutschland`, `Berlin, Deutschland` —
  so every Adzuna result is `remote: false` even when its title reads `Project Manager (m/w/d) Remote`.
  Any profile that prefers or requires remote work will therefore score Adzuna results low whatever
  filters are set. Treat Adzuna as a located-role source until the adapter reports work arrangement
  from the advert itself.

Coverage also varies by provider: Adzuna answers HTTP 404 for a country it does not carry, so confirm
a country is supported before adding it.

A provider that bills per result rather than per request uses a `credits_*` window. The adapter reserves the most it could be charged, capped at what remains, sizes its request to the amount granted, and then settles the reservation with the provider's reported charge.

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

### JobsPipe

JobsPipe's Jobs API aggregates postings from ATSs and job boards into one schema, with full descriptions, an active or closed status, verification timestamps, seniority, visa-sponsorship stance and a ghost-likelihood score. To enable it:

1. Sign in at <https://jobspipe.dev/dashboard>, open Settings, then API Keys, and generate a key. It is shown once. The Free plan needs no payment.
2. Set `JOBSPIPE_API_KEY` in the server environment.
3. Optionally add private options, and add `jobspipe` to a mode's `sources`:

```json
{
  "discovery": {
    "sourceOptions": {
      "jobspipe": {
        "plan": "free",
        "monthlyCredits": 800,
        "perSecond": 2,
        "maxPages": 2,
        "excludeSources": ["linkedin"],
        "defaultCountries": ["REPLACE_WITH_COUNTRY_CODES"],
        "defaults": { "remote": "true", "work_arrangement_or": ["remote"] }
      }
    }
  }
}
```

- `plan` declares the account's plan: `free` (the default: 2 requests a second, 1,000 credits a month, pages of 25), `builder` or `growth` (10 a second, 25,000 or 100,000 credits, pages of 100), or `scale` or `business` (50 a second, 300,000 or 500,000 credits). `monthlyCredits` and `perSecond` can lower the plan's allowance but never raise it.
- `maxPages` is the number of cursor pages per query, from 1 to 10. It defaults to 2.
- `excludeSources` defaults to `["linkedin"]`, so postings JobsPipe found on LinkedIn are excluded. Removing `linkedin` is an explicit owner decision. Agents can add exclusions with `source_not` but cannot remove these.
- `defaultCountries` is sent as `job_country_code_or` when a query has none.
- `defaults` holds standing filters for every request, taken from the same list an agent may use. A `scan` carries no filters of its own, so without these a scheduled scan searches worldwide and on-site; `{ "remote": "true", "work_arrangement_or": ["remote"] }` keeps it to remote roles. An agent's query filter overrides the matching default, `source_not` adds to `excludeSources` rather than replacing it, and `job_country_code_or` and `job_title_or` are rejected here because `defaultCountries` and the profile's preferred titles already set them.
- Any other key, including a credential, is rejected at startup.

**Credits.** JobsPipe bills one credit per distinct job returned in a UTC calendar month. Repeats and empty results are free, a 400 response costs one credit, and 502 and 504 responses are refunded. Before each request, the ledger reserves at most the remaining monthly credits, and `limit` is lowered to the amount granted. When no credits remain, the source reports `quota_exhausted` without a request. After the response, the ledger records `metadata.credits_charged`. If the outcome of a request is unknown, for example after a network error, the whole reservation is kept. The descriptor's `quota.windows.credits_month` shows the credits used and remaining.

**Errors.** A 401 reports `key_rejected` and pauses the source until a different key is configured. A 402 reports `quota_exhausted` and pauses it until the next UTC month. A 429 applies the `rate_limited` cooldown. A 502 or 504 reports a retryable `provider_timeout` without a pause.

Agents can use the filters `job_title_or`, `job_title_not`, `description_or`, `description_not`, `job_country_code_or`, `job_location_or`, `remote`, `work_arrangement_or`, `posted_at_max_age_days`, `employment_type_or`, `job_seniority_or`, `min_salary_usd`, `visa_sponsorship_or`, `language_or`, `company_name_or`, `max_ghost_score`, `employer_type_not`, and `source_not`. The `_or` and `_not` filters take arrays. Any other filter, such as `has_recruiter_email`, is rejected before a request. Every search sends `status: "active"` and, unless the query sets it, `posted_at_max_age_days: 7`. Without `job_title_or`, the adapter searches for the profile's preferred titles, and with no titles it makes no request.

Results use the JobsPipe `id` as the external ID and keep the posting status, verification and last-seen times, expiry, ghost score, visa-sponsorship stance, seniority, employment types, country codes and origin sources in `postingEvidence`. Only a stated salary with its currency counts as compensation; corpus estimates are stored as `compensationEstimate` evidence. Recruiter emails, applicant counts and company financials are dropped in the adapter and never stored. Closed or expired results are dropped, and an opportunity whose expiry passes before preparation is not given an application; the reason is recorded in the `application.blocked` audit event.

When a result's URL is a Greenhouse, Lever or Ashby job URL, the scan verifies it against the official ATS feed and stores the official role, with `provenance.discoveredVia: "jobspipe"`. If verification fails, the result stays `applicationDestinationPending` with an `official_ats_*` uncertainty. Other results are pending until an employer destination is verified.

JobsPipe's terms prohibit redistributing the data in bulk or as a competing dataset, feed or API. Anyone who displays postings must keep the link to the original posting. The account holder is the controller of any personal data received.


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

A keyed adapter receives `credentials` in `search()` and must not read `process.env`. Add its environment names to `SOURCE_CREDENTIAL_ENV` in `src/discovery/source-credentials.js` (the systemd environment split picks them up automatically) and its provider allowance to `SOURCE_QUOTA_DEFAULTS` in `src/discovery/source-quota.js`. An adapter whose allowance depends on private options exports `quotaLimits(sourceConfig)`. The service then handles `source_not_configured`, quota reservation, per-second pacing, 429 cooldowns, and error redaction. It also passes a `quota` handle to keyed adapters: `reserve(credits)` for credit windows, `settle(reservation, charged)`, and `hold(reason, { window })`, where `key_rejected` lasts until the key changes. Requests with a body are cached per method, URL and body.
