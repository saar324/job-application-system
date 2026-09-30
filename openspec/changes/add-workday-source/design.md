## Context

`add-workable-source` (implemented in `3d23511` and `3adf155`) set the pattern this change follows. It added:
- a configured-board adapter in `src/discovery/sources/`;
- an identity module (`workable-identity.js`);
- `employerAtsDestination` and `automaticSubmissionUnsupported` in `official-ats.js`, which give a role a known destination while keeping it out of every automatic lane (`ats_submission_unsupported`);
- an admission-time revalidation gate in `requestApplication`.

`officialAtsDestination` and `ATS_HOSTS` stay limited to Ashby, Greenhouse and Lever.

Workday is mentioned in only two places today: the worker domain allowlist (`worker/url-policy.js:5`, `myworkdayjobs.com`), and indirectly through JobsPipe, which aggregates Workday postings.

What was observed on 2026-09-27 against `nvidia.wd5` (`NVIDIAExternalCareerSite`) and `workday.wd5` (`Workday`):

| Call | Documented | Shape |
|---|---|---|
| `POST {host}/wday/cxs/{tenant}/{site}/jobs`, body `{appliedFacets:{}, limit, offset, searchText}` | No. It is the careers site's own backend. | `{total, jobPostings[], facets[]}`. Each row has `title, externalPath, locationsText, postedOn` (relative text, e.g. "Posted 30+ Days Ago"), `bulletFields` (the requisition ID) and, on some tenants, `remoteType`. There is no description. A `limit` above 20 returns **HTTP 400**. `total` is set only on the first page; later pages report `total: 0`. |
| `GET {host}/wday/cxs/{tenant}/{site}{externalPath}` | No | `{jobPostingInfo, hiringOrganization, similarJobs}`. `jobPostingInfo` has `id, title, jobDescription` (HTML), `location, additionalLocations[], remoteType, timeType, startDate` (ISO date), `jobReqId, jobPostingId, jobPostingSiteId, country, canApply, posted, externalUrl`. |
| Unknown posting or unknown site | — | HTTP 404 with a JSON body `{errorCode: "S21", message: "not found: Job_Posting_Anchor_ID=…"}` (or `Job_Posting_Site_ID=…`). |

Other findings:
- **`remoteType` is tenant-defined.** `nvidia` never sets it; its remote roles are named by location (`US, Remote`). `workday` uses `Flex` and `Onsite`. The facet list differs by tenant too: `nvidia` has no `remoteType` facet, and `workday` does.
- **`hiringOrganization.name` is a legal entity**, e.g. `IL00 Mellanox Technologies, Ltd.` on an NVIDIA role.
- **The posting path ends in `_{requisition}`** (`…/Software-Engineer--SPE_JR2015623`), and `jobPostingId` is that last path segment. Requisition formats vary by tenant (`JR2015623`, `JR-0109305`).
- **`robots.txt`** on `nvidia.wd5` allows `/NVIDIAExternalCareerSite/`, disallows `/talentcommunity/` and `/refreshFacet/`, and doesn't mention `/wday/cxs/`. No rate-limit headers were seen.

## Goals / Non-Goals

**Goals:**
- Read matching open roles from operator-configured Workday careers sites, with no credentials or browser.
- Keep the request cost of a scan bounded and predictable, even for employers with thousands of postings.
- Produce normalized opportunities that go through the existing scoring, eligibility and dedup paths unchanged, and dedupe with Workday postings that arrive through JobsPipe or the browser runner.
- Keep Workday roles out of every automatic submission path, by construction, until a submission adapter exists.
- Stop manual applications to roles that have closed.

**Non-Goals:**
- Submitting Workday applications, or adding a Workday worker adapter. Workday forms need a candidate account for each employer (sign-up, email verification, then a multi-page flow), so that needs its own change with browser fixtures and credential handling.
- Custom careers domains that front Workday, and the `myworkdaysite.com` (`/recruiting/{tenant}/{site}`) host form.
- Discovering tenants: learned boards, crawling, or inferring sites from JobsPipe or browser results.
- Server-side facet filtering (`appliedFacets`). Facet IDs and values are opaque and differ by tenant.
- Workday's authenticated integration APIs (RaaS, SOAP/REST), which need the employer's credentials.
- Distinguishing hybrid, `Flex` and on-site roles. All are "not remote" for the existing remote-only pre-screen.

## Decisions

### D1. Search on the provider with the shared title plan, not full listing
Each scan sends the shared plan's terms (`searchTitleQueryPlan(profile, searchTitles, { maximum, cycle: searchCycle })`) as `searchText`. Pages are always 20 rows (`limit: 20`, `offset` in steps of 20). The per-cycle phasing of the plan spreads the terms across cycles, so each scan stays small, and coverage builds over consecutive scans.

