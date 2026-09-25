# Agent-First Job Application System

For new job searches, use the [agent-led discovery workflow](docs/agent-led-workflow.md): deterministic source retrieval and known-role filtering, one agent fit decision, then verified destination and application preparation. The older score-first campaign path remains available for in-flight work and historical reports.

An agents-first, self-hosted system for job discovery, application tracking, browser-assisted submission, confirmations, and auditable receipts. Multiple applicants can use one deployment without sharing profiles, credentials, or application history.

Agents are the primary operators. The API exposes durable, machine-readable work queues, idempotent actions, profile-bound identity, confirmation items, and verified receipts so an agent can discover, evaluate, apply, pause for a person, and resume safely. People remain the authority for unknown facts, legal attestations, sensitive answers, and final approval.

Agent-first does not mean tied to a particular agent runtime or to a broader personal operating system. Codex, OpenClaw, a custom agent, or another compatible runtime can drive the same HTTP API. The included `jobctl` program is the reference transport and an operator/debugging fallback—not the intended production orchestrator.

This repository intentionally contains no real applicant profiles, resumes, application records, credentials, preferred employers, applicant-specific source selections, compensation requirements, or writing preferences. The included defaults are safe templates: discovery and automatic application are disabled until a deployment opts in. A separate public starter catalog contains only reusable source names and unfiltered listing URLs.

Start with [Getting started](docs/getting-started.md). It separates a five-minute local simulation from authenticated and production deployment, and lists every private file a new operator must create. [Public starter sources](docs/public-starter-sources.md) explains the reusable catalog and safe discovery config. The single-agent efficiency upgrade is documented in [Application efficiency upgrade](docs/application-efficiency-upgrade.md), with the [2026-09-21 production rollout record](docs/production-rollout-2026-09-21.md) and [2026-09-22 public-board handoff check](docs/public-board-handoff-2026-09-22.md).

## Capabilities

- profile-bound bearer credentials and isolated applicant data
- configurable full-time and freelance workflows
- normalized discovery adapters with explainable scoring and deduplication
- transactional SQLite opportunity, application, attempt, confirmation, receipt, and audit records
- profile-scoped MCP tools at `/mcp` for compatible agent clients
- Schema.org `JobPosting` normalization, boundary-aware skills, and optional semantic ranking
- privacy-safe OpenTelemetry instrumentation and structured operational health
- Playwright-based handling for standard and multi-step application forms
- manual-review handoff for CAPTCHAs, legal attestations, unknown answers, and unsupported forms
- encrypted, profile-scoped, domain-bound site credentials
- verified-submission receipts instead of assuming a button click succeeded
- an agent-oriented HTTP API, reusable skill, and profile-aware reference CLI
- simulation mode and browser fixtures for safe development
- optional deterministic-first adaptive form fallback with action and cost limits

## Primary operating model

The normal deployment is driven by an agent that runs continuously or wakes on a schedule. Each cycle:

1. checks profile readiness and unfinished applications;
2. reads the confirmation inbox and surfaces new human decisions;
3. scans configured sources and evaluates evidence-backed matches;
4. requests eligible applications within policy and daily limits;
5. observes queued browser work, records verified receipts, and leaves blocked work durable;
6. sleeps or exits until the next scheduled cycle.

The agent runtime owns scheduling, backoff, and notifications. The server owns durable state, deduplication, policy, identity, confirmations, and receipts. A cycle can stop at any point and a later cycle—or a replacement agent runtime—can resume without relying on chat history or an always-running process.

## Private configuration boundary

Keep deployment-specific material outside Git or in the ignored paths shown below.

| Material | Recommended location |
| --- | --- |
| Environment variables and tokens | `.env` or `/etc/job-application/*.env` |
| Applicant profiles and answers | `config/profiles.json` or a private absolute path |
| Runtime state and receipts | `data/` or `/var/lib/job-application/` |
| Resumes and other documents | a private directory allowed by `JOB_SERVER_ALLOWED_DOCUMENT_ROOTS` |
| Employer boards and applicant-specific source selections | `config/local.json` or another private config file |
| Applicant-specific source catalog and writing style | private copies of the skill reference JSON files |

Do not commit any of these files. Run `npm run privacy:check` before every push.

GitHub Actions runs the syntax, test, dependency-lock, and repository privacy checks for every pull request and push to `main`. Branch protection requires a pull request, an owner review, and a passing check before merge.

## Quick start

Requirements: Node.js 22.5 or newer.

```bash
npm ci
cp .env.example .env
cp config/profiles.example.json config/profiles.json
npm run check
AUTH_DISABLED=true npm start
```

The API listens on `127.0.0.1:4310`. Use the reference client from another shell to verify the deployment:

