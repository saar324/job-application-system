## Why

The service currently depends on whole-file JSON persistence and one process-local execution lane, which limits crash recovery, profile isolation under load, and diagnosis of failures. Direct-link execution also expands the browser attack surface, so address validation, deduplication semantics, and regression coverage need to be hardened before adding model-driven automation.

## What Changes

- Replace whole-state JSON rewrites with transaction-backed durable storage and a resumable migration path.
- Schedule work independently per profile while preserving exclusive claims, daily limits, and conservative handling of uncertain submissions.
- Treat an authenticated direct application request as explicit user intent even when the URL was previously discovered with a low score.
- Canonicalize IPv4, IPv6, and IPv4-mapped IPv6 destinations and bind outbound browser traffic to fresh public-address validation.
- Add end-to-end traces, metrics, structured failure reasons, and redacted logs across discovery, admission, execution, confirmation, and receipt persistence.
- Add regression coverage for concurrency, restart, deduplication, SSRF, DNS changes, HTTP routes, and webhooks.

## Capabilities

### New Capabilities

- `operational-observability`: Defines correlated, privacy-safe telemetry and actionable source and workflow health signals.

### Modified Capabilities

- `application-orchestration`: Adds transaction-backed multi-profile scheduling, safe lease recovery, and direct-intent deduplication semantics.
- `secure-browser-execution`: Strengthens destination validation against alternate IP representations, private networks, redirects, and DNS rebinding.

## Impact

- Persistence: storage repository, schema migrations, startup recovery, and backup/restore procedures.
- Runtime: queue scheduling, worker claims, direct-link admission, and retry state transitions.
- Browser boundary: URL parsing, DNS resolution, request interception or egress proxying, and navigation audit data.
- Operations: OpenTelemetry dependencies, health endpoints, dashboards or exporters, and deployment configuration.
- Tests: state migration, multi-process concurrency, HTTP/webhook integration, and hostile-network fixtures.
