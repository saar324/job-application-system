# One-hour campaign production rollout, 23 September 2026

The branch artifact `5eec52c` was deployed to staging and then to the personal server. This is a functional rollout, **not** a measured claim of 100 verified applications per hour. The fresh 10, 25, and 100 receipt milestones remain open.

## Release and recovery

- Production API and worker run from `/opt/job-application-system-20260923-5eec52c`. Both were active, with zero restarts, after cutover. The API and worker health endpoints returned `ok` and the worker reported Chromium.
- The prior production release was `/opt/job-application-system-20260922-campaign-final`. A root-only rollback snapshot is at `/root/job-application-rollback-20260923`; it includes the previous service units and overrides, configuration, token and profile files, and a SQLite online backup. It is deliberately outside Git.
- The production configuration digest is `003fa82c49406656a881e8b82b04a3d1e33ad88cf6292eaf367bd4c5e273e568`. Its global and mode intake caps are set to 1,000,000; the owner profile's `0` preference does not lower them. Final actions under the standing policy have a separate 100 per day and 100 per campaign limit. The full-time fit threshold remains 75.
- The private 7-adapter and 43-browser-source catalog is `/etc/job-application/sources.json`, digest `a50cc639930524b919cc015c504f4d5cc8c41432e257ce05a6b6394a7e48ba06`. The source and credential files are readable only by their service account. The local installed skill was updated and validated. Saar's OpenClaw skill matches the deployed repository skill digest `4237fc0b92068fdadbfc2cb2ef5637968bbe9ab18266e1371ebfec519598e835`; Eva's skill and policy were untouched.

## Live checks

- The API and worker health checks passed after restart. Staging used the same commit and passed health checks. The local release check passed 271 tests, syntax, and repository privacy validation; strict OpenSpec validation passed.
- Production direct intake for existing **RapidSOS**, **Wayflyer**, and **n8n** submitted roles returned each original submitted application ID, set `duplicate: true`, and created no application record.
- An owner-only, profile-bound automatic policy version 1 is active for Saar's full-time verified Ashby, Greenhouse, and Lever applications, scoped to `jobs.ashbyhq.com`, `job-boards.greenhouse.io`, and `jobs.lever.co`. The daily and campaign caps are each 100. Direct and unverified browser roles, unknown facts, legal attestations, challenges, and changed forms still require review or a hold. The Saar agent can read the policy; Eva reads no policy. The owner credential is root-only at `/etc/job-application/owner-token` and is never stored in Git.
- The reserve service and timer units were installed and passed `systemd-analyze verify`. Their private environment and catalog were provisioned at `/etc/job-application/`. The official refresh service completed once in production and its 30-minute timer was enabled. It checked Ashby, Lever, and Greenhouse with 19 bounded requests, found 11 raw roles, filtered 26 handled records, and found **zero eligible new roles**. The daily browser timer remains disabled while the full staging catalog scan runs.

## Remaining acceptance work

The staging full-catalog no-submit scan was started as campaign `08aca8c9-58e9-46c0-9741-52d6c275503f`; record its completion and source yield before enabling daily browser maintenance. A live shadow review of would-submit/would-hold forms, origin comparison, candidate-supply repair, and fresh receipt milestones are still needed. Do not count preloaded reserve jobs as a fresh discovery-to-receipt speed trial.

Rollback uses the saved service overrides and prior immutable release. Revoke the standing policy to `always` before restarting the old worker if any duplicate final action, false receipt, unconfirmed attestation, or privacy issue appears. Preserve consumed permit and uncertain-action records for reconciliation.
