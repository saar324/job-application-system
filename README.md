# Job Application System

One interactive chat searches and applies in Chrome. The server keeps the applicant profile, ordered queue, source configuration, application history and verified receipts.

The session works on one application at a time. New owner links append to the durable queue while it searches, applies or waits. After its complete live-form review, it submits under the owner's routine delegation. For CAPTCHA, missing information, uncovered commitments or required tool permission, it keeps the current form visible and waits for the owner. It does not move to another job.

A Submit click is not completion. The server records a one-use final attempt and accepts a receipt only with employer success evidence matching that attempt. An unknown outcome holds the queue without another Submit.

## Start

Use Node.js 22.5 or newer:

```bash
npm ci
cp .env.example .env
cp config/profiles.example.json config/profiles.json
npm run check
AUTH_DISABLED=true npm start
```

`AUTH_DISABLED=true` is for isolated local development only. Production requires profile-bound credentials. The API binds to loopback on port 4310. Configure profiles, tokens, document roots and sources privately before production use.

```bash
node bin/jobctl.js health
node bin/jobctl.js profile
node bin/jobctl.js queue
```

Read the [workflow](docs/agent-led-workflow.md) and [skill commands](skills/job-application/references/commands.md) for queueing, review, owner pauses and receipt recording. One Chrome session performs all browsing; the server does not launch application browsers.

## Preserve private configuration

Keep tokens and environment files, applicant profiles, resumes, runtime state, selected employer sources, compensation preferences and private writing references outside Git. Supported sources and their filters remain in the discovery configuration. No sources are enabled by default; `config/discovery.example.json` and the public starter catalog are examples for a private installation.

The installed skill's profile credential fixes applicant identity. Payloads cannot select another applicant. SQLite persists applications, checkpoints, review fingerprints, attempts, receipts and audit events. Recruiter records and employer-status updates remain available. Existing logs and historical submitted answers are preserved.

Optional job-site passwords live in a separate AES-256-GCM vault. Original encrypted records remain compatible. The current claimed session can check or retrieve only the current employer origin for its authenticated applicant. The CLI transfers an existing login through a private, two-minute file consumed by the internal browser runtime, without printing passwords. Registration, password creation and new legal commitments retain their owner gates. Read [accounts](skills/job-application/references/accounts.md).

Review [discovery](docs/discovery.md), [configuration](docs/configuration.md), and [deployment](docs/deployment.md) when working on those parts. Old campaign and worker reports describe historical releases, not the current interactive workflow. Their execution APIs and approval buttons are not exposed by the Chrome-session client.

## Validate

`npm run check` runs syntax checks, the regression suite and the repository privacy gate. Application state, authorization, deduplication and confirmation-policy changes require regression tests. The retired worker and its execution-only tests are removed. Synthetic queue receipts never count as real applications.

For browser verification, use synthetic applicant data in an isolated fixture, exercise sequential completion and an owner pause, and inspect console/network errors. Production smoke checks must preserve real application history and must not submit a test application to an employer.
