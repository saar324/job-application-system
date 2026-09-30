# Changelog

## [Unreleased]

### Added

- A `workable` discovery source that reads configured Workable accounts from Workable's documented public careers-page endpoint. Workable roles deduplicate across the account and short-link URL forms, are revalidated before a manual application is admitted, and are skipped by every automatic lane with `ats_submission_unsupported` until a Workable submission adapter exists.
- A `workday` discovery source that searches operator-configured Workday careers sites through the sites' own undocumented search endpoint, using the shared title search plan within fixed per-site and per-scan request limits (`partial_response_cap` when a limit truncates reading). Workday roles deduplicate across locale, `/apply` and aggregator URL forms by tenant and requisition, are revalidated before a manual application is admitted (`role_closed_or_changed`, retryable `workday_revalidation_unavailable`), and are skipped by every automatic lane with `ats_submission_unsupported`.

### Changed

- The labeled annual-salary extractor is now provider-neutral (`src/discovery/labeled-compensation.js`).

### Fixed

- Paced official-feed requests are keyed by method and body, like the response cache, so two concurrent POST searches to one URL no longer share a response.

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
