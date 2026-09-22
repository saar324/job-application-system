# Architecture

The API is the durable system of record and agents are its primary clients. Codex, OpenClaw, custom agents, and other runtimes are replaceable adapters that use the same profile-bound credentials. The included `jobctl` command-line program is the reference transport, test client, and manual recovery tool; it is not the production orchestrator.

```text
applicant agent A ----- token for profile A ----+
                                                |
applicant agent B ----- token for profile B ----+--> Job API
                                                      |-- MCP + HTTP adapters
                                                      |-- profile store
public job APIs --------------------------------------|-- discovery + scoring
                                                      |-- policy + daily caps
                                                      |-- transactional SQLite state
                                                      |-- confirmation inbox
                                                      |-- receipts + audit events
                                                      |
                                                      +--> isolated browser worker
```

## Agent contract

- Agents operate in recurring cycles: recover existing work, handle confirmations, discover or add opportunities, request applications, observe bounded progress, and yield until the next cycle.
- The agent runtime owns the wake schedule, bounded polling, backoff, and user notification; the server does not require one permanently running chat turn.
- Every request is authenticated to one profile; an agent cannot select another applicant in its payload.
- Queue delivery and application creation are idempotent so retries do not duplicate submissions.
- Unknown facts, legal attestations, CAPTCHAs, sensitive answers, and final approval become durable confirmation items for the person.
- Agents resume the same application after confirmation and report only verified submission receipts.
- Agent runtimes never need direct access to the state database, credential vault, or unrestricted document storage.

## Trust boundaries

- Authentication maps a bearer token to a fixed `profileId`; request bodies cannot select another profile.
- Profile data, tokens, resumes, application state, credential vaults, and receipts are private runtime data, not repository content.
- The API validates and stages only allowed documents for the current application.
- The browser worker receives one application and one matching profile at a time. It cannot read the API state directory or original document roots.
- Every browser attempt runs in a fresh context and closes all pages before returning.
- Navigation is restricted to HTTPS and an allowlist. Add employer-specific domains through private environment configuration.
- A click is not a receipt. Production submission requires a timestamp, final URL, and visual receipt hash.

## State model

```text
opportunity
  -> application queued
  -> preparing
  -> waiting_confirmation | submitted | failed | manual_review
```

Queue claims and execution attempts are durable. Different profiles have independent serial lanes under a global concurrency limit. A claim interrupted before browser execution can be recovered; an interruption after the execution boundary always becomes manual review.

Confirmation items are durable and idempotent. Unknown questions, legal attestations, final approval, CAPTCHA handoffs, and ambiguous outcomes never become silent guesses.

## Opportunity understanding

Discovery normalizes provider data into a versioned canonical opportunity with field-level provenance. Public ATS data and Schema.org `JobPosting` metadata take precedence over deterministic text parsing. Skill matching uses token boundaries and aliases. Optional structured extraction and embeddings can enrich unresolved public job fields and ranking, but deterministic location, authorization, employment-type, compensation, and exclusion gates always win.

## Adaptive execution

Known Playwright adapters remain the default. An optional HTTP-backed adaptive provider can propose a small typed action set for unsupported forms. Worker-owned code validates every action, resolves values only from authoritative profile or approved application data, applies origin and budget limits, and enforces the same preview fingerprint and receipt rules. Before an observation leaves the worker, URL query/fragment data and known applicant, answer, and credential values are removed. Page content is untrusted and cannot authorize submission or request secrets, and success text is accepted only when newly observed after an approved final-submit action. The feature is disabled by default and has global, profile, mode, and domain kill switches.

## Credential isolation

Each profile has a separate AES-256-GCM credential-vault file and key. Entries are bound to an HTTPS origin. Passwords are excluded from application state, audit events, confirmation payloads, logs, and worker receipts.

## Production layout

The included systemd deployment uses:

- `/opt/job-application-system`: root-owned application code
- `/etc/job-application`: root-owned environment files and vault keys
- `/var/lib/job-application`: API state, private profiles, and encrypted profile vaults
- `/var/lib/job-application-worker`: staged documents, browser binaries, artifacts, and receipts

The API runs as `jobapp-api`; Chromium runs as `jobapply-worker`. A narrow `jobapply` group permits access only to staged documents.
