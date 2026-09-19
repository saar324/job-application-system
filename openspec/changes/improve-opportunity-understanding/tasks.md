## 1. Canonical Opportunity Model

- [x] 1.1 Define and persist the canonical opportunity schema, field-level provenance, confidence classes, evidence references, observed timestamps, and extraction/schema versions
- [x] 1.2 Add deterministic normalization for URLs, locations, remote restrictions, employment types, compensation, currencies, seniority, work-authorization statements, and required/preferred skills
- [x] 1.3 Add conflict resolution and uncertainty rules; verify lower-confidence sources cannot silently overwrite higher-confidence evidence

## 2. Structured Discovery Sources

- [x] 2.1 Parse and validate Schema.org `JobPosting` JSON-LD, including graph and multiple-script cases; add fixtures for malformed, stale, conflicting, and partial markup
- [x] 2.2 Extend public Greenhouse, Lever, and Ashby adapters to fetch job-detail and available application-question metadata without using employer credentials
- [x] 2.3 Record per-board and per-job source failures as partial scan outcomes instead of swallowing them; verify healthy sources continue
- [x] 2.4 Add source-precedence integration tests comparing provider API, JSON-LD, deterministic DOM, and cached enrichment results

## 3. Deterministic Eligibility and Ranking

- [x] 3.1 Implement a canonical skill taxonomy with boundary-aware phrase matching and curated aliases; add regressions for ambiguous skills including AI, Go, R, C, .NET, and Node.js
- [x] 3.2 Separate hard eligibility gates from ranking features and guarantee semantic signals cannot override location, authorization, employment-type, compensation, or explicit exclusions
- [x] 3.3 Produce a versioned score explanation containing deterministic components, semantic contribution, uncertainty markers, and bounded supporting evidence
- [x] 3.4 Update direct and discovered opportunity flows to use the same normalized eligibility evaluation while preserving explicit direct-user intent

## 4. Optional Semantic Enrichment

- [x] 4.1 Define provider-neutral structured-extraction and embedding interfaces with feature flags, budgets, timeouts, retries, and deterministic fallback behavior
- [x] 4.2 Implement schema-validated extraction for unresolved public job fields with evidence spans; verify invalid or unsupported output is discarded safely
- [x] 4.3 Implement versioned embedding generation and caching for normalized public job text and profile skill summaries without including credentials, documents, or applicant answers
- [x] 4.4 Add top-candidate-only semantic reranking and measure its contribution separately from deterministic scores

## 5. Evaluation and Rollout

- [x] 5.1 Create an anonymized evaluation corpus with expected normalized fields, exclusions, skill relevance, and pairwise ranking judgments
- [x] 5.2 Add deterministic regression checks to CI and a separate pinned-model evaluation reporting accuracy, ranking quality, latency, failures, and estimated cost
- [ ] 5.3 Run shadow comparisons against the existing scorer, review changed auto-apply decisions, and define acceptance thresholds before enabling new weights
- [ ] 5.4 Roll out by profile and mode with scorer-version rollback, then run syntax, unit, integration, privacy, dependency-audit, and OpenSpec strict validation checks
