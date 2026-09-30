## Why

Many large employers host their careers sites on Workday (for example `https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite`). The server can't read those sites today. The only Workday awareness in the repo is the `myworkdayjobs.com` entry in the worker domain allowlist, plus whatever Workday postings JobsPipe happens to aggregate. Every Workday careers site is a single-page app backed by a keyless JSON search endpoint on the same host. That lets us add Workday as a configured-site source on the same pattern as Workable, without a browser.

Unlike Workable's widget endpoint, Workday's endpoint is **not publicly documented**. It is the endpoint the careers site itself calls. Its cost is also different: it pages at 20 jobs and returns no descriptions, so a naive full scan of a large employer costs hundreds of requests. The proposal is shaped around those two facts.

## What Changes

- Add a `workday` discovery adapter. For each configured careers site it sends title searches to `POST https://{tenant}.{instance}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs`. It reads each shortlisted role with `GET …/wday/cxs/{tenant}/{site}{externalPath}`. No key, login, cookie or browser is needed.
- Search terms come from the shared title search plan (`searchTitleQueryPlan`), the same one Adzuna and JobsPipe use. Workday matches `searchText` on the server, so a scan reads only matching roles, not the whole site.
- Hard request limits per site and per scan:
  - fixed pages of 20 (Workday rejects more with HTTP 400);
  - a capped number of search terms and pages per site;
  - a capped number of detail reads per site;
  - a total request ceiling for the source.
  Hitting a limit is reported as `partial_response_cap`, not as silent truncation.
- Configure sites in private config under `discovery.sourceOptions.workday.sites[]` as `{ url, company }`, where `url` is the public careers-site URL. The adapter parses the tenant, the instance (`wdN`) and the site ID from it, and drops anything that doesn't parse. The public `config/default.json` ships an empty list, and no mode enables the source by default.
- Normalize Workday jobs:
  - The external ID is `{tenant}/{site}:{postingKey}`. The posting key is the trailing requisition segment of the posting path, for example `JR2015623`.
  - The canonical listing URL is the careers-site posting URL, and the apply URL is the same path with `/apply` appended.
  - A role is remote only when Workday's `remoteType` says so, or when every one of its locations is explicitly named "Remote". `Flex`, `Hybrid` and `Onsite` are not remote.
  - The primary and additional locations, `timeType`, `startDate` as the posted date and the description are carried over. Pay stays unknown unless the description has a clearly labelled salary.
- Recognize Workday posting URLs in handled-role deduplication, with or without a locale segment, a trailing `/apply` or tracking parameters. The same role found by this adapter, by JobsPipe or by the browser runner is then treated as one role.
- Before an application for a Workday role is admitted, revalidate the role against its live record. A closed or changed role is rejected. A timeout or unreadable response is also rejected, but as retryable.
- Treat a Workday role as having a known employer destination, not as "destination pending". Keep it **out of automatic application**, with the same `ats_submission_unsupported` reason Workable uses. Workday application forms also need a candidate account for each employer, which the worker can't handle today. Manual application requests work as they do today, with exact final approval.
- Apply the existing official-feed request discipline: per-origin pacing, a 20-second list timeout, and a 6-hour backoff for the site after HTTP 403 or 429. An unknown site (HTTP 404) is reported as a per-site error.
- Add `workday` to the public starter catalog of server adapters, and to the discovery documentation.

## Capabilities

### New Capabilities

- `discovery-source-adapters`: provider-specific discovery source contracts. This change adds the Workday requirements. The sibling proposals (`add-workable-source`, `add-adzuna-source`, `add-jobspipe-source`) add their own requirements to the same capability. None of them is archived yet, so whichever change is archived first creates the spec.

### Modified Capabilities

- None. The `opportunity-eligibility` gates (restricted remote locations, employment type, compensation floor, evidence retention) apply to Workday roles unchanged. The automatic-lane exclusion reuses the Workable mechanism and is specified under `discovery-source-adapters`.

## Impact

- **New:** `src/discovery/sources/workday.js` and `src/discovery/workday-identity.js`, plus a test file `test/workday.test.js`.
- **`src/discovery/service.js`:**
  - register the source in `SOURCES`, with an `official_feed` descriptor (`board: configured`, `title: provider`, `location: local`, `automaticSubmission: "unsupported"`);
  - add it to `STAGED_ATS_SOURCES`, for pacing and the 403/429 backoff;
  - pass `searchTitles` and `searchCycle` through to it.
  
  The paced official fetch must carry a POST body, and must not serve one search's cached response for another.
- **`src/discovery/learned-boards.js`:** a derived board key (`{tenant}/{site}`), so backed-off sites are skipped. No learned-board discovery for Workday.
- **`src/discovery/handled-roles.js`:** Workday role keys from URLs and external IDs.
- **`src/discovery/official-ats.js`:**
  - `automaticSubmissionUnsupported` and `employerAtsDestination` accept canonical Workday destinations;
  - a new `revalidateWorkdayRole`.
  
  `officialAtsDestination` and `ATS_HOSTS` stay unchanged.
- **`src/service.js`:** `requestApplication` revalidates Workday roles, alongside the existing Workable gate.
- **Config and catalog:** `config/default.json` (empty `workday.sites`), `skills/job-application/references/public-sources.json`, `scripts/check-repository-privacy.js` (the expected catalog), `test/source-catalog.test.js` and `test/public-starter-cli.test.js`.
- **Docs:** `docs/discovery.md`, `docs/public-starter-sources.md`, `docs/all-source-campaign.md`, `README.md`, `skills/job-application/SKILL.md` and `CHANGELOG.md`.
- **No new dependencies or credentials.** The endpoint is unauthenticated. The sampled tenant's `robots.txt` allows the careers-site path and doesn't mention `/wday/cxs/`.