The descriptor reports `title: "provider"`, which reflects that Workday does the title matching. The local title filter still runs on every row, because Workday's `searchText` also matches descriptions and returns loose matches.

**Alternative considered:** list each site with an empty `searchText`, like the Workable adapter reads a whole account. NVIDIA alone reported 1,700 matches for one term. A full listing at 20 per page would cost around 100 requests for one employer before any description is read. It is rejected, and the spec forbids empty `searchText`.

**Alternative considered:** a `remoteType` facet to cut rows on the server. Only some tenants expose it, and its value IDs are opaque. It is left as a follow-up (see Open Questions).

### D2. Request limits
First-cut constants in `workday.js`, which private config can't raise:

| Limit | Value |
|---|---|
| Search terms per site per scan | 4 |
| Pages per term | 3 (60 rows) |
| Detail reads per site per scan | 15 |
| Total Workday requests per scan | 120 |
| List timeout | 20 s |
| Detail timeout | 10 s |
| List body cap | 2 MB |
| Detail body cap | 2 MB |

The worst case is 27 requests per site, so the ceiling covers about four fully used sites per scan. In practice the scan's own per-source budget binds first: `maxRequestsPerSource` defaults to 50 and is capped at 50. So the effective ceiling is min(120, that budget), about two fully used sites per scan. When that budget runs out, the adapter keeps the rows it has read and records `partial_response_cap` with `sourceRequestBudget: true`. The service cap is not raised for Workday in this change. Sites are visited in configured order, rotated by `searchCycle`, so a long site list isn't starved at the tail.

Any limit that stops the source reading rows it would otherwise read records `partial_response_cap` with the site key. Detail reads go to the rows that survive pre-screening (D5), newest `postedOn` bucket first.

### D3. Configuration by careers-site URL
Operators copy the careers-site URL they see in a browser: `discovery.sourceOptions.workday.sites[] = { url, company }`. `workday-identity.js` parses and validates it:
- the host must be `{tenant}.wd{N}.myworkdayjobs.com`, with `N` from 1 to 3 digits;
- a leading locale segment (`/en-US/`) is optional;
- the next segment is the site;
- anything after it (a `/job/` path, `/login`, a query) invalidates the entry.

This beats asking operators for three separate fields (tenant, instance, site), which are easy to mistype and can't be checked against each other. The parsed site key is `{tenant}/{site}`, with the tenant lower-cased and the site case preserved, because Workday site IDs are case-sensitive in the path. That key is used for `query.board`, the descriptor's `configuredBoards` and the backoff subject.

`learned-boards.js` `SOURCE_KEYS` holds a `[listKey, fieldName]` pair. It gains an optional key function, so `workday` maps to `["sites", siteKeyOf]` and backoff filtering works unchanged. A shared `configuredBoardKey(sourceId, item)` does the lookup. The source descriptor's `configuredBoards` uses it too, because it previously hard-coded `slug ?? token`. `isLearnedBoardRequest` gets no Workday rule, because learned boards are out of scope.

### D4. Identity and URLs
- **Posting key:** the text after the last `_` in the last segment of `externalPath`, upper-cased, and matching `^[A-Z0-9-]{2,64}$`. On the sample it equals `jobReqId` and the tail of `jobPostingId`. The path is used because it's the only form present in the search row, the detail and every URL, including JobsPipe's.
- **External ID:** `{tenant}/{site}:{postingKey}`.
- **Listing URL:** `https://{tenant}.{instance}.myworkdayjobs.com/{site}{externalPath}`, built without a locale, so it's stable. **Apply URL:** the listing URL followed by `/apply`. Both are rebuilt from parsed parts, never copied from the payload.
- **Dedup key:** `workday:{tenant}:{postingKey}`. It omits the instance, so a tenant moved between `wdN` clusters keeps its keys. It omits the site, so one requisition posted on an external site and a university site is one role. `handled-roles.js` `keyFromUrl` delegates to `workdayKeyFromUrl`, which accepts an optional locale, a trailing `/apply` or `/apply/...`, and any query string. `STABLE_ROLE_KEY` gains `workday`, for dedup only.
- **`workdayDestination(role)`** is true only when `role.applyUrl` is exactly the canonical apply URL for the role's parsed identity. It requires `https`, no credentials and no query, and the key must round-trip.

