## Purpose

Defines measurable efficiency improvements that reduce model and browser work without weakening application quality, privacy, safety, or receipt integrity.

## ADDED Requirements

### Requirement: Efficiency is measured per successful workflow outcome
The system SHALL measure semantic provider calls and input size, adaptive calls and tokens, cache and recipe effectiveness, queue and browser duration, manual-review outcomes, policy denials, challenges, verified submissions, and duplicate execution using privacy-safe attributes.

#### Scenario: An optimization is evaluated
- **WHEN** an operator compares an optimization with its versioned baseline
- **THEN** the report shows resource use and latency per qualifying opportunity and verified application together with correctness and safety outcomes

### Requirement: Efficiency rollout cannot trade away quality invariants
An optimization SHALL NOT be promoted when it changes a deterministic hard exclusion incorrectly, creates a false submitted state, duplicates worker execution, permits a policy violation, exposes private applicant data, or regresses the accepted fixture-corpus correctness threshold.

#### Scenario: Faster execution produces an unverified success
- **WHEN** an optimized path completes faster but cannot produce newly observed submission evidence and a valid receipt
- **THEN** the application does not become submitted and the optimization fails its rollout gate

### Requirement: Optimizations are independently reversible
Semantic selection, durable caching, scheduler concurrency, adaptive batching, recipe replay, and transition-wait changes SHALL have independent rollout controls and SHALL preserve a documented path to their previous safe behavior.

#### Scenario: One origin shows an increased challenge rate
- **WHEN** concurrency or recipe replay produces a material challenge-rate regression for an origin
- **THEN** operators can disable that optimization for the affected scope without disabling deterministic applications elsewhere
