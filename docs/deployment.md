# Production deployment

The repository supports Docker Compose and hardened systemd services. Both require private configuration before launch.

## Docker Compose

Create `.env`, `config/local.json`, and `config/profiles.json`; generate a long `APPLICATION_WORKER_TOKEN`; then review mounted paths before running:

```bash
docker compose up --build -d
```

The API binds to host loopback and reaches the worker only on the private Compose network.

## Systemd

The deployment script targets a conventional Linux host and creates dedicated `jobapp-api` and `jobapply-worker` users.

1. Create `/etc/job-application/env` from `.env.example` with production paths and secrets.
2. Put the private profile document at `/var/lib/job-application/profiles.json` with mode `0600`.
3. Set `JOB_SERVER_CONFIG` to a private production config and `JOB_SERVER_ALLOWED_DOCUMENT_ROOTS` to the narrow applicant-document directory.
4. Run `sudo ./scripts/deploy-systemd.sh`.

The script copies code to `/opt/job-application-system`, installs production dependencies and Chromium, splits API and worker environment files, initializes profile vault keys, installs the units, and starts the worker before the API.

OpenClaw integration is deliberately separate. Provision each applicant after the service is healthy with `scripts/bootstrap-openclaw.js`.

## Upgrades

Back up `/var/lib/job-application` and `/etc/job-application` before deployment. Do not copy those directories into the repository. Run `npm run check` on the candidate revision, deploy, then verify health, profile binding, and worker authentication before enabling discovery.
