## ADDED Requirements

### Requirement: Throughput counts the complete verified funnel
The system SHALL report wall-clock and active time from fresh candidate acquisition through new verified employer receipts, including duplicate checks, eligibility, preparation, model/tool calls, owner holds, failed attempts, recovery, and receipt verification. It SHALL separately report preloaded-queue latency and attributable rolling-reserve maintenance. Missing historical measurements SHALL be shown as unknown.

#### Scenario: A batch contains previously submitted roles
- **WHEN** ten selected roles yield seven new receipts and three known duplicates
- **THEN** the report counts seven new submissions, includes work spent discovering the duplicates, and does not present the ten selected roles as ten new applications

#### Scenario: The reserve was built before the measured run
- **WHEN** a campaign draws from a maintained candidate reserve
- **THEN** the report includes attributable reserve acquisition and upkeep in its steady-state throughput or explicitly labels the measurement as preloaded-queue latency

### Requirement: The one-hour target has staged quality-preserving gates
The service SHALL treat 100 new suitable verified receipts in 60 minutes as an unproven target until a complete live campaign meets it within configured caps and source limits, with fresh candidate acquisition and attributable reserve upkeep inside the measured window. A preloaded-queue test SHALL NOT establish the end-to-end target. It SHALL gate rollout through fixture correctness, fully audited staging shadow decisions, a small opted-in live cohort with an answer/fit audit, 10 receipts in six minutes, and 25 in fifteen minutes. A speed gain SHALL NOT compensate for unsupported claims, unconfirmed legal answers, duplicate final actions, false receipts, or privacy violations.

#### Scenario: Fewer than 100 eligible roles are available
- **WHEN** a full campaign cannot assemble 100 suitable, unapplied, reachable postings
- **THEN** it reports a supply shortage and partial verified outcomes, without declaring the hour target passed or lowering eligibility rules

#### Scenario: The fast path produces a false submitted state
- **WHEN** a faster path records submitted without valid employer evidence
- **THEN** rollout fails and the affected automatic path is disabled pending correction

#### Scenario: One origin's challenge rate rises
- **WHEN** a source or browser path shows a material challenge-rate regression
- **THEN** automatic processing for that origin can be disabled without stopping healthy origins or weakening employer access controls
