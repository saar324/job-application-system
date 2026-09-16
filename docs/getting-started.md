# Getting started

Choose the smallest setup that matches your goal.

| Goal | Setup |
| --- | --- |
| Inspect the system safely | Local simulation with authentication disabled |
| Use multiple private profiles without browser submission | Authenticated simulation |
| Submit through Chromium | Docker Compose or systemd production deployment |

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

Copy `config/default.json` to ignored `config/local.json`, set `JOB_SERVER_CONFIG=./config/local.json`, and enable only reviewed source IDs. Employer-specific Ashby, Greenhouse, and Lever boards belong under `discovery.sourceOptions` in this private file. The repository intentionally ships with empty source selections.

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

## What never belongs in Git

- `.env` and token maps
- `config/local.json`, `config/profiles.json`, and customized source settings
- `data/`, `private-documents/`, resumes, receipts, screenshots, and encrypted vaults
- personalized `sources.json` and `writing-style.json`

Run `npm run privacy:check` before every push.
