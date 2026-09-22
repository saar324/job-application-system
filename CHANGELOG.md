# Changelog

## [0.2.0] - 2026-09-19

### Added

- Streamable HTTP MCP tools with profile-bound authentication, bounded output, and durable payload-bound idempotency.
- Transactional SQLite persistence with WAL, normalized records, schema migrations, restart recovery, legacy JSON import safeguards, and incremental row updates.
- Per-profile scheduling under a global concurrency limit with durable execution attempts and conservative uncertain-submission recovery.
- Canonical opportunity normalization, field provenance, structured ATS metadata, boundary-aware skill matching, explainable scoring, and optional semantic enrichment.
- An optional adaptive browser fallback with strict action policy, approval gates, privacy-redacted observations, usage budgets, and verified submission receipts.
- Connection-bound browser egress validation, IPv4 and IPv6 classification, telemetry, evaluation harnesses, and expanded privacy checks.
- Apache-2.0 licensing and OpenSpec plans for the next throughput and model-efficiency phase.

### Changed

- Node.js 22.5 or newer is now required.
- Production state defaults to SQLite. Existing JSON state is validated, backed up, and imported transactionally when its durable migration marker is absent.
- Discovery and direct applications now share canonical eligibility and deduplication behavior.

### Security

- Applicant values and credentials are removed from adaptive-provider observations, telemetry, and durable idempotency audit data.
- Submission status requires newly observed evidence and a production receipt; ambiguous post-submit outcomes require manual review.
- Profile ownership, migration relationships, outbound destinations, staged documents, and credential origins receive stricter validation.

## [0.1.0] - 2026-09-17

- Initial public release of the agent-first job discovery and application orchestrator.
