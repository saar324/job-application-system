## ADDED Requirements

### Requirement: Adzuna credentials come only from the deployment environment
The `adzuna` source SHALL read `ADZUNA_APP_ID` and `ADZUNA_APP_KEY` only from the server process environment. It SHALL NOT accept credentials from config JSON, profiles, MCP or HTTP request content, or agent-supplied filters. The credentials SHALL NOT appear in source descriptors, scan results, error messages, audit events, telemetry labels or logs.

#### Scenario: Credentials are missing
- **WHEN** a scan includes `adzuna` and either variable is unset or empty
- **THEN** the source reports a `source_not_configured` error without making a network request, and the other selected sources complete normally

#### Scenario: A provider error echoes the request URL
- **WHEN** an Adzuna request fails and the underlying error or response includes the query string
- **THEN** the recorded error replaces the `app_id` and `app_key` values with a redaction marker

#### Scenario: An agent tries to supply credentials
- **WHEN** a discovery query plan for `adzuna` includes `app_id`, `app_key` or any unlisted filter
- **THEN** the request is rejected as an unsupported filter

### Requirement: Adzuna searches are bounded to configured countries and supported filters
The `adzuna` source SHALL search only country codes listed in private `discovery.sourceOptions.adzuna.countries` that are also on the supported list (`at`, `au`, `be`, `br`, `ca`, `ch`, `de`, `es`, `fr`, `gb`, `in`, `it`, `mx`, `nl`, `nz`, `pl`, `sg`, `us`, `za`). The descriptor SHALL expose only the documented provider filters, and each query SHALL request at most 50 results per page.

#### Scenario: An unconfigured country is requested
- **WHEN** a query plan asks for `country: "us"` and `us` is not in the configured countries
- **THEN** the query is rejected before any network request

#### Scenario: No search terms are available
- **WHEN** neither the query plan nor the profile's preferred titles provide a `what` term
- **THEN** the source returns no results without calling Adzuna

### Requirement: Adzuna quota is enforced durably across restarts
The server SHALL keep a deployment-wide Adzuna request ledger that survives restarts. By default it SHALL refuse requests beyond 25 per minute, 250 per UTC day, 1,000 per week and 2,500 per month, and operators SHALL be able to lower these limits in private config. HTTP 429 responses SHALL put the source into the existing rate-limited cooldown.

#### Scenario: The daily allowance is used up
- **WHEN** 250 Adzuna requests have been recorded in the current UTC day
- **THEN** further Adzuna searches that day return a `quota_exhausted` diagnostic with the reset time, and no request is sent

#### Scenario: The server restarts mid-day
- **WHEN** the server restarts after using 200 requests that day
- **THEN** only 50 more requests are permitted before the daily reset

### Requirement: Adzuna results keep their evidence and limits
Each Adzuna result SHALL be normalized with source `adzuna` and a stable external ID of `{country}:{id}`. It SHALL carry the title, company, location, `redirect_url` as both the listing URL and the pending application URL, contract type and time, category, posting time, and the country searched. The description SHALL be marked as a snippet. A salary that has `salary_is_predicted` set SHALL be recorded as an estimate and SHALL NOT satisfy or violate a compensation floor.

#### Scenario: Salary is predicted
- **WHEN** a result has `salary_min: 60000` and `salary_is_predicted: "1"`
- **THEN** the opportunity records the estimate in its evidence, and compensation eligibility treats the pay as unknown

#### Scenario: A description is truncated
- **WHEN** a normalized Adzuna opportunity is scored
- **THEN** its uncertainties include `description_snippet_only`, and a skill missing from the snippet does not count as a verified mismatch

### Requirement: Adzuna application destinations are resolved before preparation
Adzuna results SHALL be marked `applicationDestinationPending` with the uncertainty `employer_application_url_unverified`. No application SHALL be prepared or queued from an Adzuna result until an employer or ATS destination has been resolved and verified through the existing destination or official-ATS verification paths.

#### Scenario: A pending Adzuna role reaches auto-apply
- **WHEN** a qualifying Adzuna opportunity still has an unresolved destination
- **THEN** it is counted as `destinationPending` and no application is created
