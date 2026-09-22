## Context

Applications already run asynchronously in disposable Playwright contexts, with durable server confirmations for missing form fields. The missing pieces are direct URL intake, an explicit before-submit checkpoint, native Telegram presentation metadata, and a server-owned credential boundary.

## Goals / Non-Goals

**Goals:**

- Let either owner send an application URL and enter the normal durable workflow.
- Support automatic and always-approve behavior per profile and mode.
- Show exactly what will be submitted, with secrets redacted.
- Make questions selectable by Telegram buttons while retaining typed answers.
- Manage separate encrypted site credentials for profile A and profile B.
- Close every browser context after every attempt.

**Non-Goals:**

- Defeating CAPTCHA, MFA, email verification, passkeys, or anti-bot systems.
- Supporting every custom identity provider or account-creation widget.
- Keeping browser tabs alive while waiting for Telegram input.
- Replacing a general-purpose personal password manager.

## Decisions

### Replay from durable state instead of retaining browser tabs

Every worker request uses a fresh context and closes it in `finally`. Unknown questions and final approval return durable confirmation data. Once answered, the application replays from the beginning using stored non-secret answers and the exact site credential. This prevents tab leaks and makes restarts safe.

### Bind final approval to a redacted preview fingerprint

The worker records normalized field labels, types, redacted values, and answer sources at the final step. It hashes that preview. In `always` mode, it returns the preview without clicking. The service persists owner approval for the fingerprint; a replay submits only if the newly computed fingerprint matches.

### Keep interaction state in the API and rendering in OpenClaw

Confirmations expose a channel-neutral `presentation` with short callback values. The profile-bound skill renders it with OpenClaw’s Telegram button support. Callback text is routed back to the same agent, which invokes `jobctl choose`, `approve`, `reject`, or asks for a typed answer. API authentication remains the ownership boundary.

### Use encrypted server-side profile vaults

`CredentialVault` stores one AES-256-GCM encrypted file per profile and origin. Each profile has a separate random key loaded into the API through a systemd credential. Vault passwords are never put in durable application state. The API injects one matching origin credential into one worker request; the worker never receives vault keys.

### Split production environment files

The API and worker receive separate allowlisted environment files. This removes API bearer-token paths, central profile paths, and vault authority from the worker environment while retaining the shared webhook token on each side.

### Direct links permit only their exact initial host

A direct application receives `userRequested: true`. The worker may add that URL’s exact hostname to the navigation allowlist for that request after public-address validation. Other navigation hosts still require the configured ATS allowlist.

## Risks / Trade-offs

- **[Replay may encounter a changed form]** → Preview fingerprint mismatch requires a new approval.
- **[Some signup flows are not standard HTML]** → Pause with a specific manual-action confirmation.
- **[Credential entered in Telegram remains in chat history]** → Prefer generated managed accounts; warn before accepting an existing password and immediately remove it from durable server state.
- **[Exact-host credential binding can miss legitimate SSO]** → Ask again for the new origin instead of forwarding credentials across domains.
- **[Direct arbitrary domains increase attack surface]** → Require HTTPS, reject IP/local/private resolution, and scope navigation permission to one exact hostname.

## Migration Plan

1. Add tests and API/worker functionality in simulation and browser fixtures.
2. Create distinct API and worker environment files while preserving existing secrets without printing them.
3. Generate separate per-profile vault keys and load them only into the API unit.
4. Deploy the root-owned worker runtime and updated API.
5. Refresh both profile-bound OpenClaw skills and enable Telegram DM inline buttons.
6. Verify context cleanup, direct intake in simulation, profile isolation, live health, and worker environment separation without submitting a real application.
