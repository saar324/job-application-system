## Context

The current scorer can match short skills inside unrelated words and must infer eligibility from provider-specific text. Many job pages already expose structured provider APIs or Schema.org `JobPosting` JSON-LD, while model-based structured extraction and embeddings can help only after higher-confidence sources are exhausted.

This change should follow `strengthen-application-foundations` so normalized records, extraction versions, and evaluation telemetry have transactional storage. It does not require adaptive browser execution.

## Goals / Non-Goals

**Goals:**

- Produce one canonical, evidence-linked representation regardless of discovery source.
- Eliminate substring false positives and make every eligibility and ranking decision explainable.
- Use semantic techniques to improve recall without weakening location, authorization, employment-type, compensation, or explicit exclusion gates.
- Fetch known ATS application-question metadata early enough to improve readiness and reduce browser surprises.
- Measure extraction and ranking quality against a stable offline corpus.

**Non-Goals:**

- Letting a model make final legal, authorization, or applicant-fact decisions.
- Sending resumes, credentials, or applicant answers to an enrichment model.
- Fine-tuning a model in this phase.
- Automatically submitting through employer-only ATS APIs.

## Decisions

### Use a source-precedence normalization pipeline

Each field is resolved from the highest-confidence available source: provider API, valid `JobPosting` JSON-LD, deterministic page parsing, then optional model extraction. Conflicts remain visible as evidence instead of silently overwriting values. Every value carries source, observed timestamp, extraction/schema version, confidence class, and a bounded evidence reference.

### Keep the canonical schema provider-neutral

The schema covers title, organization, canonical URL, locations and restrictions, remote policy, employment type, compensation ranges, work-authorization statements, seniority, required and preferred skills, responsibilities, application questions, and source evidence. Provider-specific payloads remain in adapters and are not exposed as scoring inputs directly.

### Match skills by canonical identity

Skills use normalized tokens, phrases, and curated aliases with boundary-aware matching. Short or ambiguous skills such as `AI`, `Go`, `R`, and `C` require exact token or explicit alias evidence. Negative and contextual phrases are retained so mentions such as “no Go experience required” are not counted as requirements.

### Apply deterministic gates before semantic scoring

The pipeline first evaluates known hard constraints. It then computes exact and alias skill features, followed by optional embedding similarity and structured model features. Semantic signals can reorder eligible opportunities but cannot erase a hard exclusion. Unknown high-impact facts produce uncertainty or confirmation rather than an invented answer.

### Isolate model enrichment behind versioned interfaces

Structured extraction must validate against the canonical schema and cite bounded text spans. Embeddings are cached by normalized public job text and model version. Both have time, token, cost, and concurrency budgets, and both fall back to deterministic results on failure. The service stores no hidden chain-of-thought.

### Evaluate before changing thresholds

An anonymized fixture corpus records expected normalized fields, hard exclusions, relevant skills, and pairwise ranking preferences. CI runs deterministic extraction and scorer regressions; model-backed evaluations run separately with pinned model and schema versions and publish quality, latency, failure, and cost summaries.

## Risks / Trade-offs

- **[Structured sources disagree]** → Preserve provenance and use explicit precedence per field; mark material conflicts uncertain.
- **[Embeddings improve similarity but reduce explainability]** → Expose semantic contribution separately and keep evidence-based deterministic features dominant.
- **[Model output changes over time]** → Pin model/schema versions, cache outputs, validate schemas, and gate releases on evaluation deltas.
- **[Provider APIs expose fields unavailable to applicants]** → Use public job-board endpoints only; never depend on employer credentials.
- **[Long descriptions increase cost]** → Normalize and truncate public text by labeled sections, enrich only candidates passing basic gates, and enforce budgets.

## Migration Plan

1. Add the canonical schema and evidence model without changing existing score behavior.
2. Implement provider and JSON-LD normalization, compare results in shadow mode, and repair fixture discrepancies.
3. Enable boundary-aware skill matching and rerun the evaluation corpus before updating production thresholds.
4. Add structured extraction behind a disabled feature flag and enable it only for unresolved fields on top candidates.
5. Add embedding similarity as a separately weighted, observable feature.
6. Version all production scores and retain the prior scorer for rollback during the acceptance window.
