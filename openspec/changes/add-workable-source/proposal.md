## Why

Many small and mid-size employers host their careers pages on Workable (for example `https://apply.workable.com/clayglobal/`). The server can't read those boards today. The only Workable awareness in the repo is a worker domain allowlist entry and a browser link-scoring regex. Workable offers a documented, keyless public listing endpoint, the same one its careers-page widget uses. That lets us add Workable as a configured-board source on the same pattern as Greenhouse, Ashby and Lever, without scraping.

## What Changes

- Add a `workable` discovery adapter that reads each configured account with the public endpoint documented in Workable's help centre: `GET https://www.workable.com/api/accounts/{account}?details=true`. That URL redirects to `https://apply.workable.com/api/v1/widget/accounts/{account}?details=true`. One request returns every published job for the account, with descriptions. No key, login or browser is needed.
- Configure accounts in private config under `discovery.sourceOptions.workable.boards[]` as `{ slug, company }`, the same shape as Ashby boards, so the existing board backoff and descriptor code applies unchanged. The public `config/default.json` ships an empty list, and no mode enables the source by default.
- Normalize Workable jobs:
  - The external ID is `{account}:{shortcode}`.
  - The canonical listing URL is `https://apply.workable.com/{account}/j/{shortcode}/`, and the apply URL is the same path with `apply/` appended.
  - Remote status comes only from Workable's explicit `telecommuting` flag.
  - Visible locations, department, employment type, `published_on` and the description are carried over. Pay stays unknown unless the description has a clearly labelled salary.
- Recognize Workable job URLs in handled-role deduplication. Both `apply.workable.com/{account}/j/{shortcode}` and the account-less short link `apply.workable.com/j/{shortcode}` map to one role key, so the same role found by the adapter and by the browser runner is treated as one role.
- Before an application for a Workable role is admitted, revalidate the role against its live Workable record. A closed or changed role is rejected. A timeout or unreadable response is also rejected, but as retryable.
- Treat a Workable role as having a known employer destination, not as "destination pending". But until a Workable submission adapter exists, keep it **out of automatic application**: auto-apply, campaign ready selection and standing authorization all skip it, with the explicit reason `ats_submission_unsupported`. Manual application requests work as they do today, with exact final approval.
- Apply the existing official-feed request discipline: per-origin pacing, a 20-second list timeout, and a 6-hour account backoff after HTTP 403 or 429. A missing account (HTTP 404) is reported as a per-account error.
- Add `workable` to the public starter catalog of server adapters, and to the discovery documentation.

## Capabilities

### New Capabilities

- `discovery-source-adapters`: provider-specific discovery source contracts. This change adds the Workable requirements. The sibling keyed-source proposals (`add-adzuna-source`, `add-jobspipe-source`) add their own requirements to the same capability, and whichever change is archived first creates the spec.

### Modified Capabilities

- None. The `opportunity-eligibility` gates (restricted remote locations, employment type, compensation floor, evidence retention) apply to Workable roles unchanged. The automatic-lane exclusion is new source-specific behaviour and is specified under `discovery-source-adapters`.

## Impact

- **New:** `src/discovery/sources/workable.js`, plus a test file `test/workable.test.js`.
- **`src/discovery/service.js`:** register the source in `SOURCES`, give it an `official_feed` capability descriptor, add it to `STAGED_ATS_SOURCES` pacing and 403/429 backoff, and add `workable` to the board list keys in `learned-boards.js` so backed-off accounts are skipped.
- **`src/discovery/handled-roles.js`:** Workable URL role keys.
- **`src/discovery/official-ats.js`:** Workable identity and revalidation. Both stay separate from `officialAtsDestination`, which remains the gate for automatic application.
- **`src/discovery/service.js` and `src/service.js`:** the pending-destination decision accepts Workable destinations. The automatic lanes and standing authorization record `ats_submission_unsupported`. Workable roles are revalidated when an application is requested.
- **`src/discovery/source-health.js`:** Workable roles are not reported as `missing_destination`.
- **Config and catalog:** `config/default.json` (empty `workable.boards`), `skills/job-application/references/public-sources.json`, `scripts/check-repository-privacy.js` (expected catalog), and `test/source-catalog.test.js` (the catalog count).
- **Docs:** `docs/discovery.md`, `docs/public-starter-sources.md`, `docs/all-source-campaign.md`, `README.md` and `CHANGELOG.md`.
- **No new dependencies or credentials.** Workable's `robots.txt` allows everything, and the endpoint is unauthenticated.
