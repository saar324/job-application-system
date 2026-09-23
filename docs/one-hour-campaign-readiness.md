# One-hour campaign readiness audit

This audit covers the branch implementation, not a production result. `tasks.md` checks only work that is complete in
the repository. A passing fixture or simulation does not establish live receipt throughput. The September 23, 2026
audit found no basis to claim 10 receipts in six minutes, 25 in fifteen minutes, or 100 in one hour.

| Task | Audit result | Evidence or remaining work |
| --- | --- | --- |
| 0.1 | Open | Merge and deploy the cross-source receipt URL fix, then verify RapidSOS, Wayflyer, and n8n direct intake against production state. |
| 0.2 | Open | Capture production config, deployed skill, caps, browser runtime, source catalog, and a private rollback snapshot during cutover. No secrets or profile files belong in Git. |
| 0.3 | Complete in code | `workflow.stage` and `workflow-report` record safe stages, measured and unknown time/cost fields, source yield, holds, and verified receipts. Model/tool token data remain `null` where unavailable. |
| 0.4 | Open | Run a fresh representative cohort and publish its discovery-to-receipt waterfall, including duplicates and failures. |
| 1.1, 1.1a | Complete in code | Owner-only versioned policy, cap accounting and 100-target reconciliation have authorization and multi-wave tests. No owner policy has been enabled by this branch. |
| 1.2 | Partial | Final decision/commit validates current policy, role, form fingerprint, answer provenance and caps. The network-to-click interval after commit remains a revocation race; commit is the authorization point. Live form and upload coverage still needs shadow audit. |
| 1.3 | Complete in code | Covered roles no longer receive unconditional campaign final approval; uncovered and prior confirmations retain exact review. |
| 1.4 | Partial | Legal, unknown fact, challenge, employer restriction, and uncertain-action paths hold in fixtures. An exhaustive live question/consent taxonomy and owner review of every hold are pending. |
| 1.5 | Open | Repository skill was updated and validated. The installed skill and deployed server policy have not been synchronized or compared. |
| 1.6 | Partial | Authorization regressions cover agent mutation, cross-profile access, revocation, caps, forged role metadata, changed previews, legal variants, concurrent attempts and the crash window. The full enumerated live policy matrix has not been shadow-audited. |
| 2.1 | Partial | Worker inventories steps, reads back values, checks uploads and validation, and submits a bounded draft packet. Semantic factual support for generated prose still requires live answer audit. |
| 2.2 | Partial | Worker records phase and fences consumed permits and uncertain actions; late receipts are reconciled in tests. Employer-side status reconciliation before a new attempt is still an operator task. |
| 2.3 | Open | Fixtures reproduce delayed radio/LinkedIn persistence and reject false success; headed Chromium has a staged flag. Comparable live Ashby headless/headed success, challenge, p50/p95 and token/tool cost data are absent. |
| 2.4 | Partial | Exact-origin headed flag and headless rollback exist. A best compliant path per origin awaits staged evidence; 403/429 and challenge paths stop. |
| 2.5 | Partial | Browser fixtures cover multi-page, conditional fields, upload/readback, changing forms, validation, uncertain results, challenges and false receipts. A live-compatible end-to-end ATS fixture matrix remains to run. |
| 3.1 | Partial | Official refresh and no-submit browser reserve modes are bounded and durable. Opt-in timers are templates, not installed; the official timer covers only server adapters and daily browser scans do not provide continuous coverage. |
| 3.2 | Partial | Stable ATS IDs, URL and receipt aliases and transactional dedup filter handled roles. Existing unattempted opportunities outside the reserved pool can still be excluded as already known, so full eligible recall is unproven. |
| 3.3 | Partial | Exact official ATS identity is independently verified and refreshed for standing authority. Other browser destinations remain manual; employer reopenability and every rejection reason need live audit. |
| 3.4 | Partial | Source health separates empty/blocked/parse/destination/handled outcomes. Repair of high-yield broken adapters and Jobfluent's destination investigation remain. |
| 3.5 | Partial | Pagination, accepted limit, duplicate, stale role, rate-limit, challenge and zero-result fixtures exist. Cross-source live catalog coverage and application-variant cases need a full catalog run. |
| 4.1 | Partial | Owner-approved employer answer reuse has scope/fingerprint/expiry checks; one typed answer plan sends only unresolved prose to the provider. Generated prose receives evidence-ID checks, but not a complete semantic proof of factual support. |
| 4.2 | Complete in code | Durable one-lane campaign selection and replacement after holds have queue/restart tests. |
| 4.3 | Partial | Server transitions and batch reads reduce coordinator turns. Total tool calls and coordinator tokens remain unknown; the common live path has not been measured. |
| 4.4 | Partial | Restart, dynamic, stale-answer, timeout, missing fact, invalid evidence and continuation fixtures exist. A deployed replay drill is pending. |
| 5.1 | Partial | Syntax, unit, browser fixture, policy, privacy, strict OpenSpec and skill checks can pass locally. Zero live duplicate actions, false receipts, unsupported claims, unconfirmed legal answers and cross-profile reads must be verified in staging. |
| 5.2–5.6 | Open | Shadow decisions, owner-opted live cohort, 10/25/100 fresh-receipt milestones, measured rollout and automatic rollback thresholds have not been executed. |

## Staged release and rollback

1. Merge the branch, take a private production snapshot, record the active immutable release and installed skill digest,
   deploy to staging, and run the full suite against the release artifact. Validate profile binding and policy `always`
   as the starting state. Use the exact same tested artifact for production cutover.
2. Keep standing authorization disabled while shadowing final decisions. Audit every would-submit and would-hold
   preview, destination, upload and answer against the manual result. Investigate mismatches before owner opt-in.
3. Run one small owner-opted-in live cohort, initially on one verified official ATS origin. Count a success only after
   employer receipt verification. Track legal/unknown holds, challenge rate and false receipt rate. Expand by origin only
   after measured correctness. Keep direct and unverified browser roles on exact approval.
4. For any duplicate final action, false receipt, unconfirmed legal attestation or privacy leak, revoke the policy to
   `always`, stop the application lane, preserve receipts and attempt markers, and restore the previous immutable
   release after triage. A material challenge-rate increase also disables that origin flag. Do not clear consumed
   permits or retry uncertain forms during rollback.
5. Reserve timers have independent opt-in rollout. Disable and stop their units to roll back discovery maintenance;
   this does not authorize stale roles. See [deployment](deployment.md) for the personal-server templates and private
   files. Fresh speed claims must include maintenance, failed work, owner waits and receipt checks; reports with a
   preloaded reserve are explicitly ineligible for the fresh end-to-end milestone.

Current acceptance blockers are production cutover/snapshot, installed-skill synchronization, staging shadow audit,
live ATS browser comparison, verified candidate supply across the catalog, provider/tool-cost accounting, and fresh
10/25/100-receipt trials within explicit owner caps. These require staged or live evidence and cannot be closed by
additional unit tests alone.
