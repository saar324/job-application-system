## Context

Greenhouse, Ashby and Lever are read today through configured-board adapters in `src/discovery/sources/`. Each one:
- takes boards from `discovery.sourceOptions.<id>`;
- fetches every board with `Promise.allSettled`;
- pre-screens with local title and location filters;
- emits `${board}:${id}` external IDs.

`src/discovery/official-ats.js` hard-codes those three providers. Its `officialAtsDestination()` is the single predicate behind every automatic path:
- the pending decision (`src/discovery/service.js:1188`);
- campaign ready selection and reserve refresh (`:238`, `:322`, `:374`);
- the freshness check for standing authorization (`src/service.js:537`, `:984`).

Workable is mentioned in only two places: the worker domain allowlist (`worker/url-policy.js:6`) and the browser link-scoring regex (`src/discovery/browser-source.js:7`). There is no Workable-specific worker handling.

What was observed on 2026-09-25 against `clayglobal` and `blueground`:

| Endpoint | Documented | Shape |
|---|---|---|
| `GET www.workable.com/api/accounts/{a}?details=true` → 302 → `apply.workable.com/api/v1/widget/accounts/{a}?details=true` | Yes (Workable Help Centre, "Using the Workable API to create a careers page") | `{name, description, jobs[]}`. Every published job in one response. Fields per job: `title, shortcode, employment_type, telecommuting, department, url, shortlink, application_url, published_on, created_at, country, city, state, locations[{country,countryCode,city,region,hidden}], experience, function, industry, education`, plus `description` (HTML) when `details=true`. |
| `POST apply.workable.com/api/v3/accounts/{a}/jobs` | No | 10 results per page with a `nextPage` token. Adds `workplace` (`remote`/`hybrid`/`on_site`), `type` and `published` (ISO). |
| `GET apply.workable.com/api/v2/accounts/{a}/jobs/{shortcode}` | No | One role: `state`, `workplace`, `description`, `requirements`, `benefits`. |
| `apply.workable.com/{a}/j/{shortcode}/` | — | A JavaScript single-page app with no JobPosting JSON-LD in the server HTML. |

Other findings:
- An unknown account returns HTTP 404 from both the widget and the v3 endpoints.
- `robots.txt` allows everything. No rate-limit headers were seen; the host sits behind Cloudflare.
- On `blueground`, `telecommuting: true` appeared only on the single job that v3 reports as `workplace: remote`. Hybrid and on-site jobs both had `false`.
- The widget's `url` and `shortlink` are account-less `apply.workable.com/j/{shortcode}` links. Those resolve, so shortcodes are effectively global.

## Goals / Non-Goals

**Goals:**
- Read published jobs from operator-configured Workable accounts, using the documented public endpoint.
- Produce normalized opportunities that go through the existing scoring, eligibility and dedup paths unchanged.
- Keep Workable roles out of every automatic submission path, by construction, until a submission adapter exists.
- Stop manual applications to roles that have closed.

**Non-Goals:**
- Submitting Workable applications automatically, or adding a Workable worker adapter. That needs a separate change with its own browser fixtures.
- Discovering accounts: learned boards, crawling, or inferring slugs from browser results.
- Resolving aggregator redirects to Workable destinations (`officialAtsUrlFromAggregator`).
- Workable's authenticated SPI (`{subdomain}.workable.com/spi/v3`), which requires the employer's own API token.
- Distinguishing hybrid from on-site. Both are "not remote" for the existing remote-only pre-screen.

## Decisions

### D1. List through the documented widget endpoint
Use `https://www.workable.com/api/accounts/{slug}?details=true` and follow the redirect.

It is the only listing endpoint Workable documents publicly. It returns the whole account in one request with descriptions, so a scan costs exactly one request per account. That fits the per-source request budget and the official-feed pacing.

**Alternative considered:** v3 `POST …/jobs` gives an explicit `workplace` field. But it is undocumented, pages at 10 per request (so a 200-job board costs 20+ requests), and has no descriptions.

Remote status therefore comes from `telecommuting`. It matched v3 `workplace: remote` on the sample. A false `telecommuting` means "not remote", which is all the remote pre-screen needs.

### D2. Identity and URLs
- **External ID:** `{slug}:{SHORTCODE}`. The slug is lower-cased; the shortcode is upper-cased because Workable prints it that way.
- **Listing URL:** built from the configured slug, not from the widget's account-less `url`, so the account stays visible and checkable: `https://apply.workable.com/{slug}/j/{SHORTCODE}/`.
- **Apply URL:** the listing URL with `apply/` appended.
- **Dedup:** `handled-roles.js` `keyFromUrl` gets a Workable branch. It emits `workable:{SHORTCODE}` for both `/{slug}/j/{code}` and `/j/{code}` on `apply.workable.com`, and ignores a trailing `apply`. The key omits the account because the short link carries none. Shortcodes are globally addressable through the short link, so this is safe.

### D3. A known destination is separate from automatic eligibility
Add `employerAtsDestination(role)` to `official-ats.js`. It returns true for `officialAtsDestination(role)`, or for a `workable` role whose apply URL is its canonical Workable apply URL. It is used in exactly two places:
- to decide `applicationDestinationPending` at `src/discovery/service.js:1188`;
- by source health, to avoid `missing_destination`.

