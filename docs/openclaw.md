# OpenClaw integration

This is one agent-runtime integration, not a deployment prerequisite. The system is agents-first, but it is not OpenClaw-specific: another agent can use the reusable skill, invoke `jobctl`, or call the same HTTP API without reproducing any wider personal automation system.

Use this guide only if you already operate OpenClaw. The bootstrap script connects an agent to the job application API; it does not install OpenClaw, create a messaging bot, or configure a messaging-provider credential. Use one OpenClaw agent, workspace, and profile-bound API token per applicant.

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
  --sources-file /private/job-application/sources.json \
  --writing-style-file /private/job-application/writing-style.json \
  --server-url http://127.0.0.1:4310
```

Before running it, the `openclaw` command must be available, the job application API must be running, and the token file's parent directory must be writable. If Telegram interaction is wanted, configure that account in OpenClaw first and pass its account ID with `--telegram-account`; otherwise the generated agent ID is used as the expected account ID. Operators using another channel can still invoke the installed skill, but channel-specific buttons must be adapted by that client.

The script:

1. creates the agent if needed;
2. installs the repository skill into its workspace;
3. enables direct-message inline buttons for its Telegram account;
4. rotates only that applicant's API credential;
5. writes the token into the installed skill with mode `0600`;
6. restores private source and writing-style references after a forced skill refresh;
7. never prints the token.

Run it once per applicant with different IDs and workspaces. Never reuse a token between profiles.

The two private reference flags are optional. When omitted during an upgrade, the script preserves existing installed `sources.json` and `writing-style.json` files in memory and restores them after installation. Keeping authoritative copies outside the workspace is still recommended for backup and disaster recovery.

## Confirmation flow

OpenClaw receives durable confirmation items from the server. Telegram buttons carry opaque callback data; the client passes that value back to the server. Typed answers are required when a question has no safe predefined choice. Final approval shows the complete redacted field preview before submission.

Generated site credentials go directly to the encrypted profile vault and are never returned to chat. If an applicant supplies a password manually, warn that the chat platform retains message history and avoid repeating it.

## Codex and other clients

The repository exposes the same skill at `.agents/skills/job-application`. Any compatible client can use it when `JOB_SERVER_TOKEN` is set to the intended profile-bound credential. Identity always comes from the credential, never from a CLI flag or request body.

For an agent runtime with no skill support, call `node bin/jobctl.js` as a subprocess or integrate directly with the HTTP API. The command-line client is also the manual diagnostic and recovery path; the normal production operator remains an agent.
