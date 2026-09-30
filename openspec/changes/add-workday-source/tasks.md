## 1. Identity

- [x] 1.1 Create `src/discovery/workday-identity.js` with:
  - `workdaySite(url)`, which parses `{tenant, instance, site, key}` from a careers-site URL as D3 describes and returns `null` for any other host or path;
  - `workdayPostingKey(externalPath)`;
  - `workdayRoleUrls(site, externalPath)`;
  - `workdayKeyFromUrl(url)`, which accepts an optional locale, `/apply` or `/apply/...` and a query string;
  - `workdayIdentity(role)`;
  - `workdayDestination(role)`.
- [x] 1.2 Add a Workday branch to `keyFromUrl` and `roleKeys` in `src/discovery/handled-roles.js`, and add `workday` to `STABLE_ROLE_KEY`. Leave the regexes that gate automation unchanged.

## 2. Adapter

- [x] 2.1 Create `src/discovery/sources/workday.js` with `id: "workday"`. It reads `sourceConfig.sites[]` as `{url, company}` through `workdaySite`, drops invalid entries, honours `query.board` against the site key, and rotates the site order by `searchCycle`.
- [x] 2.2 Build the terms from `searchTitleQueryPlan(profile, searchTitles, { cycle: searchCycle })`, capped at 4 per site. Make no request when there are no terms.
- [x] 2.3 Search with `POST /wday/cxs/{tenant}/{site}/jobs`:
  - body `{appliedFacets:{}, limit:20, offset, searchText}`;
  - a 20-second timeout and a 2 MB body cap;
  - stop on a short page, on the first page's `total`, or after 3 pages;
  - throw `Workday {tenant}/{site} returned HTTP {status}` on non-2xx responses (with `(unknown site)` for a 404), and `invalid_official_response` on a non-JSON body or a missing `jobPostings`.
- [x] 2.4 Pre-screen the rows as D5 describes: the local title filter, `isHandled`, then the list-level remote rule. Dedupe rows by posting key across terms.
- [x] 2.5 Read the details of the survivors (up to 15 per site, newest `postedOn` bucket first), with a 10-second timeout. Drop details with `posted`/`canApply` not true, or with an unparsable key.
- [x] 2.6 Normalize as D4 and D6 describe: the external ID, rebuilt canonical URLs, company fallback, joined locations, the D5 remote rule, `timeType`, `startDate`, plain-text description, and `labeledAnnualSalary`.
- [x] 2.7 Enforce the 120-request source ceiling. Emit `partial_response_cap` for any limit that truncates reading. Emit `onStats` with `rawRows`, `adapterPrescreenRejected`, `pagesVisited`, `detailReads` and `unrecognizedRemoteType`.

## 3. Registration and request discipline

- [x] 3.1 Register `workday` in `SOURCES` in `src/discovery/service.js`, with the descriptor `{ kind: "official_feed", filters: { board: "configured", title: "provider", location: "local" }, automaticSubmission: "unsupported" }`. Pass `searchTitles` and `searchCycle` to it.
- [x] 3.2 Add `workday` to `STAGED_ATS_SOURCES`. Confirm that `pacedOfficialFetch` and `cachedFetch` pass `method` and `body` through, and that no cache serves a POST response for a different body. Fix them, with a regression test, if they don't.
- [x] 3.3 Let `SOURCE_KEYS` in `learned-boards.js` take a key function. Add `workday: ["sites", siteKeyOf]`, so that `configuredBoards` and the `workday:{tenant}/{site}` backoff filtering apply. Add no `isLearnedBoardRequest` rule.
- [x] 3.4 Confirm that a 403/429 records `discovery.ats_backoff` for `workday:{tenant}/{site}` and blocks the host for the rest of the scan, and that a 404 is recorded as a per-site error only.
- [x] 3.5 Add `"workday": { "sites": [] }` to `config/default.json`, and confirm that `npm run privacy:check` passes.

## 4. Destination handling and admission

