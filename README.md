# Agent-First Job Application System

An agents-first, self-hosted system for job discovery, application tracking, browser-assisted submission, confirmations, and auditable receipts. Multiple applicants can use one deployment without sharing profiles, credentials, or application history.

Agents are the primary operators. The API exposes durable, machine-readable work queues, idempotent actions, profile-bound identity, confirmation items, and verified receipts so an agent can discover, evaluate, apply, pause for a person, and resume safely. People remain the authority for unknown facts, legal attestations, sensitive answers, and final approval.

Agent-first does not mean tied to a particular agent runtime or to a broader personal operating system. Codex, OpenClaw, a custom agent, or another compatible runtime can drive the same HTTP API. The included `jobctl` program is the reference transport and an operator/debugging fallback—not the intended production orchestrator.

This repository intentionally contains no real applicant profiles, resumes, application records, credentials, preferred employers, source selections, compensation requirements, or writing preferences. The included defaults are safe templates: discovery and automatic application are disabled until a deployment opts in.

Start with [Getting started](docs/getting-started.md). It separates a five-minute local simulation from authenticated and production deployment, and lists every private file a new operator must create.

## Capabilities

- profile-bound bearer credentials and isolated applicant data
- configurable full-time and freelance workflows
- normalized discovery adapters with explainable scoring and deduplication
- durable opportunity, application, confirmation, receipt, and audit records
- Playwright-based handling for standard and multi-step application forms
- manual-review handoff for CAPTCHAs, legal attestations, unknown answers, and unsupported forms
- encrypted, profile-scoped, domain-bound site credentials
- verified-submission receipts instead of assuming a button click succeeded
- an agent-oriented HTTP API, reusable skill, and profile-aware reference CLI
- simulation mode and browser fixtures for safe development

## Private configuration boundary

Keep deployment-specific material outside Git or in the ignored paths shown below.

| Material | Recommended location |
| --- | --- |
| Environment variables and tokens | `.env` or `/etc/job-application/*.env` |
| Applicant profiles and answers | `config/profiles.json` or a private absolute path |
| Runtime state and receipts | `data/` or `/var/lib/job-application/` |
| Resumes and other documents | a private directory allowed by `JOB_SERVER_ALLOWED_DOCUMENT_ROOTS` |
| Employer boards and enabled source IDs | `config/local.json` or another private config file |
| Applicant-specific source catalog and writing style | private copies of the skill reference JSON files |

Do not commit any of these files. Run `npm run privacy:check` before every push.

GitHub Actions runs the syntax, test, dependency-lock, and repository privacy checks for every pull request and push to `main`. Branch protection requires a pull request, an owner review, and a passing check before merge.

## Quick start

Requirements: Node.js 22 or newer.

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

## Configure an applicant

Replace every `REPLACE_ME` value in the ignored `config/profiles.json`. An applicant can also update only their own profile through the authenticated CLI:

```bash
printf '%s' '{"contact":{"firstName":"...","lastName":"...","email":"...","phone":"...","location":"..."},"documents":{"resume":"/absolute/private/path/resume.pdf"},"skills":["..."],"preferences":{"locations":["..."],"fullTime":{"jobTitles":["..."]}}}' \
  | node bin/jobctl.js profile-update
```

The API reports missing onboarding fields. Discovery becomes available when search preferences exist; submission remains blocked until required contact and document fields are complete.

## Configure discovery privately

No source is enabled by default. Copy `config/default.json` to ignored `config/local.json`, set `JOB_SERVER_CONFIG=./config/local.json`, and choose source IDs for each mode. Supported adapters are registered in `src/discovery/service.js`.

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

The system is agent-runtime agnostic. The reusable skill lives in `skills/job-application` and is exposed at `.agents/skills/job-application` for compatible agents. A custom agent can call the same bearer-authenticated API or invoke `jobctl` as a subprocess. Install one skill and profile-bound token per applicant.

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

See [Contributing](CONTRIBUTING.md) before proposing changes and [Security](SECURITY.md) before reporting a vulnerability. No license is included yet. Public visibility permits inspection and GitHub collaboration but does not grant general reuse or redistribution rights; choose an explicit license before encouraging downstream reuse.
