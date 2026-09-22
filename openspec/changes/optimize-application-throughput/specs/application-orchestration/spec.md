## ADDED Requirements

### Requirement: Profile throughput uses bounded hierarchical concurrency
The scheduler SHALL enforce configurable global, per-profile, and per-origin execution limits while preserving fair progress across profiles and one exclusive transactional claim per application attempt.

#### Scenario: One profile has multiple independent applications
- **WHEN** profile and global capacity permit two applications and their origins are within configured limits
- **THEN** both applications may execute concurrently in isolated worker contexts without sharing mutable browser state

#### Scenario: Applications share a constrained origin
- **WHEN** several queued applications target an origin whose concurrency limit is one
- **THEN** only one executes against that origin while eligible work for other origins or profiles can progress

### Requirement: Concurrent scheduling preserves submission safety
Increasing concurrency SHALL NOT bypass daily caps, confirmations, final approval, exclusive claims, receipt validation, or the rule that uncertain post-boundary attempts require manual review rather than automatic retry.

#### Scenario: Duplicate delivery occurs under profile concurrency
- **WHEN** the same queued application is delivered to multiple scheduler lanes
- **THEN** exactly one lane crosses the execution boundary and invokes the worker

### Requirement: Origin pressure triggers bounded backoff
The scheduler SHALL classify rate-limit and human-challenge outcomes, apply bounded per-origin backoff without recording private page content, and support reducing affected profile or origin concurrency independently.

#### Scenario: ATS begins rate limiting
- **WHEN** an origin returns a configured rate-limit or challenge signal
- **THEN** new work for that origin is delayed while unrelated origins continue within their limits
