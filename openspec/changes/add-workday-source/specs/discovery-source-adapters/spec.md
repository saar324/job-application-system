## ADDED Requirements

### Requirement: Workday sites are read only when configured
The `workday` source SHALL read only the careers sites listed in private `discovery.sourceOptions.workday.sites` as `{ url, company }` entries. A `url` SHALL be an `https` URL on a host of the form `{tenant}.wd{N}.myworkdayjobs.com`, where `N` is 1 to 3 digits. Its path SHALL be the site ID, optionally preceded by a locale segment such as `en-US`. The tenant and site SHALL match `^[A-Za-z0-9_-]{1,100}$`. Any other entry SHALL be ignored. The source SHALL NOT use credentials, cookies or a browser. The source descriptor SHALL report `kind: "official_feed"`, the configured site keys (`{tenant}/{site}`, with the tenant lower-cased), and the filters `board` (configured), `title` (provider) and `location` (local).

#### Scenario: No sites are configured
- **WHEN** a scan includes `workday` and `sourceOptions.workday.sites` is missing or empty
- **THEN** the source returns no results and makes no network request

#### Scenario: A configured URL is parsed
- **WHEN** a site is configured with `https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite`
- **THEN** the source reads tenant `nvidia`, instance `wd5` and site `NVIDIAExternalCareerSite`, and its site key is `nvidia/NVIDIAExternalCareerSite`

#### Scenario: A URL on another host is configured
- **WHEN** a site entry points at a custom careers domain, at `myworkdaysite.com`, at a non-`https` URL, or at a path with a `/job/` segment
- **THEN** that entry is ignored and no request is made for it

#### Scenario: A query names one site
- **WHEN** a query plan for `workday` sets `board` to a configured site key
- **THEN** only that site is requested, and a `board` that is not configured causes no request

### Requirement: Workday searches use the shared title plan within fixed request limits
For each site, the source SHALL send the search terms from the shared title search plan as Workday `searchText`, with empty `appliedFacets` and a page size of exactly 20. It SHALL stop paging a term when:
- a page returns fewer than 20 rows;
- the offset reaches the `total` reported on the term's first page; or
- the per-term page limit is reached.

The source SHALL enforce:
- a maximum number of search terms per site per scan;
- a maximum number of pages per term;
- a maximum number of posting detail reads per site per scan;
- a total request ceiling for the source per scan.

When any limit stops the source reading rows it would otherwise have read, the scan SHALL record a `partial_response_cap` error naming the site. The source SHALL NOT send an empty `searchText` to list a whole site.

#### Scenario: A term has more matches than the page limit
- **WHEN** the first page for a term reports a `total` larger than the per-term page limit allows
- **THEN** the source reads no more than that many pages, and records `partial_response_cap` for the site

#### Scenario: A page is short
- **WHEN** a page returns fewer than 20 rows
- **THEN** no further page is requested for that term

#### Scenario: The plan has no title terms
- **WHEN** the profile's shared title plan yields no search terms
- **THEN** the source makes no Workday request

### Requirement: Workday site failures are isolated and back off
A failed site SHALL be reported as a per-site error, and SHALL NOT fail the other sites or other sources in the scan. An HTTP 404 from the search endpoint SHALL be reported as an unknown site. An HTTP 403 or 429 SHALL start the existing 6-hour ATS board backoff for `workday:{tenant}/{site}`, and SHALL block further requests to that host for the rest of the scan. A response that isn't JSON, or that has no `jobPostings` array, SHALL be reported as `invalid_official_response`, not as zero jobs. Workday requests SHALL use the official-feed per-origin pacing and a 20-second list timeout.

#### Scenario: One site is unknown
- **WHEN** two sites are configured and Workday returns HTTP 404 for one of them
- **THEN** the other site's roles are still returned, and the scan records an error naming the unknown site

#### Scenario: Workday rate-limits the server
- **WHEN** Workday returns HTTP 429 for a site
- **THEN** a `discovery.ats_backoff` event is recorded for `workday:{tenant}/{site}`, the source row is flagged `rateLimited`, and that site is skipped by scans for the next 6 hours

#### Scenario: A challenge page is returned
- **WHEN** the search endpoint returns an HTML page with status 200
- **THEN** the site is reported with `invalid_official_response`, and the source is not reported as having zero supply

### Requirement: Workday jobs are normalized from explicit fields
Each Workday posting that survives the local pre-screen SHALL be read from its detail endpoint, and SHALL be normalized as follows:
- Source `workday`, with the external ID `{tenant}/{site}:{postingKey}`. The posting key is the path segment after the last `_` in the posting's `externalPath`, upper-cased, and SHALL match `^[A-Z0-9-]{2,64}$`.
- The configured company name, falling back to the tenant. Workday's `hiringOrganization` name is a legal entity and SHALL NOT be used as the company.
- The listing URL `https://{tenant}.{instance}.myworkdayjobs.com/{site}{externalPath}`, and the apply URL, which is the listing URL followed by `/apply`.
- The title, `timeType` as the employment type, `startDate` as the posted date, and the description as plain text.
- The location: the primary `location` and every `additionalLocations` entry, joined with `; `.

`remote` SHALL be `true` only when `remoteType` is `Remote` or `Fully Remote` (compared case-insensitively), or, when `remoteType` is empty, when every location has a comma- or dash-separated part equal to `Remote`. A posting SHALL be dropped when:
- its detail shows `posted` false or `canApply` false;
- it has no title; or
- its posting key doesn't parse.

