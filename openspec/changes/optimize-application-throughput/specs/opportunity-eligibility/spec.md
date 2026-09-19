## ADDED Requirements

### Requirement: Semantic work is decision-directed
The system SHALL apply deterministic hard gates before semantic work and SHALL invoke semantic extraction or reranking only when unresolved evidence can affect a configured eligibility decision, threshold decision, or consumed shortlist.

#### Scenario: Candidate is already hard-excluded
- **WHEN** deterministic evidence proves that an opportunity violates a location, authorization, employment, compensation, or explicit-exclusion rule
- **THEN** the opportunity is excluded without semantic extraction or embedding

#### Scenario: Missing evidence can change admission
- **WHEN** a candidate is otherwise near the configured threshold and an unresolved supported field could change its decision
- **THEN** semantic enrichment may run and its bounded contribution remains separately explained

### Requirement: Semantic artifacts are versioned and reusable
The system SHALL persist validated public-job extractions and job embeddings by normalized content and provider/schema version, SHALL persist profile skill embeddings by profile-scoped skill-summary hash and model version, and SHALL compute similarity without repeatedly embedding unchanged profile text.

#### Scenario: A repeated scan observes unchanged content
- **WHEN** the same normalized public job and unchanged profile skill summary are scanned after restart
- **THEN** valid cached artifacts are reused without new provider calls and the resulting score explanation remains equivalent

#### Scenario: Provider or schema version changes
- **WHEN** an extraction schema or model version differs from the cached record
- **THEN** the stale artifact is not used as current evidence

### Requirement: Semantic provider requests are batched safely
The system SHALL batch compatible embedding inputs within configured size and concurrency limits, SHALL coalesce identical in-flight work, and SHALL isolate partial provider failures without weakening deterministic fallback behavior.

#### Scenario: One item in a batch fails validation
- **WHEN** a provider batch contains one invalid result and valid results for other jobs
- **THEN** the invalid item falls back deterministically while independently valid items remain usable
