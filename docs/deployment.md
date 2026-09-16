# Production deployment

The repository supports Docker Compose and hardened systemd services. Complete the local simulation first, keep all files listed below out of Git, and back them up before upgrades.

## Docker Compose

Prepare the private instance:

```bash
cp .env.example .env
cp config/production.example.json config/local.json
mkdir -p data/artifacts data/receipts private-documents
cp config/profiles.example.json data/profiles.json
```

Then:

1. Replace every placeholder in `data/profiles.json`. Document paths must use their container location, such as `/app/private-documents/resume.pdf`.
2. Put resumes and cover letters in ignored `private-documents/`.
3. Create `data/tokens.json` with a long random bearer token mapped to each fixed profile ID.
4. Run `node scripts/init-vault-keys.js data/profiles.json data/vault-keys.json`.
5. Set `APPLICATION_WORKER_TOKEN` in `.env` to a long random value.
6. Set `WORKER_ALLOWED_DOMAINS` in `.env` for any reviewed employer-specific domains.
7. Run `docker compose config` locally to validate the file. Its output can contain resolved secrets, so do not paste, log, or commit it.
8. Start with `docker compose up --build -d`.

The API binds to host loopback. The worker receives only staged documents through a dedicated volume; it cannot read profiles, API tokens, state, or original document roots. Chromium uses a private shared-memory allocation rather than the host IPC namespace.

## Systemd

The deployment script targets a conventional Linux host and creates dedicated `jobapp-api` and `jobapply-worker` users.

Prepare these files before running it:

```text
/etc/job-application/env
/etc/job-application/config.json
/var/lib/job-application/profiles.json
/var/lib/job-application/tokens.json
```

Use `.env.example`, `config/production.example.json`, and `config/profiles.example.json` as templates. In `/etc/job-application/env`, set:

- identical long random values for `APPLICATION_WEBHOOK_TOKEN` and `WORKER_TOKEN`;
- `JOB_SERVER_ALLOWED_DOCUMENT_ROOTS` to a narrow absolute directory containing applicant documents;
- `WORKER_ALLOWED_DOMAINS` to reviewed employer domains in addition to built-in ATS hosts.

Then run:

```bash
sudo ./scripts/deploy-systemd.sh
```

The script normalizes all runtime paths, fixes private-file ownership before migration, copies root-owned code to `/opt/job-application-system`, installs Chromium, generates per-profile vault keys, splits API and worker environments, and starts the worker before the API.

OpenClaw installation is deliberately separate. Provision each applicant only after API authentication and worker health are verified.

## Upgrades and recovery

Back up `/var/lib/job-application`, `/etc/job-application`, private applicant documents, and external OpenClaw reference files. Run `npm run check` on the candidate revision, deploy, then verify health, profile binding, credential isolation, and worker authentication before enabling discovery or live submission.
