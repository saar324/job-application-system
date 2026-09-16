# Configuration

Configuration is layered: `config/default.json` supplies safe repository defaults, and `JOB_SERVER_CONFIG` can point to a private JSON override. Nested objects merge; arrays and scalar values replace the defaults.

## Repository defaults

The shared defaults use simulation, require final approval, disable automatic application, and enable no discovery sources. Keep those properties unless a deployment has been reviewed for live use.

## Private files

Create these from templates without committing them:

```bash
cp .env.example .env
cp config/default.json config/local.json
cp config/profiles.example.json config/profiles.json
```

Set `JOB_SERVER_CONFIG=./config/local.json` and `JOB_SERVER_PROFILES_FILE=./config/profiles.json` in `.env`. Replace every placeholder and generate random tokens. Applicant facts, preferences, answers, source selections, board identifiers, and document paths belong only in these ignored files.

Docker uses the same private config at `config/local.json`, but keeps mutable profiles and tokens under ignored `data/`. Systemd uses absolute paths under `/etc/job-application` and `/var/lib/job-application`; the deployment script normalizes those paths automatically.

## Authentication

Use `JOB_SERVER_TOKENS_FILE` for a private JSON object that maps random bearer tokens to fixed identities:

```json
{
  "REPLACE_WITH_RANDOM_TOKEN": {
    "actorId": "applicant-one-agent",
    "profileId": "applicant-one",
    "roles": ["agent"]
  }
}
```

`AUTH_DISABLED=true` is for loopback-only development. Never expose that mode to a network.

## Browser worker

The API and worker must use the same random secret through `APPLICATION_WEBHOOK_TOKEN` and `WORKER_TOKEN`. Set `WORKER_ALLOWED_DOMAINS` privately for any employer-specific destinations. Keep document roots narrow and absolute.

Direct URLs do not bypass the worker allowlist. Add an exact employer domain to `WORKER_ALLOWED_DOMAINS` only after reviewing it; an unlisted destination becomes a manual-review item.

## Applicant writing and sources

The repository skill ships neutral, empty reference templates. If a deployment customizes `sources.json` or `writing-style.json`, keep those customized copies out of this shared repository and install them directly into the private applicant workspace.
