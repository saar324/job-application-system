## ADDED Requirements

### Requirement: The JobsPipe key comes only from the deployment environment
The `jobspipe` source SHALL read its key only from `JOBSPIPE_API_KEY`. It SHALL send the key only as a Bearer token to `https://api.jobspipe.dev`, and SHALL NOT include it in descriptors, errors, audit events, telemetry or logs.

#### Scenario: The key is missing
- **WHEN** a scan includes `jobspipe` and `JOBSPIPE_API_KEY` is unset
- **THEN** the source reports `source_not_configured` and makes no request

#### Scenario: The key is rejected
- **WHEN** JobsPipe responds with HTTP 401
- **THEN** the diagnostic reports that the key was rejected, contains no key material, and pauses the source until configuration changes

### Requirement: JobsPipe credit use is bounded per calendar month
The server SHALL record `metadata.credits_charged` from every JobsPipe response in a durable ledger for each UTC calendar month. It SHALL NOT send a search whose `limit` could push the month's credits over the configured allowance (1,000 by default). HTTP 402 SHALL mark the source quota-exhausted until the next month begins. HTTP 429 SHALL apply the rate-limited cooldown. Every request SHALL keep to the plan's per-second rate (2 by default).

#### Scenario: The allowance is nearly used
- **WHEN** 990 credits have been recorded this month and a query asks for `limit: 25`
- **THEN** the source lowers `limit` to 10 or reports `quota_exhausted`, and never goes over the allowance

#### Scenario: Jobs already paid for are free
- **WHEN** a response reports `credits_charged: 3` for 25 returned jobs
- **THEN** the ledger adds 3, not 25

### Requirement: JobsPipe searches use only allowlisted filters and return active roles only
The descriptor SHALL list only the allowlisted JobsPipe filters. The adapter SHALL always send `status: "active"` and SHALL follow `next_cursor` for at most the configured number of pages. Unless the owner explicitly removes the default in private config, it SHALL exclude LinkedIn-origin postings through `source_not`.

#### Scenario: An agent requests an unlisted filter
- **WHEN** a query plan includes `has_recruiter_email: true`
- **THEN** the query is rejected before any request

#### Scenario: Default LinkedIn exclusion
- **WHEN** a JobsPipe search is sent with no private override
- **THEN** its body includes `source_not` containing `linkedin`

### Requirement: JobsPipe results keep verification evidence and drop contact data
Each JobsPipe result SHALL be normalized with source `jobspipe` and its stable `id` as the external ID, and SHALL keep its origin sources. It SHALL carry the title, company, location, country codes, remote or work arrangement, full description, employment types, seniority, date posted, `verified_at`, `last_seen_at`, `expires_at`, `ghost_score` and `visa_sponsorship` as evidence. Salary SHALL be stated pay in the original currency; corpus-estimated salary fields SHALL NOT be used as stated compensation. `recruiter_emails` and any applicant-count fields SHALL be dropped before storage.

#### Scenario: Only an estimated salary is present
- **WHEN** a result has only `estimated_median_annual_salary_usd`
- **THEN** compensation is treated as unknown for eligibility

#### Scenario: A result carries recruiter emails
- **WHEN** a response includes `recruiter_emails`
- **THEN** the stored opportunity and its audit record contain no email addresses

### Requirement: JobsPipe destinations are verified before preparation
When a JobsPipe result's apply or posting URL matches a supported official ATS, the opportunity SHALL go through the existing official-ATS verification before an application is prepared. Otherwise it SHALL be marked `applicationDestinationPending`. A result whose `status` is not `active`, or whose `expires_at` has passed, SHALL NOT be queued.

#### Scenario: A Greenhouse posting via JobsPipe
- **WHEN** a result's URL is a Greenhouse job URL
- **THEN** the service verifies it against the official Greenhouse feed before any application is created

#### Scenario: A posting has expired
- **WHEN** `expires_at` is in the past at preparation time
- **THEN** no application is created and the reason is recorded