Compensation SHALL remain unknown unless the description contains a clearly labelled annual salary with an ISO currency.

#### Scenario: A remote posting on a tenant without remoteType
- **WHEN** site `nvidia/NVIDIAExternalCareerSite` lists `externalPath` `/job/US-Remote/Software-Engineer--OpenShell_JR2020825`, its detail has location `US, Remote`, `remoteType` null and `timeType` `Full time`
- **THEN** the opportunity has external ID `nvidia/NVIDIAExternalCareerSite:JR2020825`, `remote: true`, employment type `full_time`, and the canonical listing and apply URLs

#### Scenario: A flexible posting
- **WHEN** a posting has `remoteType` `Flex` or `Hybrid`, whatever its location text says
- **THEN** it is not remote, and the adapter pre-screens it out like the other official ATS adapters

#### Scenario: A posting with additional locations
- **WHEN** a posting has location `US, Remote` and one additional location `Canada, Remote`
- **THEN** the opportunity's location is `US, Remote; Canada, Remote`, and it is remote

#### Scenario: A posting mixes remote and office locations
- **WHEN** a posting has `remoteType` null, location `US, Remote` and an additional location `Israel, Yokneam`
- **THEN** it is not remote

#### Scenario: No salary is stated
- **WHEN** the description contains no labelled salary
- **THEN** the opportunity carries the `compensation_unknown` uncertainty, and the compensation floor treats pay as unknown

### Requirement: Workday list rows are pre-screened before detail reads
The source SHALL apply the local title filter and `isHandled` to search rows before reading any detail. It SHALL also skip a row, without reading its detail, when either:
- the row's `remoteType` is set and isn't a remote value; or
- `remoteType` is empty and the row's `locationsText` names one location with no `Remote` part.

A row whose `locationsText` reports several locations (for example `3 Locations`) SHALL be decided from its detail.

#### Scenario: An office-only row
- **WHEN** a search row has `locationsText` `Israel, Yokneam` and no `remoteType`
- **THEN** its detail is not requested

#### Scenario: A multi-location row
- **WHEN** a search row has `locationsText` `2 Locations`
- **THEN** its detail is requested (within the detail limit) and the remote decision uses the detail's locations

### Requirement: Workday roles deduplicate across URL forms
Handled-role deduplication SHALL derive the role key `workday:{tenant}:{postingKey}` from any Workday posting URL on `{tenant}.wd{N}.myworkdayjobs.com`, with or without a locale segment, with or without a trailing `/apply` or `/apply/...` path, and ignoring query parameters. The key SHALL NOT include the instance or the site, so the same posting published on two sites of one tenant is one role. The tenant SHALL be compared case-insensitively.

#### Scenario: JobsPipe returns a Workday apply URL
- **WHEN** the adapter stored `nvidia/NVIDIAExternalCareerSite:JR2020825`, and JobsPipe later returns `https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-Remote/Software-Engineer--OpenShell_JR2020825/apply?source=jobspipe`
- **THEN** the JobsPipe candidate is recognized as the already-handled role

### Requirement: Workday roles have a known destination but no automatic submission
A role from the `workday` source whose apply URL is its canonical Workday apply URL SHALL NOT be marked `applicationDestinationPending`. It SHALL NOT be treated as an official ATS destination for automatic application until a Workday submission adapter is added and specified. Automatic application, campaign ready selection, reserve refresh and standing authorization SHALL skip it, and SHALL record the reason `ats_submission_unsupported`. Source health SHALL NOT count it as `missing_destination`. A manual application request for the role SHALL remain possible, and SHALL require exact final approval.

#### Scenario: Auto-apply meets a Workday role
- **WHEN** `autoApplyDiscovered` is enabled and a Workday role passes every eligibility gate
- **THEN** no application is created, and the role is reported with `ats_submission_unsupported`

#### Scenario: A campaign is started
- **WHEN** a campaign's ready selection includes an eligible Workday role
- **THEN** the role is not queued, and the campaign audit counts it under `submissionUnsupported`

#### Scenario: Standing authorization covers the profile
- **WHEN** a profile has standing authorization and a Workday role qualifies on fit
- **THEN** the standing authorization does not apply, and any application needs exact final approval

### Requirement: Workday roles are revalidated before admission
Before an application for a Workday role is admitted, the server SHALL re-read the role from its Workday detail endpoint, with a 5-second timeout. The application SHALL be admitted only when all of these hold:
- the detail responds successfully;
- `posted` and `canApply` are both true;
- the posting key in the returned `externalUrl` or `jobPostingId` matches;
- the trimmed title is unchanged.

An HTTP 404 or 410, or any mismatch, SHALL be rejected with `role_closed_or_changed`. An unreadable, non-JSON or timed-out response SHALL be rejected as retryable with `workday_revalidation_unavailable`, and SHALL NOT be treated as success.

#### Scenario: The role has closed
- **WHEN** a Workday role's detail returns HTTP 404 when an application is requested
- **THEN** the request is rejected with `role_closed_or_changed`, and no application or worker job is created

#### Scenario: The role no longer accepts applications
- **WHEN** the detail responds with `canApply: false`
- **THEN** the request is rejected with `role_closed_or_changed`

#### Scenario: Workday times out
- **WHEN** the detail does not respond within 5 seconds
- **THEN** the request is rejected as retryable, and no application is created

#### Scenario: The role is still open
- **WHEN** the detail is posted, accepts applications, and has the same posting key and title
- **THEN** the application is admitted under the manual flow, with exact final approval