### D5. Remote decision and list pre-screen
Remote must come from something the employer states explicitly. Workday offers two tenant-dependent signals:
1. `remoteType` equal to `Remote` or `Fully Remote` (case-insensitive) means remote. Any other non-empty value (`Flex`, `Hybrid`, `Onsite`, `On-site`) means not remote, whatever the location text says.
2. When `remoteType` is empty, the role is remote only if **every** location (primary and additional) has a comma- or dash-separated part exactly equal to `Remote`, e.g. `US, Remote` or `Remote - Germany`. One office location makes the role not remote. This keeps Workable's safe direction: under-include rather than guess.

The list pre-screen applies the same rule to what a row carries, so no detail is fetched for rows already decided:
- a set, non-remote `remoteType` → skip;
- no `remoteType` and a single named location with no `Remote` part → skip;
- `N Locations` → undecided, so the detail read decides.

The local title filter and `isHandled` run before any detail read. The restricted-remote-location eligibility gate then treats `US, Remote` as a country-restricted remote role, as it does for other sources.

**Alternative considered:** treating any "Remote" substring as remote. That would count `Remote-friendly office` or `Flex (Remote possible)` as remote, and it is rejected.

### D6. Normalization details
- `timeType` goes through `normalizeEmploymentType`: `Full time` or `Full Time` → `full_time`, `Part time` → `part_time`. Workday puts contract status in `workerSubType`, which is a facet, not a row field. So employment type is `full_time` or `part_time` from `timeType`, or unknown.
- The posted date is `startDate` from the detail (an ISO date). The list's relative `postedOn` is used only to order detail reads.
- Description: `plainText(jobDescription)`. Compensation: `labeledAnnualSalary(description)` from `labeled-compensation.js`.
- Company: the configured company, falling back to the tenant, never `hiringOrganization.name`.
- `applicationQuestions` stays empty.
- A detail with `posted !== true` or `canApply !== true` is dropped.

### D7. The HTTP method through official-feed fetching
`STAGED_ATS_SOURCES` gains `workday`. That gives it `pacedOfficialFetch` (per-origin pacing, and `blockedOfficialOrigins` after 403/429), the raised raw pool, and the `discovery.ats_backoff` recording. Every adapter so far only GETs. The implementation must confirm two things:
- `pacedOfficialFetch` and `cachedFetch` pass `method` and `body` through;
- any response cache is keyed on method and body, or skipped for POST, so two search terms never share a cached page.

Error text follows `Workday {tenant}/{site} returned HTTP {status}`, so the existing `/returned HTTP (403|429)\b/i` matcher applies. List calls are not retried. The user agent is `job-application-system/0.2`, and the `content-type` is `application/json`.

Each tenant is its own origin, so per-origin pacing doesn't slow down requests to different tenants on the same `wdN` cluster. The total ceiling in D2 is what bounds load on the cluster.

### D8. The destination lanes reuse the Workable mechanism
`automaticSubmissionUnsupported(role)` becomes `workableDestination(role) || workdayDestination(role)`. `employerAtsDestination` already builds on it, so these lanes pick Workday up with no new call sites:
- the pending decision in `src/discovery/service.js`;
- the auto-apply and campaign exclusions;
- the `sourceYield` and source-health `submission_unsupported` rows;
- reserve and standing-authorization exclusion (already keyed on `officialAtsDestination`).

One call site has to be extended by hand: `knownRoleIndex` in `handled-roles.js` calls `workableDestination` directly, because importing `official-ats.js` there would be circular. It also needs `workdayDestination`. Otherwise stored Workday roles would count as unresolved and be found again on every scan.

`officialAtsDestination` and `ATS_HOSTS` are not extended, for the same reason as in the Workable design: the generic Playwright worker has never been exercised on Workday forms.

### D9. Admission-time revalidation
`revalidateWorkdayRole(role, fetchImpl)` lives in `official-ats.js`. It rebuilds the detail URL from the role's canonical listing URL, and never from the payload. It returns `"open" | "closed_or_changed" | "unavailable"` with the same semantics as `revalidateWorkableRole`. The checks are listed in the spec. `requestApplication` dispatches on `source`:
- `closed_or_changed` → `ClientError(409, "role_closed_or_changed: …")`;
- `unavailable` → `ClientError(503, "workday_revalidation_unavailable: …")`.

The detail endpoint is undocumented. If it changes, the failure mode is "manual Workday requests are rejected as retryable", which is safe and visible.

### D10. Catalog and public config
- `config/default.json` gains `"workday": { "sites": [] }`. The privacy gate already allows empty arrays and forbids populated ones.
- `serverAdapters` in `skills/job-application/references/public-sources.json` gains `{ "id": "workday", "name": "Workday", "url": "https://www.workday.com/" }`.
- The privacy script's expected catalog and the counts in `test/source-catalog.test.js` and `test/public-starter-cli.test.js` are updated, along with the server-adapter wording in the docs.
- `config/discovery.example.json` doesn't enable the source, because it needs configured sites.

