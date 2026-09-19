## Why

Opportunity scoring currently depends heavily on unstructured text and substring matches, which can produce false skill signals and weak explanations. The system should prefer structured job metadata, preserve evidence, and use semantic models only where deterministic normalization cannot answer the question.

## What Changes

- Introduce a canonical opportunity schema with field-level provenance, confidence, and extraction versioning.
- Prefer provider APIs and Schema.org `JobPosting` JSON-LD before deterministic DOM parsing or model extraction.
- Normalize job requirements, locations, employment types, compensation, work authorization, seniority, skills, and application-question metadata.
- Replace substring skill matching with boundary-aware canonical skills and aliases.
- Add optional structured model extraction and embedding similarity behind provider-neutral interfaces and feature flags.
- Ensure deterministic hard eligibility gates always take precedence over semantic ranking.
- Add an anonymized, versioned ranking and extraction evaluation corpus.

## Capabilities

### New Capabilities

- `opportunity-normalization`: Defines canonical, evidence-linked extraction from structured feeds, page metadata, ATS APIs, and bounded model enrichment.

### Modified Capabilities

- `opportunity-eligibility`: Adds token-aware skill interpretation, hybrid ranking, uncertainty handling, and versioned scoring explanations.

## Impact

- Discovery: source adapters, JSON-LD parsing, ATS detail fetches, and partial-failure reporting.
- Domain model: normalized opportunity fields, provenance records, extraction versions, and application-question metadata.
- Scoring: skill taxonomy, deterministic gates, embedding features, model-assisted extraction, and explanations.
- Persistence: enrichment cache and model/schema version metadata.
- Operations: model credentials, configurable budgets, timeouts, and feature flags.
- Tests: adversarial skill strings, structured-data fixtures, multilingual descriptions, and offline ranking evaluation.
