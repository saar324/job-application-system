# OpenClaw integration

Use one OpenClaw agent, workspace, and profile-bound API token per applicant.

```text
chat A -> agent A -> token A -> profile A records
chat B -> agent B -> token B -> profile B records
```

Provision an agent from the repository checkout:

```bash
node scripts/bootstrap-openclaw.js \
  --agent applicant-one \
  --profile applicant-one \
  --workspace /private/openclaw/workspaces/applicant-one \
  --tokens-file /private/job-application/tokens.json \
  --server-url http://127.0.0.1:4310
```

The script:

1. creates the agent if needed;
2. installs the repository skill into its workspace;
3. enables direct-message inline buttons for its Telegram account;
4. rotates only that applicant's API credential;
5. writes the token into the installed skill with mode `0600`;
6. never prints the token.

Run it once per applicant with different IDs and workspaces. Never reuse a token between profiles.

## Confirmation flow

OpenClaw receives durable confirmation items from the server. Telegram buttons carry opaque callback data; the client passes that value back to the server. Typed answers are required when a question has no safe predefined choice. Final approval shows the complete redacted field preview before submission.

Generated site credentials go directly to the encrypted profile vault and are never returned to chat. If an applicant supplies a password manually, warn that the chat platform retains message history and avoid repeating it.

## Codex and other clients

The repository exposes the same skill at `.agents/skills/job-application`. Any compatible client can use it when `JOB_SERVER_TOKEN` is set to the intended profile-bound credential. Identity always comes from the credential, never from a CLI flag or request body.
