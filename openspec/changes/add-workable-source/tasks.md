## 1. Adapter

- [x] 1.1 Create `src/discovery/sources/workable.js` with `id: "workable"`. Read `sourceConfig.boards[]` as `{slug, company}`, drop entries whose slug fails `^[a-z0-9_-]{1,100}$`, and honour `query.board`
- [x] 1.2 Fetch `https://www.workable.com/api/accounts/{slug}?details=true` per account with `Promise.allSettled`, the user agent `job-application-system/0.2`, a 20-second timeout and a payload size cap. Throw `Workable {slug} returned HTTP {status}` on non-2xx responses, and `invalid_official_response` on a non-JSON body or a missing `jobs` array
- [x] 1.3 Normalize each job as the spec and design D2/D6 describe. That covers the external ID, canonical listing and apply URLs, `telecommuting`-only remote, visible locations, employment type, `published_on`, plain-text description, tags and labelled-salary compensation
- [x] 1.4 Apply the shared title and location pre-screen and `isHandled`, sort by posted date, and emit `onStats` and the `partial_response_cap` error in the same way as `greenhouse.js`
- [x] 1.5 Move the salary extractor to `labeled-compensation.js` as the provider-neutral `labeledAnnualSalary`, and update the Greenhouse and official-ATS call sites

## 2. Registration and request discipline

- [x] 2.1 Register `workable` in `SOURCES` in `src/discovery/service.js`, and add its `official_feed` capability descriptor (`board: configured`, `title: local`, `location: local`)
- [x] 2.2 Add `workable: ["boards", "slug"]` to the board list keys in `learned-boards.js`, so the descriptor's `configuredBoards` and board backoff filtering apply
- [x] 2.3 Add `workable` to `STAGED_ATS_SOURCES` so pacing, the raw pool and the 403/429 `discovery.ats_backoff` handling apply. Confirm that a 404 is recorded as a per-account error only
- [x] 2.4 Add `"workable": { "boards": [] }` to `config/default.json`, and confirm that `npm run privacy:check` passes

## 3. Identity, dedup and destination handling

- [x] 3.1 Add a Workable branch to `keyFromUrl` in `src/discovery/handled-roles.js`. It emits `workable:{SHORTCODE}` for `/{slug}/j/{code}`, `/j/{code}` and a trailing `apply/` on `apply.workable.com`. Update the official-key regexes that must recognize it for dedup, but not the ones that gate automation
- [x] 3.2 Add `employerAtsDestination(role)` to `src/discovery/official-ats.js`, leaving `officialAtsDestination` and `ATS_HOSTS` unchanged. Use it for the pending decision at `src/discovery/service.js:1188` and in `source-health.js`
- [x] 3.3 Record `ats_submission_unsupported` where auto-apply sets `applicationBlockedBySource`, and in the source yield and health rows, for Workable roles that pass eligibility
- [x] 3.4 Add `revalidateWorkableRole(role, fetchImpl)` using the v2 job endpoint with a 5-second timeout. Call it from `requestApplication` for `source === "workable"`: reject `role_closed_or_changed` on a 404 or mismatch, and reject as retryable on network, timeout or parse failure

## 4. Tests

- [x] 4.1 `test/workable.test.js`, adapter cases with an injected `fetchImpl`:
  - normalization of the clayglobal-shaped fixture (neutral names, `example.test` company);
  - a hidden location is excluded;
  - `telecommuting: false` with "Remote" in the location stays non-remote;
  - no accounts means no fetch;
  - an invalid slug is ignored;
  - `query.board` filtering;
  - a 404 on one account while the other still returns;
  - a 429 message matches the backoff regex;
  - a non-JSON body gives `invalid_official_response`
- [x] 4.2 `test/handled-roles.test.js`: the slugged URL, the short link, a trailing `apply/`, a lower-case shortcode and tracking parameters all produce one key
- [x] 4.3 `test/discovery.test.js` (service level):
  - a Workable role is not `applicationDestinationPending`;
  - it is excluded from auto-apply and campaign ready selection with `ats_submission_unsupported`;
  - source health does not report `missing_destination`
- [x] 4.4 Standing authorization regression: a qualifying Workable role under standing authorization still needs exact final approval
- [x] 4.5 Admission revalidation: published and matching admits; a 404 rejects `role_closed_or_changed`; a title change rejects; a timeout rejects as retryable and creates no application
- [x] 4.6 Update `test/source-catalog.test.js` (count and entry) and any `test/config.test.js` expectations for `sourceOptions`

## 5. Catalog and docs

- [x] 5.1 Add `workable` to `serverAdapters` in `skills/job-application/references/public-sources.json`, and to the expected catalog in `scripts/check-repository-privacy.js`
- [x] 5.2 Update `docs/discovery.md`: the adapter list and count, the private `sourceOptions.workable.boards` example, and a note that Workable roles are discovery-only for automation
- [x] 5.3 Update the server-adapter lists and counts in `docs/public-starter-sources.md`, `docs/all-source-campaign.md`, `README.md` and `skills/job-application/SKILL.md`
- [x] 5.4 Add a `CHANGELOG.md` entry

## 6. Verification

- [x] 6.1 Run `npm run check` (syntax, privacy and tests) and confirm it passes
- [ ] 6.2 With a private config listing one real account, run a single simulated scan limited to `workable`. Confirm that normalized roles appear with canonical URLs, no role is queued automatically, and source health shows the roles under `ats_submission_unsupported`
