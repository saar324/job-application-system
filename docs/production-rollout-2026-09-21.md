# Production rollout record — 2026-09-21

## Result

The personal server now runs the 2026-09-21 application-efficiency release for both the API and browser worker. Both systemd services are active with zero restarts at the final health check. The API reports SQLite schema version 2 and the webhook adapter. The worker reports Chromium health and the authenticated attempt-status route responds.

The repository defaults remain simulation-only. Production retains the existing profile-bound credentials, private applicant files, source preferences, and `submissionApproval: always`. Global execution concurrency was set to one. The optional draft endpoint was not enabled. No real application was submitted during this rollout.

## Deployment and recovery

- The API and worker use the same versioned release under `/opt`.
- The SQLite database and previous JSON state remain in the service's private data directory, with an additional pre-migration backup.
- The exact previous code, service units, environment files, profile configuration, receipts, and stopped-state snapshot were retained in a root-only backup directory. Its exact path is recorded in the private cutover log.
- Systemd drop-ins select the versioned release; removing those drop-ins and restarting both services restores the previous code. Preserve or export SQLite state before any rollback after new production writes.

The first cutover attempt exposed root ownership on the newly imported database. Its rollback restored the previous services, and the corrected cutover changed database ownership to the API service account before startup. The second cutover passed health and state checks.

## Verification

| Check | Result |
| --- | --- |
| Server-side syntax and browser/unit tests | 136 passed, 0 failed |
| Live JSON migration dry run | Validated all relationships |
| Copied-state migration | Exact JSON equality for opportunities, applications, confirmations, and audit records |
| Final stopped-state migration | 1,454 opportunities; 1,710 applications; 4,702 confirmations; 13,552 audit records; exact equality |
| Isolated API simulation | Health, queue, and simulated receipt passed |
| Isolated worker using production Chromium | Health and attempt-status route passed |
| Authenticated production API | Health, profile, source descriptors, and application counts passed |
| Remote agent skills | Both profile-bound installations updated; private tokens, URLs, source catalogs, and writing references unchanged |
| Production services | API and worker active; zero restarts at final check |

The previous ATS adapters contained curated boards in code. The new release requires private board configuration, so the existing five Ashby boards, five Greenhouse boards, and two Lever sites were moved into the production-only config. Staging queries against one board per source returned HTTP 200 without adapter errors. A bounded four-source scan found 109 postings and seven qualified results; a second three-source scan found 150 postings and no qualified results. These runs used isolated staging state and did not apply for jobs.

## Baseline and pilot

The historical state has 460 submitted applications, of which 445 have manual verification receipts and 15 have worker or other receipts. Created-to-receipt timestamps have a 45-minute median and a 6,943-minute 95th percentile across the 460 records. Those intervals include human waiting and do not measure active agent time or token use. They cannot establish a throughput improvement against the owner's eight-hour estimate.

A fresh staging search and current official-posting review did not yield a new suitable role that was both unapplied and above the saved compensation floor. An existing pending final approval was also below the saved hourly floor. These were left untouched. The first real-application pilot therefore remains pending; it needs a suitable current role and the owner's approval of that application's complete preview before final submission. Record active stage time, model calls/tokens, manual handoffs, correctness, and verified receipt for each pilot application.
