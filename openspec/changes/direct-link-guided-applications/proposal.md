## Why

The current system can discover and apply to supported jobs, but a user cannot simply send an application URL and receive a guided, button-based approval flow. Account credentials are also outside the application boundary, so sign-in forms cannot be completed without unsafe ad-hoc password handling.

## What Changes

- Add direct-link intake that creates and queues a user-requested application without requiring discovery metadata.
- Add per-mode `submissionApproval` configuration for automatic end-to-end submission or mandatory final approval.
- Capture a redacted pre-submit field summary and require approval against that exact preview when configured.
- Add Telegram-ready confirmation presentations with option buttons, a safe recommendation, and an “I’ll type an answer” path.
- Add separate encrypted, domain-bound credential vaults for each applicant and generate strong passwords for supported account creation.
- Detect standard login/signup forms, use only the active profile’s credential for the current domain, and pause for MFA, verification, CAPTCHA, or unsupported authentication.
- Split API and worker environment files so the browser worker never receives server credentials or vault keys.
- Guarantee every browser context and popup is closed after each submitted, paused, failed, or previewed attempt.

## Capabilities

### New Capabilities

- `interactive-confirmations`: Telegram-compatible option and approval presentations backed by durable confirmations.
- `profile-credential-vaults`: Separate encrypted site credentials and safe standard authentication flow support.

### Modified Capabilities

- `application-orchestration`: Accept direct user-provided application URLs and persist final approval state.
- `secure-browser-execution`: Produce exact pre-submit previews and enforce browser-context cleanup.

## Impact

- API: new direct-application route and richer confirmation records.
- CLI/OpenClaw skill: direct-link, choice, and custom-answer workflows with Telegram buttons.
- Worker: field summaries, final-approval gate, standard authentication handling, and dynamic user-requested initial domains.
- Runtime: encrypted per-profile vault files and separate systemd environment boundaries.
