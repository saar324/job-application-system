## 1. Direct-Link and Approval Orchestration

- [ ] 1.1 Add validated direct-link intake and CLI support; verify a URL creates one deduplicated durable application under the authenticated profile
- [ ] 1.2 Add per-profile/per-mode submission approval resolution and fingerprint-bound approval state; verify automatic, always-approve, and changed-preview cases

## 2. Browser Preview and Lifecycle

- [ ] 2.1 Capture complete redacted filled/unresolved field summaries and stable preview fingerprints; verify passwords and source document paths never appear
- [ ] 2.2 Add the pre-submit approval gate and standard authentication challenge detection; verify submit is not clicked before matching approval
- [ ] 2.3 Permit only the exact public initial host for user-requested URLs and retain configured redirect restrictions; verify private/local targets remain blocked
- [ ] 2.4 Instrument and test browser context cleanup for submitted, preview, input-required, human-review, and error outcomes

## 3. Interactive Telegram Confirmations

- [ ] 3.1 Add confirmation presentation metadata with bounded option, custom-answer, approve, and decline callbacks; verify recommendations never invent profile facts
- [ ] 3.2 Add profile-bound CLI callback commands and OpenClaw skill instructions; verify stale, foreign, and invalid option selections are rejected
- [ ] 3.3 Enable and validate inline buttons for both Telegram bot accounts while preserving profile routing isolation

## 4. Profile Credential Vaults

- [ ] 4.1 Implement separate AES-256-GCM credential vaults and key initialization; verify round-trip encryption, domain binding, profile isolation, and no plaintext at rest
- [ ] 4.2 Add generated-account and existing-credential resolution without persisting passwords in application state, confirmations, or audit; verify secret-leak regression tests
- [ ] 4.3 Inject at most one origin-matching credential into the worker and support safe standard login/signup fields; verify cross-domain pages cannot receive it
- [ ] 4.4 Detect MFA, verification, CAPTCHA, passkey, and unsupported authentication as owner-action confirmations; verify no answer is guessed

## 5. Production Secret Boundary

- [ ] 5.1 Split API and worker environment files and load vault keys through an API-only systemd credential; verify the worker environment excludes API and vault authority
- [ ] 5.2 Deploy the new runtime, refresh both OpenClaw skills, and verify service health, profile readiness, and browser launch without a live submission

## 6. Verification and Delivery

- [ ] 6.1 Run syntax, unit, browser, OpenSpec strict validation, and dependency audit checks with all results passing
- [ ] 6.2 Archive the completed change, commit, push, update the canonical checkout, and verify production matches the pushed commit
