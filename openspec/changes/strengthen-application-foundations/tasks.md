## 1. Transactional Persistence

- [x] 1.1 Define a storage repository contract and normalized SQLite schema for profiles, opportunities, applications, attempts, confirmations, receipts, and audit events; verify foreign keys, uniqueness, and state invariants
- [x] 1.2 Implement transactional repositories, migrations, WAL configuration, bounded busy handling, and startup integrity checks; verify concurrent writers cannot violate admission or confirmation rules
- [x] 1.3 Build an idempotent JSON-to-SQLite dry-run/import command with record-count and relationship validation; verify rollback leaves the original JSON state untouched
- [x] 1.4 Add backup, restore, schema-version, and rollback documentation plus automated migration fixtures for existing state versions

## 2. Durable Multi-Profile Scheduling

- [x] 2.1 Add transactional claim records with attempt IDs, owners, leases, and an explicit pre-execution boundary; verify duplicate deliveries call the worker once
- [x] 2.2 Replace the global serial runner with per-profile lanes under a configurable global concurrency cap; verify one blocked profile does not stall another
- [x] 2.3 Recover expired pre-execution claims and convert interrupted post-boundary attempts to one manual-review confirmation; verify restarts never auto-retry an uncertain submission
- [x] 2.4 Correct direct-link deduplication so authenticated user intent upgrades an existing discovered opportunity and bypasses its discovery score without duplicating records

## 3. Browser Egress Hardening

- [x] 3.1 Canonicalize and classify IPv4, IPv6, IPv4-mapped IPv6, encoded-host, and literal-address inputs; add table-driven tests for loopback, private, link-local, reserved, multicast, and public ranges
- [x] 3.2 Enforce host and address policy on initial navigation, redirects, popups, and subresources through a connection-bound interceptor or egress proxy; verify alternate DNS resolution cannot bypass validation
- [x] 3.3 Scope DNS decisions to one execution attempt and add controlled DNS-change fixtures; verify a hostname that changes from public to private is blocked before the private connection
- [x] 3.4 Emit actionable, redacted policy-denial codes without exposing resolved internal addresses to agent clients

## 4. Operational Observability

- [x] 4.1 Add OpenTelemetry tracing and correlation across HTTP intake, discovery sources, scoring, queue claims, worker attempts, confirmations, and receipt persistence
- [x] 4.2 Add metrics for queue age, workflow duration, source failures, retries, confirmation latency, manual-review reasons, submissions, and SQLite contention
- [x] 4.3 Define structured error and outcome reason codes and surface aggregate health without exposing applicant answers, credentials, resume paths, or raw page content
- [x] 4.4 Add telemetry redaction tests and verify application processing continues when an exporter is slow or unavailable

## 5. Integration and Delivery

- [x] 5.1 Add HTTP and webhook integration tests covering authentication-derived profile identity, idempotency, stale confirmations, concurrency, and malformed input
- [x] 5.2 Add restart and multi-process tests covering queued, claimed, submitting, confirmation-required, submitted, and uncertain states
- [x] 5.3 Run syntax, unit, integration, browser-policy, privacy, migration, dependency-audit, and OpenSpec strict validation checks
- [ ] 5.4 Deploy with a documented rollback, verify state counts and health metrics, and retain the pre-migration JSON backup until operator acceptance
