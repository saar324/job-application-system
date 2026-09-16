## Context

The job server is a single-process Node service with atomic JSON persistence, while browser execution is delegated over loopback to a Playwright worker. OpenClaw calls the API through a short-lived CLI process. Production currently runs both services as the `jobapp-api` user and performs browser execution inline with the initiating HTTP request.

## Goals / Non-Goals

**Goals:**

- Make a job-site compromise unable to read the host system home data.
- Ensure only explicitly allowed resume/cover-letter files cross the worker boundary.
- Make admission, queueing, recovery, and worker submission safe against repeats.
- Turn stored location, work-type, and compensation preferences into enforceable gates.
- Keep the existing HTTP paths and centralized the host system profile/config file.

**Non-Goals:**

- Automating CAPTCHA, account creation, email verification, LinkedIn, or proprietary non-standard widgets.
- Guaranteeing exactly-once execution across a browser/remote-site crash boundary; uncertain submissions require human verification.
- Adding an external database, message broker, currency-rate service, or scheduler in this change.

## Decisions

### Use a dedicated worker account and staged document directory

The production worker will run as `jobapply-worker` from a root-owned runtime copy under `/opt`, with `ProtectHome=true` and a dedicated `/var/lib/job-application-worker` tree. The API and worker share only a setgid document-staging directory through a narrow `jobapply` group. This is preferred over running Chromium as `jobapp-api`, and avoids depending on Docker on this host.

The API resolves source documents with `realpath`, verifies containment in configured roots, checks type/extension/size, and copies fixed-name files under the UUID application directory. The worker independently verifies that received paths resolve inside the staging root. Defense on both sides prevents profile updates or a forged worker request from turning file upload into arbitrary the host system file exfiltration.

### Keep JSON persistence but add a serialized background runner

Admission checks move inside the existing store mutation lock. Eligible applications persist as `queued`, are returned immediately, and are delivered to an in-process single-concurrency runner. Queue claims are also atomic. This fits the one-host workload without adding Redis or a database.

At startup, persisted queued items are redelivered. Persisted submitting items are converted to manual review because the remote side effect is unknowable. Tests receive a `waitForIdle` hook; production clients poll the existing applications endpoint.

### Add worker-side receipt idempotency

The worker hashes the immutable application/profile/opportunity identity. It serializes identical in-flight IDs and atomically saves successful results before responding. Repeated identical requests return the receipt; a changed fingerprint is rejected. This closes response-loss retries after a receipt was persisted, while the server’s conservative recovery covers the narrower crash-before-persist window.

### Represent suitability as hard exclusions plus policy conflicts

Scoring remains explainable, but known violations no longer merely lose a few points. Restricted locations, disallowed employment types, and below-minimum comparable pay become hard exclusions. A known currency mismatch becomes `compensation_conflict`, which the existing confirmation policy understands. Unknown compensation remains neutral because many valid listings omit it.

### Strengthen generic forms without pretending universal ATS support

Native hidden file inputs are safe to populate directly. Submission evidence must be new after the click. Custom widgets, human challenges, and unsupported account flows continue to pause for review rather than guess.

## Risks / Trade-offs

- **[Single-process queue can pause while the API is down]** → Queued work is persisted and redelivered at startup.
- **[Crash immediately after remote submit can never be proven locally]** → Submitting state recovers to manual review, never automatic retry.
- **[Staged documents persist longer than one request]** → They contain only approved application files, use restrictive group permissions, and can be pruned after application retention requirements are defined.
- **[Systemd hardening may conflict with Chromium]** → Validate browser launch and a fixture submission under the installed unit before re-enabling the API.
- **[Location strings are imperfect]** → Hard exclusion only applies to explicit named restrictions; generic/unknown remote listings remain eligible.

## Migration Plan

1. Stop the current live API and worker.
2. Deploy code and central preference additions.
3. Create the worker/group/runtime directories and install the root-owned worker runtime.
4. Install Chromium as the dedicated worker and replace systemd units.
5. Run unit, browser, concurrency, recovery, idempotency, and service-hardening checks.
6. Start the worker, then API; verify both profile-bound clients and health endpoints.
7. Roll back by restoring the prior systemd units and commit; no queued live applications currently exist.
