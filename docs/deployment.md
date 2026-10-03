# Deployment

Run one API service. The owner chat operates Chrome. There is no server browser worker, campaign runner or reserve timer.

Back up private profiles, tokens, source configuration, SQLite and résumé files before upgrading. Keep them out of Git. Run `npm run check` first.

## Docker Compose

Copy `.env.example` and `config/production.example.json` to ignored private deployment files. Put profiles and profile-bound tokens in `data/`, and résumés in `private-documents/`. Document paths must use their container location. Run `docker compose up --build -d`. The API listens on host loopback port 4310.

## Systemd

Prepare `/etc/job-application/env`, `/etc/job-application/config.json`, `/var/lib/job-application/profiles.json` and `/var/lib/job-application/tokens.json`. Set `JOB_SERVER_ALLOWED_DOCUMENT_ROOTS` to the narrow private résumé directory. Run `sudo ./scripts/deploy-systemd.sh`. It disables the retired worker, retains private state, installs the API, migrates profile settings as the owning account and starts only the API.

On an existing immutable-release host, stop discovery/application execution before switching. Check that the former worker has no active form or verification session. Back up unit files. Point the API at the tested release. Remove worker dependencies from its unit and disable retired worker and reserve timers. Keep old runtime/state backups for rollback; do not delete historical receipts or browser evidence.

Verify `/health` reports `chrome_session`, authenticated queue reads are profile-bound and retired worker/campaign mutation routes return 410. Check application counts and source/profile hashes. If checks fail, restore the prior code and units immediately. This queue rollout adds payload fields only; it does not drop or rename database columns. Rollback changes code, not existing SQLite records.

Install the client skill after service validation. Preserve its private sources, writing style and credential. Keep the SSH tunnel to loopback available. Do not publish the API or grant broader access.
