# Getting started

Choose the smallest setup that matches your goal.

This is an agents-first, runtime-agnostic application. Production use is intended to be driven by an agent, but you do not need the repository owner's surrounding automation or any specific bot platform. The setup flow uses the included command-line client as a deterministic reference and diagnostic tool; connect Codex, OpenClaw, or another agent after the server is verified.

| Goal | Setup |
| --- | --- |
| Inspect the system safely | Local simulation with authentication disabled |
| Test agent identity and multiple private profiles | Authenticated simulation |
| Submit through Chromium | Docker Compose or systemd production deployment |
| Connect an agent runtime | Profile-bound token plus the skill or HTTP API |

## 1. Local simulation

Requirements: Git and Node.js 22 or newer.

```bash
git clone https://github.com/YOUR_GITHUB_ORG/job-application-system.git
cd job-application-system
npm ci
cp .env.example .env
cp config/profiles.example.json config/profiles.json
npm run check
AUTH_DISABLED=true npm start
```

In another terminal:

```bash
node bin/jobctl.js health
node bin/jobctl.js profile
```

Edit only the ignored `config/profiles.json`, or use `profile-update`. Simulation records workflow state but never opens a real application site or submits a form.

## 2. Authenticated simulation

Generate a random bearer token, create ignored `data/tokens.json`, and map the token to a fixed profile ID:

```json
{
  "REPLACE_WITH_A_LONG_RANDOM_TOKEN": {
    "actorId": "applicant-one-agent",
    "profileId": "applicant-one",
    "roles": ["agent"]
  }
}
```

Set `AUTH_DISABLED=false`, `JOB_SERVER_TOKENS_FILE=./data/tokens.json`, and the same profile ID in `config/profiles.json`. Start the server, then export `JOB_SERVER_TOKEN=REPLACE_WITH_A_LONG_RANDOM_TOKEN` in each CLI or client session. Install clients with a different token for every profile. Never send tokens, resumes, profile files, or application state through issues or chat.

## 3. Configure discovery

Copy `config/discovery.example.json` to ignored `config/local.json` and set `JOB_SERVER_CONFIG=./config/local.json` for four public feeds in simulation. The public browser-source starter is `skills/job-application/references/public-sources.json`. The base `config/default.json` still enables no sources. Employer-specific Ashby, Greenhouse, and Lever boards, source priorities, regions, and search preferences belong in private files.

Keep `autoApply` and `autoApplyDiscovered` false until scoring, location eligibility, compensation policy, and final-approval behavior have been tested with your profile.

## 4. Production checklist

Before enabling Chromium:

- replace every placeholder in the private profile;
- use profile-bound API tokens and a separate worker secret;
- keep the API on loopback or a trusted private network;
- configure narrow document roots and reviewed destination domains;
- initialize credential-vault keys;
- keep final submission approval set to `always` during validation;
- back up profiles, state, vaults, and documents;
- run `npm run check` and the relevant deployment configuration check;
- submit a harmless test form before using a real application.

Continue with [Production deployment](deployment.md). For system design and security boundaries, read [Architecture](architecture.md) and [Configuration](configuration.md).

## 5. Run the agent loop

Configure the chosen agent runtime to run continuously or wake on a schedule. A cycle should first recover existing work by reading applications and confirmations, then scan configured sources, evaluate and request eligible applications, observe queued work for a bounded period, and leave unresolved items durable for the next cycle.

Do not implement reliability as one permanent chat turn or a shell loop that retries blindly. The runtime should use bounded polling, back off after infrastructure failures, avoid overlapping cycles for the same profile, and notify the person only when a new decision, failure, or verified submission needs attention. The server's deduplication and durable queues make separate scheduled invocations safe.

## What never belongs in Git

- `.env` and token maps
- `config/local.json`, `config/profiles.json`, and customized source settings
- `data/`, `private-documents/`, resumes, receipts, screenshots, and encrypted vaults
- personalized `sources.json` and `writing-style.json`

Run `npm run privacy:check` before every push.

## Connect an agent

The built-in `node bin/jobctl.js` client defines the reference operations for health, profile setup, discovery, applications, confirmations, and status tracking. It is useful for setup, testing, and manual recovery. A recurring agent should use the same bearer-authenticated operations through the reusable skill, by invoking `jobctl`, or by calling the HTTP API directly. Identity is always derived from its profile-bound token.

The repository exposes the skill at `.agents/skills/job-application`. If an operator uses OpenClaw, follow [OpenClaw integration](openclaw.md). OpenClaw is one adapter for the agent-first system, not a dependency of the core server.