- [x] 4.1 Extend `automaticSubmissionUnsupported` in `src/discovery/official-ats.js` to accept `workdayDestination(role)`. Leave `officialAtsDestination` and `ATS_HOSTS` unchanged.
- [x] 4.2 Add `revalidateWorkdayRole(role, fetchImpl)`, which returns `open | closed_or_changed | unavailable` as the spec and D9 describe, with a 5-second timeout and the URL rebuilt from the canonical listing URL.
- [x] 4.3 In `requestApplication` in `src/service.js`, call it for `source === "workday"`. Map the results to `role_closed_or_changed` (409) and `workday_revalidation_unavailable` (503).

## 5. Tests

- [x] 5.1 `test/workday.test.js`, adapter cases with an injected `fetchImpl` and neutral fixtures shaped like the `nvidia` and `workday` samples (`example` tenant names):
  - URL parsing: a locale, a trailing slash, a custom domain, `myworkdaysite.com`, `http`, and a `/job/` path;
  - no sites or no terms means no fetch;
  - `query.board` filtering;
  - the page size is always 20, and paging stops on a short page, on `total`, and at the page limit with `partial_response_cap`;
  - the detail cap and the request ceiling;
  - a 404 on one site while the other still returns; a 429 message matches the backoff regex; an HTML 200 gives `invalid_official_response`.
- [x] 5.2 Normalization and the remote rule:
  - `US, Remote`;
  - `Remote - Germany`;
  - `Flex` with remote-looking text;
  - mixed remote and office locations;
  - `N Locations` resolved from the detail;
  - `posted: false` and `canApply: false` dropped;
  - posting keys in the `JR…`, `JR-…`, `R…` and `-1` suffix forms;
  - company fallback that ignores `hiringOrganization`;
  - `compensation_unknown`.
- [x] 5.3 Dedup: the listing URL, a locale URL, `/apply`, `/apply/…`, tracking parameters, another site of the same tenant, and a JobsPipe-shaped Workday URL all give one key.
- [x] 5.4 Service level (a fixture like `workableFixture`):
  - a Workday role is not `applicationDestinationPending`;
  - it is excluded from auto-apply and from campaign ready selection with `ats_submission_unsupported`;
  - source health reports `submission_unsupported`, not `missing_destination`;
  - standing authorization still needs exact final approval.
- [x] 5.5 Admission revalidation:
  - open and matching admits;
  - 404, `canApply: false`, a title change and a key mismatch each reject `role_closed_or_changed`;
  - a timeout or non-JSON response rejects as retryable and creates no application.
- [x] 5.6 Update `test/source-catalog.test.js` (the count and the entry) and `test/public-starter-cli.test.js` (the adapter list).

## 6. Catalog and docs

- [x] 6.1 Add `workday` to `serverAdapters` in `skills/job-application/references/public-sources.json`, and to the expected catalog in `scripts/check-repository-privacy.js`.
- [x] 6.2 Add a `## Workday` section to `docs/discovery.md`, covering:
  - the careers-site URL config example;
  - that the endpoint is undocumented;
  - the request limits and `partial_response_cap`;
  - the remote rule;
  - 404/403/429 behaviour;
  - `ats_submission_unsupported`, `role_closed_or_changed` and `workday_revalidation_unavailable`.
- [x] 6.3 Update the server-adapter lists and counts in `docs/public-starter-sources.md`, `docs/all-source-campaign.md`, `README.md` and `skills/job-application/SKILL.md`.
- [x] 6.4 Add a `CHANGELOG.md` entry.

## 7. Verification

- [x] 7.1 Run `npm run check` (syntax, privacy and tests) and confirm it passes.
- [x] 7.2 With a private config listing one or two real sites, run a single simulated scan limited to `workday`. Confirm that:
  - the request count stays within the D2 limits;
  - normalized roles appear with canonical URLs;
  - no role is queued automatically;
  - source health shows the roles under `ats_submission_unsupported`.
  
  Record the `unrecognizedRemoteType` counts to feed the open questions.
  
  Done on 2026-09-28 against `globalfoundries.wd1/External` and `workday.wd5/Workday`:
  - both scans stayed within the D2 limits (13 and 12 requests) and queued nothing;
  - `unrecognizedRemoteType` was 0 on both.
  
  Neither scan found a role that matches the profile, so the canonical URLs and the destination flags were confirmed on a real remote posting through a direct adapter call. `ats_submission_unsupported` in source health is covered by the service-level tests. See the pilot notes in `design.md`.
