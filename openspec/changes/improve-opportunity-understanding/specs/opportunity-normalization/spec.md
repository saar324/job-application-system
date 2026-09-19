## Purpose

Creates a provider-neutral, evidence-linked representation of job opportunities from public structured sources, page metadata, deterministic parsing, and optional bounded semantic enrichment.

## ADDED Requirements

### Requirement: Opportunities use a canonical evidence-linked schema
The system SHALL normalize discovered jobs into a canonical schema and SHALL associate each material field with its source, observation time, extraction version, confidence class, and bounded evidence reference.

#### Scenario: Provider and page disagree about location
- **WHEN** a provider API and page metadata report different location restrictions
- **THEN** the canonical record retains both evidence items, selects according to documented field precedence, and marks a material unresolved conflict

### Requirement: Structured public data is preferred
The discovery pipeline SHALL prefer public provider data and valid Schema.org `JobPosting` metadata over free-text inference, and SHALL fall back without discarding higher-confidence values when structured data is incomplete.

#### Scenario: Page provides valid JobPosting JSON-LD
- **WHEN** a job page includes a valid employment type, location restriction, and compensation range in `JobPosting` metadata
- **THEN** those normalized values and their JSON-LD provenance are available to eligibility evaluation before page-text inference

#### Scenario: Structured metadata is malformed
- **WHEN** JSON-LD cannot be parsed or violates supported field types
- **THEN** the source failure is recorded and deterministic page parsing continues

### Requirement: Public ATS question metadata is normalized
When a supported public ATS endpoint exposes application-question metadata, the discovery adapter SHALL normalize field labels, types, required status, and bounded options without attempting submission or requiring employer credentials.

#### Scenario: Greenhouse job exposes required questions
- **WHEN** the public job detail response includes application questions
- **THEN** the opportunity records their normalized metadata for readiness analysis while leaving answers unset

### Requirement: Semantic enrichment is bounded and optional
Model extraction and embeddings SHALL operate only through configured versioned providers with schema validation, budgets, timeouts, and deterministic fallback, and SHALL NOT receive credentials, application answers, or document contents.

#### Scenario: Extraction provider times out
- **WHEN** structured model extraction exceeds its configured bound
- **THEN** the opportunity remains usable with deterministic fields and records the enrichment failure without blocking discovery

### Requirement: Source failures remain visible
The system SHALL report provider, board, job-detail, structured-data, and enrichment failures as partial outcomes rather than silently treating failed inputs as empty results.

#### Scenario: One board fails during a multi-board scan
- **WHEN** one configured board returns an error and another returns jobs
- **THEN** the scan persists the successful jobs and exposes the failed board and reason in scan health
