## ADDED Requirements

### Requirement: Discovery maintains a bounded reserve of new suitable roles
The discovery service SHALL maintain a durable, freshness-limited reserve of qualifying, unapplied official employer postings across configured sources. It SHALL preserve source provenance, verified employer application destination, ATS role key when available, observed time, eligibility evidence, and reason codes for rejected candidates. A campaign SHALL recheck role availability before preparation.

#### Scenario: A source returns an aggregator listing without employer destination
- **WHEN** the listing cannot be resolved to a verified HTTPS employer application URL
- **THEN** it is excluded from the ready reserve and recorded as a missing-destination diagnostic

#### Scenario: A role is in the reserve but later closes
- **WHEN** its official listing or application page indicates closure at the pre-application recheck
- **THEN** it is removed from the ready queue without a submission attempt and a fresh candidate may replace it

### Requirement: Handled roles are filtered before expensive work
Discovery SHALL compare stable ATS role IDs, normalized listing and application URLs, and verified receipt URLs across sources before scoring, drafting, or browser preparation. It SHALL reserve selected role keys transactionally to prevent duplicate queue entries, while leaving genuinely unattempted roles searchable.

#### Scenario: Two sources list the same role through different URLs
- **WHEN** both URLs resolve to the same stable ATS role identity or prior verified receipt destination
- **THEN** only one candidate can enter the active queue and neither can trigger a duplicate final action

### Requirement: Source health distinguishes supply shortages from access failures
Each source SHALL report pages and detail requests, accepted candidates, handled candidates, hard exclusions, missing destinations, parse failures, rate limits, and access challenges. Browser sources SHALL obey per-origin budgets, pagination limits, backoff, and stop conditions rather than circumventing source controls.

#### Scenario: A full configured scan yields no candidates
- **WHEN** every planned source is exhausted or stopped within its budget and no role passes quality and destination gates
- **THEN** the campaign reports an insufficient-candidates outcome with source coverage and reason counts, not an application-speed result

#### Scenario: A source returns 429
- **WHEN** the source signals a rate limit
- **THEN** its adapter backs off or stops, records the restriction, and allows independent sources to continue within their own budgets
