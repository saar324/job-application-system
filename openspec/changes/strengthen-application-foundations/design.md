## Context

Application and confirmation state is currently persisted by rewriting one JSON document, and one serial runner coordinates every profile. That is adequate for a small prototype but makes transactions, concurrent workers, schema evolution, and failure diagnosis difficult. The active `direct-link-guided-applications` change also permits user-requested public hosts, which requires a stronger connection-level egress policy than hostname validation with a reusable DNS cache.

This change is the first phase of the modernization roadmap and should land after, or be reconciled with, the active direct-link change. Later opportunity-understanding and adaptive-browser changes depend on the durable state and telemetry introduced here.

## Goals / Non-Goals

**Goals:**

- Make all application, opportunity, confirmation, and audit mutations transactional and restart-safe.
- Allow different profiles to progress independently without permitting duplicate execution for one application.
- Preserve conservative handling once an external submit may have occurred.
- Close SSRF gaps across IPv4, IPv6, IPv4-mapped IPv6, redirects, and changing DNS answers.
- Make each workflow diagnosable without logging applicant secrets or document contents.

**Non-Goals:**

- Introducing a distributed workflow product in this phase.
- Increasing submission throughput beyond configured per-profile and global limits.
- Automatically retrying uncertain submissions.
- Exporting resumes, credentials, answers, or full page content as telemetry.

## Decisions

### Use SQLite behind a storage repository

SQLite in WAL mode provides local transactions, uniqueness constraints, migrations, and reliable restart behavior without adding a separate service. Storage access will move behind a repository interface so a future workflow system can reuse the service contracts. The migration imports the existing JSON file once, validates record counts and relationships, and retains a timestamped read-only backup until explicit operator cleanup.

### Separate queue claiming from external execution

Admission and claiming occur in short transactions. A claim contains an owner, lease expiry, and attempt identifier. An expired claim may return to `queued` only when no browser execution began. Immediately before invoking the worker, the application enters the existing uncertainty boundary; a restart or lost response from that point produces manual review rather than automatic retry.

### Partition scheduling by profile

Each profile has an independent serial execution lane, while configurable global concurrency caps bound total browser work. Database uniqueness and conditional state transitions remain the authority, so multiple server processes cannot execute the same application concurrently.

### Preserve explicit direct-application intent

Normalized URL identity remains profile-scoped. If a URL already exists as a discovered opportunity, direct intake upgrades the existing record with `userRequested` provenance and bypasses discovery-score admission. It does not erase original discovery evidence or create a duplicate application.

### Bind validation to network use

The worker canonicalizes every DNS result, including IPv4-mapped IPv6, and rejects the destination if any usable answer is loopback, link-local, private, reserved, multicast, or otherwise non-global. Redirects and subresources remain subject to policy. Validation must occur through a worker-owned request interceptor or egress proxy that connects using the validated resolution, avoiding a separate lookup between validation and connection. DNS decisions are scoped to one attempt and are not trusted across attempts.

### Emit privacy-safe OpenTelemetry signals

One correlation context follows profile-safe opaque identifiers through intake, source fetch, scoring, queue claim, worker attempt, confirmation, and receipt. Logs and spans use reason codes and counts rather than answers, credentials, document paths, or raw page content. Export failure never blocks application processing.

## Risks / Trade-offs

- **[Migration corrupts or drops state]** → Import into a new database, validate invariants and counts, then atomically switch while retaining the source backup.
- **[SQLite write contention]** → Keep transactions short, use WAL and bounded busy timeouts, and measure contention before considering a server database.
- **[Lease recovery causes duplicate submission]** → Permit lease requeue only before the durable execution boundary; later ambiguity always requires review.
- **[DNS policy breaks legitimate multi-host forms]** → Maintain explicit provider host policies and emit a precise blocked-destination reason for review.
- **[Telemetry leaks personal data]** → Use allowlisted attributes, central redaction tests, and opaque identifiers only.

## Migration Plan

1. Introduce the repository contract and SQLite schema while the JSON repository remains available in tests.
2. Add an idempotent importer and dry-run validation command.
3. Deploy with SQLite in shadow verification mode, then stop writes briefly and perform the final import.
4. Enable per-profile scheduling and lease recovery after restart and concurrency tests pass.
5. Enforce the connection-bound egress policy before enabling arbitrary direct hosts in production.
6. Enable telemetry exporters after redaction verification; retain local health metrics if the exporter is unavailable.
7. Document backup, restore, rollback, and JSON-backup retention procedures.
