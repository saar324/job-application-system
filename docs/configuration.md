# Configuration

Configuration is layered: `config/default.json` supplies safe repository defaults, and `JOB_SERVER_CONFIG` can point to a private JSON override. Nested objects merge; arrays and scalar values replace the defaults.

## Repository defaults

The shared defaults use simulation, require final approval, disable automatic application, and enable no discovery sources. `config/discovery.example.json` is a separate, optional starter that enables four public feeds while retaining simulation and final approval. Copy it to ignored `config/local.json` to opt in. The public browser-source list is `skills/job-application/references/public-sources.json`; it contains no applicant search policy or employer boards.

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

An authenticated direct URL grants only its exact initial hostname for that attempt. Redirects remain limited to the initial hostname and configured providers. Every HTTP request is freshly resolved and all IPv4, IPv6, and IPv4-mapped IPv6 answers must be public.

## SQLite state and concurrency

`JOB_SERVER_DATABASE` defaults to `data/state.sqlite`; `JOB_SERVER_DATABASE_BUSY_TIMEOUT_MS` defaults to 5000. The database uses WAL, foreign keys, schema migrations, row-level change persistence, dedicated payload-bound idempotency records, and optimistic state revisions. Legacy import completion is recorded in the same transaction as the imported state. `execution.concurrency` controls the total number of simultaneous profile lanes and `execution.claimLeaseMs` records the pre-execution claim lease.

Preview a legacy import:

```bash
npm run state:migrate -- --source ./data/state.json --database ./data/state.sqlite --dry-run
```

The non-dry run retains a timestamped JSON backup. Back up the SQLite database with the service stopped or with a SQLite-aware backup tool; retain the JSON backup until record counts and health checks are accepted.

## MCP

The MCP Streamable HTTP endpoint is `/mcp` on the API server and uses the same bearer authentication as `/v1`. Tools are paginated and bounded. Mutation tools require an idempotency key and return durable IDs rather than waiting for browser completion.

## Optional semantic enrichment

Set `JOB_SEMANTIC_ENABLED=true` only with a reviewed private provider implementing `/extract` and `/embed`. Public job text and a skill summary may be sent; resumes, credentials, applicant answers, and documents are never included. Configure endpoint, token, model, timeout, character budget, and version with the `JOB_SEMANTIC_*` variables in `.env.example`. Provider failure falls back to deterministic normalization.

## Optional adaptive forms

Adaptive execution is disabled unless both `WORKER_ADAPTIVE_ENABLED=true` and `WORKER_ADAPTIVE_ENDPOINT` are set. Restrict rollout with exact profile, mode, and domain lists. Step, wall-time, token, and cost limits are mandatory. The provider receives control metadata and public page text but never credential values. Use `node scripts/capture-browser-fixture.js --synthetic --url ... --output ...` only against synthetic accounts to build evaluation fixtures. `npm run eval:adaptive` summarizes completion, correctness, policy violations, latency, manual review, tokens, and cost. Production enablement requires at least 98% correctness, zero policy violations, and an accepted cost ceiling. Creating `WORKER_ADAPTIVE_KILL_SWITCH_FILE` disables new adaptive attempts immediately.

## Applicant writing and sources

The repository skill ships neutral, empty private reference templates and a separate public starter catalog. The starter contains only general source names and unfiltered HTTPS listing URLs; its ATS entries require private employer-board configuration before they can return roles. If a deployment customizes `sources.json` or `writing-style.json`, keep those customized copies out of this shared repository and install them directly into the private applicant workspace. Profile titles, regions, work rights, compensation, priorities, board IDs, and screening rules remain private.