## Risks / Trade-offs

- **The endpoint is undocumented and may change or be restricted.** → The adapter validates both payloads (a `jobPostings` array; a `jobPostingInfo` with `title` and `externalPath` or `externalUrl`) and fails per site with `invalid_official_response`, which source health reports as an access failure rather than zero supply. The source is opt-in, per site, in private config only. Unlike Workable, there is no documented fallback.
- **Terms of use.** Workday's customers own their careers sites, and the endpoint serves the same public data the site shows. → Low volume by construction (D2), an honest user agent, no login and no facet probing. Operators decide which employers to list. The docs will say plainly that the endpoint is undocumented.
- **The request cost is higher than for other official feeds.** → The D2 ceilings plus `partial_response_cap` make truncation visible. Plan phasing spreads terms across cycles.
- **Remote detection is tenant-dependent and conservative.** Tenants that use neither a remote `remoteType` nor "Remote" location names will yield no remote roles. → Safe direction. Unrecognized non-empty `remoteType` values are counted in `onStats` (as `unrecognizedRemoteType`), so operators can see when a tenant needs a rule.
- **Posting-key parsing may not fit every tenant's path format.** → Rows whose key doesn't parse are dropped and counted, not guessed. Tests cover `JR…`, `JR-…` and `R…` forms, and a `-1` suffix.
- **Workday roles pile up with nowhere to go automatically.** → They are reported under `ats_submission_unsupported`, as Workable roles are, which sizes the follow-up submission adapter.
- **Scans take longer.** Detail reads are sequential per origin because of pacing. → The per-site detail cap bounds that. Sites on different tenants run concurrently through `Promise.allSettled`.

## Migration Plan

- The change is purely additive. Existing deployments see no behaviour change until an operator adds `discovery.sourceOptions.workday.sites` in private config and enables `workday` in a mode or in `automatedDiscoverySources`.
- **Rollback:** remove `workday` from enabled sources. Stored Workday opportunities stay valid records, and are never picked up automatically.

## Open Questions

- Should the D2 limits be overridable in private config, within hard upper bounds? Current plan: constants only in the first cut; revisit after a live pilot shows the real yield per request.
- Should the `remoteType` facet be applied on the server when a tenant exposes it, to spend fewer list requests? It would mean reading the facet list once per site and matching a value named `Remote`. Current plan: not in the first cut.
- Should the remote rule also accept tenant-specific `remoteType` values such as `Virtual` or `Remote Eligible`? Current plan: no. Collect `unrecognizedRemoteType` counts during the pilot first.
- **Pilot, 2026-09-28, `globalfoundries.wd1` / `External`, one scan:**
  - 13 requests: 12 search pages and 1 detail read. 240 rows were read.
  - About 106 rows were duplicates across overlapping terms ("Program Manager", "Technical Program Manager" and so on). 134 were pre-screened out. 0 roles were found, and nothing was queued.
  - Every term hit the 3-page limit (for example, "Program Manager" alone matches 451 rows), so `partial_cap` will be the normal health status for large sites.
  - The tenant sets no `remoteType` and labels non-office roles `OFFSITE`, which the conservative remote rule correctly treats as not remote.
  
  Open: should overlapping terms be collapsed before searching a Workday site, given that about 44% of the rows read were repeats?
- **Pilot, 2026-09-28, `workday.wd5` / `Workday`:**
  - A service scan made 12 requests and found 0 roles, which is correct. Only 10 of the site's 381 jobs are `remoteType: Remote`, and none of them matches the profile's titles. The rest are `Flex` or `Onsite`.
  - Every term again hit the 3-page limit, because `searchText` matches loosely (164 to 338 matches per term).
  - A direct adapter call for one remote posting (`JR-0108918`) produced:
    - correct canonical listing and apply URLs, without the configured `en-US` locale;
    - `remote: true`, `full_time`, `postedAt` taken from `startDate`, and 20 joined locations;
    - `employerAtsDestination` true and `officialAtsDestination` false.
  
  Open:
  - The description states "Primary Location Base Pay Range: $162,200 USD - $243,200 USD", but `labeledAnnualSalary` returns nothing for that format, so compensation stays unknown. Widening the shared extractor affects Greenhouse and Workable too, so it belongs in a separate change.
  - On sites whose remote roles are a small fraction of the total, page-limited title searches may never reach them. Applying the `remoteType` facet on the server, when the site exposes one (as here, id `…334b0000`), would find them in one request.
- Should JobsPipe's Workday rows be routed to `revalidateWorkdayRole` at admission too, since their apply URLs parse as Workday identities? Current plan: no. Revalidation keys on `source === "workday"` only, and JobsPipe keeps its own freshness handling.
