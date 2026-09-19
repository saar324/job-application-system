## Context

Known forms already use deterministic Playwright behavior and therefore consume no application-time model tokens. Adaptive execution is a fallback for unsupported forms, so optimizing it alone cannot deliver the largest system-wide saving. The current semantic path is broader: a scan can enrich up to twenty candidates, each enrichment can perform extraction plus embedding, profile text is embedded repeatedly, candidates are processed sequentially, and cache entries exist only in process memory. The scheduler also maintains one promise chain per profile, which means a single active applicant cannot use spare global browser capacity.

This change optimizes the complete funnel: spend model work only where it can change a decision, reuse public-job computation, use isolated browser capacity concurrently, and reduce adaptive round trips. Existing quality and safety rules are invariants rather than tunable performance trade-offs.

## Goals / Non-Goals

**Goals:**

- Reduce semantic provider input, calls, and scan latency while preserving deterministic eligibility decisions and score explanations.
- Increase verified applications completed per hour for one active profile without duplicate execution or unsafe site pressure.
- Reduce adaptive calls and repeated observation content without permitting stale or unvalidated actions.
- Convert repeat unsupported forms into deterministic execution when a strict structural match proves reuse is safe.
- Remove unnecessary fixed waits while retaining bounded handling for slow client-side transitions.
- Prove gains with privacy-safe before/after metrics and non-regression gates.

**Non-Goals:**

- Relaxing location, authorization, employment, compensation, exclusion, approval, or receipt requirements.
- Increasing daily application caps or bypassing employer rate limits and human challenges.
- Reusing browser state, recipes, or cache records across profile or origin boundaries when they contain private state.
- Caching applicant answers, credentials, documents, raw submitted forms, or receipt screenshots in optimization stores.
- Replacing deterministic adapters with model control.

## Decisions

### Enrich only when enrichment can affect an outcome

The deterministic scorer remains first. Hard-excluded candidates receive no semantic work. Extraction runs only when a missing or uncertain field can affect a configured hard gate, score threshold, or bounded shortlist. Semantic reranking runs only for candidates whose ordering is consumed by an actual selection limit or whose score lies within a configured decision band. The system records why each candidate was enriched or skipped and supports shadow comparison against the current enrichment policy.

### Persist public-job artifacts and split embeddings

Structured extraction is keyed by normalized public-job text hash, extraction schema version, and provider model version. Job embeddings use the public-job hash and embedding version. Profile embeddings use only a normalized skill-summary hash, profile scope, and embedding version. Similarity is computed locally from independently cached vectors. New job embeddings are submitted in bounded batches; identical concurrent requests share one in-flight computation. Invalid, expired, or version-mismatched records are ignored rather than silently reused.

The cache stores public job text derivatives and profile skill vectors separately. It never stores credentials, documents, applicant answers, contact fields, or unrestricted application-form content.

### Use hierarchical concurrency controls

Scheduling uses configurable global, per-profile, and per-origin limits. A profile may run more than one application when capacity permits, but an application retains one exclusive transactional claim. Per-origin limits and adaptive backoff prevent a throughput setting from flooding one ATS or employer. Fair queue selection prevents a busy profile from starving another. The execution boundary and uncertain-submission recovery rules remain unchanged.

The initial production default remains one execution per profile. Higher values progress through simulation and selected-profile rollout after exactly-once, fairness, challenge-rate, and receipt tests pass.

### Send compact page state and validate action batches locally

An adaptive attempt sends one redacted structural snapshot with stable attempt-local control IDs. Later calls send the current page generation plus added, removed, or changed controls and bounded new public text. The provider may propose an ordered batch of fill, select, upload, scroll, or safe workflow-click actions.

The worker validates every action immediately before execution against the current page generation, origin, authoritative value key, target semantics, budgets, and approval state. A batch stops and re-observes after navigation, popup, significant DOM replacement, missing target, validation failure, authentication challenge, owner-input requirement, or budget boundary. A final submission action is always isolated from other actions and continues to require the durable preview approval policy and newly observed receipt evidence.

### Promote only proven traces to deterministic recipes

A recipe contains origin constraints, a structural form fingerprint, schema and policy versions, field-key mappings, transition assertions, and safe action templates. It contains no applicant values, credentials, cookies, tokens, document paths, page text, or receipt content. Only a completed, policy-compliant trace with a verified receipt is eligible to generate a candidate recipe.

Replay requires an exact compatible origin and fingerprint. Each action is still validated by the worker. Any mismatch invalidates replay for that attempt and returns to the ordinary deterministic then adaptive fallback order. Recipe success, mismatch, fallback, and rollback are observable.

### Prefer events over sleeps

Navigation, popup creation, URL changes, target attachment, form-generation changes, and submission evidence are awaited directly. A short configurable fallback delay remains for sites that expose no reliable event. All waits share the existing attempt deadline and cannot extend the submission-evidence standard.

### Gate rollout on quality and efficiency together

The benchmark records semantic calls and input size per scan, adaptive calls and tokens per attempt, cache and recipe hit rates, queue and browser duration, manual-review reasons, policy denials, verified submission rate, and duplicate-execution count. Rollout requires identical hard-exclusion results, no new policy violations or duplicate submissions, no false submitted states, and no regression in fixture correctness. Efficiency targets are established from the recorded baseline rather than invented before measurement.

## Risks / Trade-offs

- **[Decision-directed enrichment misses a useful signal]** → Run the new selector in shadow mode, record changed eligibility and ordering, and retain an override for bounded evaluation samples.
- **[Persistent cache serves stale output]** → Key every artifact by normalized content and provider/schema version, enforce expiry, and ignore invalid entries.
- **[Concurrency increases challenges or rate limits]** → Enforce per-origin limits, jittered backoff, challenge-rate monitoring, and immediate profile rollback to concurrency one.
- **[A batched action becomes stale]** → Bind plans to a page generation, validate immediately before every action, and stop at every transition boundary.
- **[A recipe matches a changed form incorrectly]** → Require structural fingerprints and transition assertions, retain local validation, and fall back on the first mismatch.
- **[Event-driven waits miss silent UI changes]** → Use DOM-generation observation plus a bounded fallback delay under the existing attempt deadline.

## Migration Plan

1. Add efficiency telemetry and capture a deterministic baseline without changing behavior.
2. Add durable enrichment caches and split/batched embeddings behind a feature flag; compare results in shadow mode.
3. Enable decision-directed enrichment for selected profiles while retaining the former policy as rollback.
4. Implement hierarchical scheduler limits, test with simulation, then enable profile concurrency two for selected profiles and conservative origins.
5. Introduce the adaptive delta and batch protocol in preview-only mode, then allow approved submissions after corpus acceptance.
6. Record recipe candidates without replay, review fingerprints and privacy output, then enable deterministic replay for allowlisted domains.
7. Replace fixed waits incrementally and compare transition failures and browser duration per adapter.
8. Promote defaults only after acceptance windows pass; retain flags for immediate rollback of every optimization independently.
