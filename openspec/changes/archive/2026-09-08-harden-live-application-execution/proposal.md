## Why

The live worker can currently read the the host system account, application requests can race or outlive client timeouts, and suitability scoring can auto-apply to jobs that violate location or compensation preferences. These gaps must be closed before a Telegram-triggered scan is safe to use.

## What Changes

- Isolate the browser worker under a dedicated operating-system account and hardened service boundary.
- Stage only validated application documents into the worker boundary; reject arbitrary, oversized, unsupported, or escaping paths.
- Make application creation atomic, queue execution outside HTTP requests, recover interrupted work conservatively, and make worker submissions idempotent.
- Enforce location, employment-type, and comparable-compensation preferences before auto-application.
- Support hidden native file inputs and strengthen confirmation detection for standard forms.
- Add regression, concurrency, recovery, document-policy, scoring, and browser tests.

## Capabilities

### New Capabilities

- `secure-browser-execution`: Constrains untrusted browser automation, applicant documents, and submission receipts to a dedicated worker boundary.
- `application-orchestration`: Provides atomic deduplication/caps, asynchronous durable execution, idempotency, and conservative crash recovery.
- `opportunity-eligibility`: Prevents automatic application when location, work type, or comparable compensation conflicts with the active profile.

### Modified Capabilities

None; this repository did not previously contain OpenSpec capability specifications.

## Impact

This affects the application service, JSON state transitions, webhook protocol, browser worker, scoring/discovery pipeline, CLI timeout behavior, systemd deployment, the host system runtime directories, and automated tests. The public API paths remain stable, but eligible application requests will now return `queued` before background execution completes.
