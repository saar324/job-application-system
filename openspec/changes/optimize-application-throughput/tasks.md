> **Owner direction, 2026-09-21:** Do not implement section 3's same-profile concurrency unless the owner later changes the one-agent-at-a-time preference. Follow [`single-lane-application-efficiency`](../single-lane-application-efficiency/tasks.md) for the current work order.

## 1. Baseline and Quality Gates

- [ ] 1.1 Add privacy-safe metrics for semantic calls and input size, adaptive calls and tokens, cache and recipe hits, queue duration, browser duration, verified submissions, manual-review reasons, challenges, and duplicate execution
- [ ] 1.2 Extend the evaluation corpus with repeated scans, restart cache reuse, threshold-adjacent opportunities, multi-page custom forms, stale plans, changed form fingerprints, and concurrent applications
- [ ] 1.3 Capture a versioned baseline report and define measured acceptance targets while requiring identical hard exclusions, zero false submitted states, zero duplicate worker execution, and zero policy violations
- [ ] 1.4 Add per-optimization feature flags, selected-profile rollout controls, health indicators, and independent rollback procedures

## 2. Decision-Directed Semantic Enrichment

- [ ] 2.1 Classify candidates as hard-excluded, decision-complete, threshold-adjacent, unresolved-high-impact, or shortlist-relevant and record a bounded explanation for enriching or skipping each candidate
- [ ] 2.2 Add a normalized SQLite cache for extraction results, job embeddings, and profile skill embeddings keyed by content, profile scope where applicable, schema version, model version, and expiry
- [ ] 2.3 Split job and profile embedding generation, compute similarity locally, and add bounded batch embedding with in-flight request coalescing
- [ ] 2.4 Run enrichment only when unresolved evidence can change a gate, configured score decision, or consumed shortlist; verify deterministic hard exclusions always run first
- [ ] 2.5 Add restart, multi-profile reuse, version invalidation, malformed-cache, provider-failure, batch-partial-failure, and shadow-decision regression tests

## 3. Hierarchical Application Concurrency

- [ ] 3.1 Replace the single promise chain per profile with a fair queue enforcing configurable global, per-profile, and per-origin execution limits
- [ ] 3.2 Preserve transactional application claims, daily caps, one worker call per attempt, and the pre/post-execution recovery boundary under concurrent delivery
- [ ] 3.3 Add per-origin challenge and rate-limit backoff with bounded jitter, safe reason codes, and automatic reduction to one active execution where configured
- [ ] 3.4 Add stress and restart tests for one busy profile, multiple profiles, shared ATS origins, confirmation pauses, worker timeouts, and process races
- [ ] 3.5 Roll out concurrency two in simulation and selected profiles; compare throughput, challenge rate, manual review, receipt correctness, and fairness before raising defaults

## 4. Compact Adaptive Planning

- [ ] 4.1 Define a versioned observation protocol with one redacted structural snapshot, attempt-local control IDs, page generations, and bounded subsequent deltas
- [ ] 4.2 Extend the provider-neutral adaptive contract to return bounded ordered action batches with usage accounting and stop conditions
- [ ] 4.3 Validate every action against current generation, origin, target semantics, authoritative value sources, budgets, and approval state immediately before execution
- [ ] 4.4 Stop and re-observe after navigation, popup, meaningful DOM replacement, challenge, missing target, policy denial, or owner-input boundary; isolate final submission in its own approved action
- [ ] 4.5 Add regressions for stale control IDs, reordered controls, partial batch success, prompt injection, changed previews, credentials, unknown answers, navigation, and submission evidence

## 5. Deterministic Form Recipes

- [ ] 5.1 Define a privacy-safe recipe schema containing origin policy, structural fingerprint, versions, field-key mappings, action templates, and transition assertions but no applicant values or private browser state
- [ ] 5.2 Generate recipe candidates only from policy-compliant attempts ending in verified receipts and add an operator review or allowlist state before replay
- [ ] 5.3 Replay recipes through the ordinary worker policy engine, invalidate on the first structural or transition mismatch, and fall back to deterministic then adaptive execution
- [ ] 5.4 Add cache poisoning, cross-profile, cross-origin, stale-version, changed-form, missing-control, and rollback tests plus recipe hit and fallback telemetry

## 6. Event-Driven Browser Transitions

- [ ] 6.1 Replace fixed post-click sleeps with bounded waits for URL, popup, load-state, control attachment, form-generation, or relevant DOM changes
- [ ] 6.2 Retain a short configurable fallback for silent client-side transitions and ensure all waits consume the existing attempt deadline
- [ ] 6.3 Preserve newly observed submission evidence and receipt capture as separate post-submit requirements independent of transition speed
- [ ] 6.4 Add fixtures for instant, delayed, DOM-only, popup, redirect, no-event, and never-completing transitions and compare browser duration with the baseline

## 7. Integration and Rollout

- [ ] 7.1 Run syntax, unit, integration, browser, concurrency, privacy, migration, dependency-audit, evaluation, and OpenSpec strict validation checks
- [ ] 7.2 Produce a before/after report for tokens and provider calls per qualifying opportunity, adaptive calls per page, browser seconds per verified application, cache and recipe hit rates, throughput, and quality outcomes
- [ ] 7.3 Progress through shadow mode, simulation, allowlisted domains, selected profiles, and approved live submissions with independent rollback exercised at each stage
- [ ] 7.4 Update architecture, configuration, deployment, operations, and incident-recovery documentation and retain the baseline and acceptance reports for operator review