`officialAtsDestination` and `ATS_HOSTS` are **not** extended. Reserve refresh, reserve preloading and standing-authorization freshness already require `officialAtsDestination` or `applicationDestinationVerified`, so Workable roles are excluded there without new checks. Two lanes select by "not pending" instead, and get an explicit `automaticSubmissionUnsupported` check: discovery auto-apply, and campaign ready selection (`startCampaign`). This was found during implementation: with only the pending decision changed, a campaign would have queued Workable roles.

The explicit reason `ats_submission_unsupported` is recorded where those paths currently report ineligible roles (`applicationBlockedBySource`, and the `sourceYield`/health rows), so operators can see why Workable roles don't move.

**Alternative considered:** adding `workable` to `ATS_HOSTS`. That would silently enable automatic submission through the generic Playwright worker, which has never been exercised on Workable forms.

**Alternative considered:** leaving Workable roles "destination pending". That would put them into 30-minute retry churn with a 7-day TTL, and misreport them as `missing_destination`.

### D4. Admission-time revalidation
`requestApplication` gains a Workable-only check. It calls `revalidateWorkableRole(role)`, which uses `GET apply.workable.com/api/v2/accounts/{slug}/jobs/{SHORTCODE}` with a 5-second timeout. Admission succeeds only when all of these hold:
- `state === "published"`;
- the shortcode matches;
- the trimmed title equals the stored title.

A 404 or a mismatch rejects with `role_closed_or_changed`. A network error, timeout or unparsable body rejects as retryable (HTTP 503 class). A closed role is never admitted.

The v2 endpoint is undocumented, but it is per-role and light. If it disappears, the failure mode is "manual Workable requests are rejected as retryable", which is safe and visible.

**Alternative considered:** re-fetching the documented widget listing and looking for the shortcode. That was rejected as the primary check: it downloads the whole account with descriptions for one role. It is kept as the documented fallback if v2 returns 404 for the account path while the listing still works (see Open Questions).

### D5. Request discipline reuses the official-feed machinery
Add `workable` to `STAGED_ATS_SOURCES`. That gives it per-origin pacing (`officialRequestPaceMs`), the raw-pool size, and the 403/429 `discovery.ats_backoff` handling for `workable:{slug}`. The adapter's error text follows the existing `Workable {slug} returned HTTP {status}` form, so the `/returned HTTP (403|429)/` matcher applies unchanged. Other request settings:
- the 20-second list timeout;
- no retries on list calls (the same as the other adapters);
- the user agent `job-application-system/0.2`.

### D6. Normalization details
- `employment_type` values (`Full-time`, `Part-time`, `Contract`, `Temporary`, `Internship`) go through the existing `normalizeEmploymentType`. Temporary maps to `contract`.
- Location: visible `locations[]` entries joined as `city, region, country`, with empty parts dropped. It falls back to the top-level `city/state/country` when `locations` is absent.
- Description: `plainText(description)`. Department, function and industry become `tags`.
- Compensation: the Workable payload has no salary field. Reuse the labelled-salary extractor that Greenhouse uses. It is provider-neutral, so it moves to `labeled-compensation.js` as `labeledAnnualSalary`, and the Greenhouse call sites are updated.
- `applicationQuestions` stays empty. The public listing has no question metadata.

### D7. Catalog and public config
- `config/default.json` gains `"workable": { "boards": [] }`. The `boards` key (rather than a Workable-specific `accounts`) lets the existing board descriptor and backoff filtering in `learned-boards.js` apply unchanged. The privacy gate already allows empty arrays and forbids populated ones.
- `workable` is added to `serverAdapters` in `skills/job-application/references/public-sources.json`, with the name "Workable" and the URL `https://apply.workable.com/`.
- The privacy script's expected catalog, the count in `test/source-catalog.test.js`, and the "seven server adapters" wording in the docs are all updated.
- The starter `config/discovery.example.json` does not enable it, because it needs configured accounts.

## Risks / Trade-offs

- **The documented endpoint changes shape or is retired.** → The adapter validates the payload (a `jobs` array; each job has `title` and `shortcode`). Otherwise it throws `invalid_official_response` per account, which source health reports as an access failure rather than zero supply.
- **The undocumented v2 endpoint changes.** → Only manual admission depends on it, and it fails closed as retryable. D4 names the documented fallback.
- **`telecommuting` understates remote roles.** An employer may mark a remote role on-site. → The role is under-included (safe direction). The operator can still add it by direct link.
- **Large accounts produce big `details=true` payloads.** → One request per account per scan, bounded by the existing raw pool and `limit`. A payload cap (e.g. 10 MB) is enforced before `JSON.parse`.
- **Cloudflare challenges automated clients.** → A 403 triggers the existing 6-hour backoff. A non-JSON body is treated as `challenge`, not as zero jobs.
- **Workable roles pile up with nowhere to go automatically.** → They are reported under `ats_submission_unsupported` in source health and campaign summaries, so the gap is visible and scoped for a follow-up adapter change.

## Migration Plan

- The change is purely additive. Existing deployments see no behaviour change until an operator adds `discovery.sourceOptions.workable.boards` in private config and enables `workable` in a mode or in `automatedDiscoverySources`.
- **Rollback:** remove `workable` from enabled sources. Stored Workable opportunities stay valid records, and are never picked up automatically.

## Open Questions

- Should revalidation fall back to the documented widget listing when v2 fails with a non-404 error, trading one heavier request for independence from the undocumented endpoint? Current plan: no fallback in the first cut; reject as retryable.
- Should campaign reports show a per-source count of `ats_submission_unsupported` roles, to size the follow-up Workable submission adapter? Current plan: yes, through the existing `sourceYield` row, with no new report section.