```bash
node bin/jobctl.js health
node bin/jobctl.js profile
```

Simulation mode never performs a live submission.

New installations use `data/state.sqlite`. If `data/state.json` exists and its durable import marker is absent, startup validates the legacy relationships, creates a timestamped backup, and imports it transactionally. This safely resumes after an empty or partially initialized database file was left behind. Operators can preview the same process with `npm run state:migrate -- --dry-run`.

## Configure an applicant

Replace every `REPLACE_ME` value in the ignored `config/profiles.json`. An applicant can also update only their own profile through the authenticated CLI:

```bash
printf '%s' '{"contact":{"firstName":"...","lastName":"...","email":"...","phone":"...","location":"..."},"documents":{"resume":"/absolute/private/path/resume.pdf"},"skills":["..."],"preferences":{"locations":["..."],"fullTime":{"jobTitles":["..."]}}}' \
  | node bin/jobctl.js profile-update
```

The API reports missing onboarding fields. Discovery becomes available when search preferences exist; submission remains blocked until required contact and document fields are complete.

## Configure discovery privately

No source is enabled by default. For a safe public-feed starter, copy `config/discovery.example.json` to ignored `config/local.json` and set `JOB_SERVER_CONFIG=./config/local.json`. This enables four public discovery feeds in simulation, with automatic application off. The public source catalog is at `skills/job-application/references/public-sources.json`; `npm run campaign:all-sources` uses it when `--catalog` is omitted. Supply a private catalog with `--catalog` for applicant-specific sources and regions. Supported server adapters are registered in `src/discovery/service.js`.

Ashby, Greenhouse, and Lever require explicit board configuration; the repository does not ship with employer selections:

```json
{
  "discovery": {
    "sourceOptions": {
      "ashby": { "boards": [{ "slug": "REPLACE_ME", "company": "REPLACE_ME" }] },
      "greenhouse": { "boards": [{ "token": "REPLACE_ME", "company": "REPLACE_ME" }] },
      "lever": { "sites": [{ "slug": "REPLACE_ME", "company": "REPLACE_ME" }] }
    }
  },
  "modes": {
    "full_time": {
      "sources": ["REPLACE_WITH_SOURCE_IDS"],
      "autoApply": false,
      "autoApplyDiscovered": false
    }
  }
}
```

Run a scan only after reviewing the private profile and source configuration:

```bash
printf '%s' '{}' | node bin/jobctl.js scan
node bin/jobctl.js applications
node bin/jobctl.js inbox
```

## Production browser worker

Use the production checklist in [Getting started](docs/getting-started.md) before enabling the browser worker. It covers profile-bound API tokens, vault keys, document paths, allowed domains, and the shared worker secret.

```bash
docker compose up --build -d
```

The API sends the worker only the current application and matching profile. The worker runs each attempt in an isolated browser context. Passwords are redacted, document roots are allowlisted, and unexpected domains become manual-review items.

Systemd templates and the deployment script use dedicated `jobapp-api` and `jobapply-worker` accounts. See [deployment](docs/deployment.md), [architecture](docs/architecture.md), [configuration](docs/configuration.md), and [discovery adapters](docs/discovery.md).

## Agent clients

The system is agent-runtime agnostic. The reusable skill lives in `skills/job-application` and is exposed at `.agents/skills/job-application` for compatible agents. A custom agent can call the same bearer-authenticated API, connect to the Streamable HTTP MCP endpoint at `/mcp`, or invoke `jobctl` as a subprocess. Install one skill and profile-bound token per applicant. MCP identity is always derived from that bearer token; profile IDs in tool arguments are not accepted as authority.

OpenClaw is one supported runtime, not a prerequisite. `scripts/bootstrap-openclaw.js` can connect an existing installation without printing its generated credential:

```bash
node scripts/bootstrap-openclaw.js \
  --agent applicant-one \
  --profile applicant-one \
  --workspace /private/openclaw/workspaces/applicant-one \
  --tokens-file /private/job-application/tokens.json
```

See [OpenClaw integration](docs/openclaw.md) for the isolation model.

## Safety invariants

- Profile identity comes from authentication, never request content.
- Unknown applicant facts are never inferred or invented.
- Legal attestations require explicit applicant confirmation.
- A production application is `submitted` only after a verifiable receipt.
- Credentials, documents, source preferences, and application state stay out of Git.
- Live submission is opt-in; repository defaults remain simulation-only and approval-gated.

See [Contributing](CONTRIBUTING.md) before proposing changes and [Security](SECURITY.md) before reporting a vulnerability.

## License

Licensed under the [Apache License 2.0](LICENSE). You may use, modify, and distribute the project under its terms. Contributions submitted to this repository are licensed on the same basis.
