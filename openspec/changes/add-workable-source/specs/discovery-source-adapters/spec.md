## ADDED Requirements

### Requirement: Workable boards are read only for configured accounts
The `workable` source SHALL read only the accounts listed in private `discovery.sourceOptions.workable.boards` as `{ slug, company }` entries. A slug SHALL match `^[a-z0-9_-]{1,100}$` after lower-casing, and any other entry SHALL be ignored. For each account the source SHALL send one request to Workable's public account endpoint with `details=true`, and SHALL NOT use credentials, cookies or a browser. The source descriptor SHALL report `kind: "official_feed"`, the configured account slugs, and the filters `board` (configured), `title` (local) and `location` (local).

#### Scenario: No accounts are configured
- **WHEN** a scan includes `workable` and `sourceOptions.workable.boards` is missing or empty
- **THEN** the source returns no results and makes no network request

#### Scenario: A query names one account
- **WHEN** a query plan for `workable` sets `board: "clayglobal"` and `clayglobal` is a configured account
- **THEN** only that account is requested

#### Scenario: A query names an unconfigured account
- **WHEN** a query plan for `workable` sets `board` to a slug that is not configured
- **THEN** no request is made for that slug

#### Scenario: An invalid slug is configured
- **WHEN** an account entry has a slug containing `/`, `?` or whitespace
- **THEN** that entry is ignored and never sent to Workable

### Requirement: Workable account failures are isolated and back off
A failed account SHALL be reported as a per-account error and SHALL NOT fail the other accounts or other sources in the scan. An HTTP 404 SHALL be reported as an unknown account. An HTTP 403 or 429 SHALL start the existing 6-hour ATS board backoff for `workable:{slug}`, and SHALL block further Workable requests for the rest of the scan. Workable requests SHALL use the official-feed per-origin pacing and a 20-second timeout.

#### Scenario: One account is unknown
- **WHEN** two accounts are configured and Workable returns HTTP 404 for one of them
- **THEN** the other account's roles are still returned, and the scan records an error naming the unknown account

#### Scenario: Workable rate-limits the server
- **WHEN** Workable returns HTTP 429 for an account
- **THEN** a `discovery.ats_backoff` event is recorded for `workable:{slug}`, the source row is flagged `rateLimited`, and that account is skipped by scans for the next 6 hours

### Requirement: Workable jobs are normalized from explicit fields
Each published Workable job SHALL be normalized as follows:
- Source `workable`, with the external ID `{slug}:{shortcode}` (shortcode upper-cased).
- The configured company name, falling back to the account name returned by Workable and then the slug.
- The listing URL `https://apply.workable.com/{slug}/j/{shortcode}/`, and the apply URL `https://apply.workable.com/{slug}/j/{shortcode}/apply/`.
- The job's title, department, employment type, `published_on` as the posted date, and the description as plain text.
- A location built only from entries in `locations` that are not marked `hidden`. Workable repeats a multi-location job once per location under the same shortcode; those rows SHALL be merged into one opportunity whose location lists every visible location.

`remote` SHALL be `true` only when Workable's `telecommuting` flag is `true`. A job with no title or shortcode SHALL be dropped. Compensation SHALL remain unknown unless the description contains a clearly labelled annual salary with an ISO currency.

#### Scenario: A remote job is listed
- **WHEN** account `clayglobal` lists a job with shortcode `869d4d5ffd`, `telecommuting: true` and `employment_type: "Contract"`
- **THEN** the opportunity has external ID `clayglobal:869D4D5FFD`, `remote: true`, employment type `contract`, and the canonical listing and apply URLs above

#### Scenario: An office-based job is listed
- **WHEN** a job has `telecommuting: false`, even if its location text contains "Remote"
- **THEN** the adapter pre-screens it out, like the other official ATS adapters, which read only remote roles

#### Scenario: A job is repeated once per location
- **WHEN** the feed lists shortcode `FAD6715D76` twice, once with location Romania and once with Greece
- **THEN** one opportunity is produced, with the location `Romania; Greece`, so each country is treated as an alternative

#### Scenario: A location entry is hidden
- **WHEN** a job has one visible location and one location marked `hidden: true`
- **THEN** only the visible location appears in the opportunity's location

#### Scenario: No salary is stated
- **WHEN** the description contains no labelled salary
- **THEN** the opportunity carries the `compensation_unknown` uncertainty, and the compensation floor treats pay as unknown

### Requirement: Workable roles deduplicate across URL forms
Handled-role deduplication SHALL derive the same role key from `https://apply.workable.com/{slug}/j/{shortcode}` (with or without a trailing `apply/`) and from the account-less short link `https://apply.workable.com/j/{shortcode}`. The shortcode SHALL be compared case-insensitively, and tracking parameters SHALL be ignored.

#### Scenario: The browser runner finds a short link
- **WHEN** the adapter stored `clayglobal:869D4D5FFD` and the browser runner later finds `https://apply.workable.com/j/869D4D5FFD?utm_source=x`
- **THEN** the browser candidate is recognized as the already-handled role

### Requirement: Workable roles have a known destination but no automatic submission
A role from the `workable` source whose apply URL is its canonical Workable apply URL SHALL NOT be marked `applicationDestinationPending`. It SHALL NOT be treated as an official ATS destination for automatic application until a Workable submission adapter is added and specified. Automatic application, campaign ready selection, reserve refresh and standing authorization SHALL skip it, and SHALL record the reason `ats_submission_unsupported`. Source health SHALL NOT count it as `missing_destination`. A manual application request for the role SHALL remain possible and SHALL require exact final approval.

#### Scenario: Auto-apply meets a Workable role
- **WHEN** `autoApplyDiscovered` is enabled and a Workable role passes every eligibility gate
- **THEN** no application is created, and the role is reported with `ats_submission_unsupported`

#### Scenario: Standing authorization covers the profile
- **WHEN** a profile has standing authorization and a Workable role qualifies on fit
- **THEN** the standing authorization does not apply, and any application needs exact final approval

#### Scenario: A person requests a Workable role manually
- **WHEN** an agent requests an application for a discovered Workable role
- **THEN** the request is admitted under the existing manual flow, with exact final approval

### Requirement: Workable roles are revalidated before admission
Before an application for a Workable role is admitted, the server SHALL re-read the role from Workable using its account and shortcode. The application SHALL be admitted only when the role is still published, the shortcode matches and the title is unchanged. A closed or mismatched role SHALL be rejected with `role_closed_or_changed`. An unreadable or timed-out response SHALL be rejected as retryable, and SHALL NOT be treated as success. This is a Workable-specific admission gate: the existing freshness refresh for Ashby, Greenhouse and Lever stays unchanged.

#### Scenario: The role has closed
- **WHEN** a Workable role's live record returns HTTP 404 when an application is requested
- **THEN** the request is rejected with `role_closed_or_changed`, and no application or worker job is created

#### Scenario: Workable times out
- **WHEN** the live lookup does not respond within its timeout
- **THEN** the request is rejected as retryable, and no application is created

#### Scenario: The role is still open
- **WHEN** the live record is published with the same shortcode and title
- **THEN** the application is admitted under the manual flow
