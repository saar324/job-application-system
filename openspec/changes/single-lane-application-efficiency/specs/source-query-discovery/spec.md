## ADDED Requirements

### Requirement: Source search capabilities are discoverable and bounded
Each enabled source SHALL expose a versioned descriptor of supported filters, values, whether filters run at the provider or locally, pagination, access method, and operational limits. An agent SHALL submit a typed search plan using only supported options and configured employer boards. The server SHALL reject arbitrary selectors, scripts, origins, unconfigured boards, or unsupported filters.

#### Scenario: Several queries use the same board-wide feed
- **WHEN** a bounded search plan asks for multiple locally filtered queries against one Ashby or Greenhouse board
- **THEN** the service fetches the board once for that scan cycle and applies each validated filter locally

#### Scenario: An agent requests available searches
- **WHEN** it asks for source capabilities for its authenticated profile and mode
- **THEN** it receives only enabled sources and their allowed query schemas

#### Scenario: A site removes a filter
- **WHEN** an adapter's validation fixture detects a changed or unavailable option
- **THEN** the affected query fails with a source-specific diagnostic and the adapter is disabled or downgraded until repaired

### Requirement: Search results retain source evidence and policy gates
The service SHALL normalize, deduplicate, screen, and score results with source URL, query version, observed time, and field provenance. Official listing feeds SHALL be preferred when available; a live application form SHALL be rechecked before application.

#### Scenario: A published Ashby role is unlisted
- **WHEN** the public board feed marks a role `isListed: false`
- **THEN** autonomous discovery excludes it while an owner-supplied direct link remains eligible for ordinary policy review

#### Scenario: A cached listing remains after the employer closes the role
- **WHEN** a shortlisted role is no longer present on the employer's official feed or live page
- **THEN** it is not queued for application

### Requirement: Source access responds conservatively to blocks
Browser-based and feed adapters SHALL honor configured rate limits, backoff on 429 or challenge responses, and stop on access restrictions without challenge evasion. LinkedIn SHALL remain user-controlled until the owner explicitly changes that rule.

#### Scenario: A source presents a bot challenge
- **WHEN** a search adapter encounters the challenge
- **THEN** it records a bounded failure, backs off that source, and continues independent sources without trying to bypass the challenge
