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

### Optional reserve refresh timers

`deploy/systemd/job-application-reserve-refresh.{service,timer}` and
`job-application-browser-reserve.{service,timer}` are opt-in templates. The deployment script does not install or enable
them. The official timer uses a profile-bound agent token to refresh only configured Ashby, Greenhouse, and Lever feeds;
the browser timer runs a no-submit campaign against the private source catalog. Both share a lock, and browser sites
retain their per-host request, page, delay, and 403/429/challenge limits.

Before installing either timer, create a private `/etc/job-application/reserve.env` containing `JOB_SERVER_URL` and a
profile-bound `JOB_SERVER_TOKEN`. Provision the private catalog at the path used by the browser unit and confirm the
service user can read it and launch Playwright. The checked-in units use the conventional `jobapp-api` user and
`/opt/job-application-system`; hosts with an immutable release path or a different account must override `User`,
`Group`, `WorkingDirectory`, `EnvironmentFile`, and `ExecStart`. On the current personal-server layout, inspect
`systemctl cat job-application-server.service` first and adapt the units to its `myos` account and active release path.
The sample catalog and reserve environment paths are not provisioned there yet.

For `personal-server`, use the opt-in files in `deploy/systemd/personal-server/` instead of the conventional-user
templates. They specify `User=myos` and share a persistent lock through `StateDirectory`. Before copying them into
`/etc/systemd/system`, replace `REPLACE_WITH_TESTED_RELEASE` in both services with the absolute immutable release
directory shown by the active server unit's `WorkingDirectory`. Repeat that check at each release switch; a timer
pointing at an older release will keep running older code. Never enable a unit with the placeholder still present.
Copy `reserve.env.example` to the private `/etc/job-application/reserve.env`, replace its token placeholder with a
profile-bound agent token, and set mode `0600` with owner `myos`. Provision a private source catalog at
`JOB_SOURCE_CATALOG` and give `myos` read access before considering the browser timer. These files do not currently
exist on `personal-server`; the templates are deliberately not installed or enabled.

For rollout, first run the two `--reserve-only` commands manually against staging with that profile and catalog. Check
their source health, 403/429/challenge stops, request totals, reserve counts, and zero application records. Then run
`systemd-analyze verify` on the substituted service and timer files, test each service once with
`systemctl start`, and inspect its journal without printing credentials. Enable only the official timer initially.
The official timer covers configured Ashby, Greenhouse, and Lever server adapters, not all 50 catalog sources. Enable
the browser timer only after its no-submit scan succeeds within the site budgets; its daily schedule cannot keep a
45-minute reserve continuously fresh. To roll back a timer, disable and stop its timer and service, then restore the
prior immutable release path or remove the copied unit. Existing reserved roles still require independent freshness
verification before any final action.

Run each no-submit command manually with the intended private token, verify source health and HTTP 403/429 handling,
then install the adapted unit and timer files and enable them separately. Do not enable the browser timer before its
browser runtime, catalog, private environment, and measured request budget pass staging validation. A timer failure
does not authorize a submission or turn stale reserve entries into fresh candidates.

## Upgrades and recovery

Back up `/var/lib/job-application`, `/etc/job-application`, private applicant documents, and external OpenClaw reference files. Run `npm run check` on the candidate revision, deploy, then verify health, profile binding, credential isolation, and worker authentication before enabling discovery or live submission.

Before the first SQLite upgrade, stop the API and run the importer in dry-run mode. Deployment sets `JOB_SERVER_DATABASE=/var/lib/job-application/state.sqlite`; while the legacy import marker is absent, startup transactionally imports `state.json` and leaves a timestamped backup. An empty database file left by an interrupted startup is safe to resume; a non-empty unmarked database that differs from the JSON is rejected instead of overwritten. Verify the `/health` storage kind and schema version, opportunity/application/confirmation counts, queued recovery, and one simulation flow before live work. Rollback consists of stopping the service, retaining the failed database for diagnosis, restoring the pre-migration JSON backup, removing or relocating the new SQLite file, and starting the previous release.

Keep semantic enrichment and adaptive execution disabled during the storage migration. Enable them separately only after deterministic operation, telemetry redaction, and fixture evaluations pass.
