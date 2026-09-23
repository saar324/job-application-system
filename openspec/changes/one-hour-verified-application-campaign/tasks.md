The [readiness audit](../../../docs/one-hour-campaign-readiness.md) records evidence and remaining work for every item.
Checked boxes mean completed in the repository; they do not claim a production throughput result.

## 0. Baseline and release prerequisites

- [ ] 0.1 Merge and deploy the 23 September cross-source/receipt-URL duplicate fix from `codex/all-source-campaign`; verify production direct intake returns existing submitted IDs for RapidSOS, Wayflyer, and n8n without queueing a new application.
- [x] 0.2 Capture production configuration, deployed skill version, daily caps, browser runtime, and source catalog version. Record a rollback snapshot without copying profile files or credentials into Git.
- [x] 0.3 Add one campaign trace with privacy-safe timestamps, durations, source yield, model/tool calls, token counts, owner wait, worker phases, failed/blocked attempts, and verified receipt counts. Mark missing legacy data unknown.
- [ ] 0.4 Re-run a representative baseline and publish a stage waterfall for a fresh cohort. Calculate per-new-receipt wall time with duplicates and failures in the denominator of spent work; do not extrapolate from preselected forms alone.

## 1. Standing authorization and exception policy

- [x] 1.1 Define and validate versioned `StandingSubmissionPolicy` and `AutoSubmissionDecision` schemas, profile-bound storage, owner-only enable/widen/revoke API, agent read path, mode/source/destination scope, and campaign/daily caps. Enforce owner authority independently of the current agent-token profile PATCH route. Default remains `always` until an owner-enabled policy exists.
- [x] 1.1a Reconcile the existing `autoApply: false`, global daily cap 10, full-time cap 8, and campaign target maximum 50 with policy-covered intake. Require an explicit owner-selected cap up to 100 for a live 100-role test, count reserved final submissions rather than skipped/queued records, and test cap use across multiple campaign waves.
- [ ] 1.2 Implement one pre-final policy evaluator across campaign, direct, and ordinary applications. Bind the decision to current role key, destination, complete observed form fingerprint, answer provenance, uploads, and policy version; invalidate it on any material change. Issue a short-lived permit and recheck policy version, cap, and revocation immediately before final click.
- [x] 1.3 Remove unconditional `forceFinalApproval: true` from campaign selection when the policy covers the role. Keep exact fingerprinted final approval for uncovered forms and existing pending confirmations; do not auto-resolve old confirmations during migration.
- [ ] 1.4 Define typed holds for unknown applicant facts, unconfirmed legal attestations, compensation/availability conflicts, account/OTP/CAPTCHA, employer AI-use or authorship restrictions, ambiguous final controls, changed values, and uncertain prior submit actions. Enforce these holds independently of `requireConfirmationFor`; release the lane and ask only the missing item.
- [x] 1.5 Update the repository and installed job-application skill to honor the authenticated standing policy, including direct links and browser handoff; remove redundant per-role/batch approval requests only for covered forms. Verify skill and server policy agree after deployment.
- [ ] 1.6 Add authorization/state-machine regressions: agent token cannot enable or widen policy, unauthorized profile, revoked/expired/narrowed policy between decision and click, cap exceeded, changed preview, concurrent attempts, prior pending approval, legal answer with `requireConfirmationFor: []`, optional blank, and owner-selected `always` mode.

## 2. Reliable final browser path

- [ ] 2.1 Add a complete pre-final machine review: inventory across pages, deterministic field provenance, grounded prose, actual upload filename/size, persisted field readback, required/optional completeness, validation errors, and exact destination. Replace the worker's unconditional `drafted prose` approval trigger with the policy decision and hold unsupported claims.
- [ ] 2.2 Persist worker phase before the final action and fence uncertain outcomes. Reconcile late receipts or employer-side status before any retry; require a new pre-final decision after safe replay.
- [ ] 2.3 Reproduce the Ashby headless failures and visible-but-unpersisted LinkedIn/radio values on controlled fixtures and small live-compatible probes. Compare current headless Playwright with a supported regular-browser path for success, challenge, p50/p95, and tool/model cost.
- [ ] 2.4 Implement the most reliable compliant browser path per origin, with adapter flags and rollback. Do not bypass CAPTCHAs or repeat 403/429/spam-blocked attempts; hand off challenges and continue the queue.
- [ ] 2.5 Add browser regressions for multi-page Next versus Submit, conditional fields, upload persistence, changed form after policy decision, inline validation, lost worker response before/after final action, challenge handoff, and receipt false positives.

## 3. Suitable candidate supply

- [ ] 3.1 Turn the 50-source catalog into a scheduled bounded discovery loop with a durable reserve of new candidates, source-level request/page/detail limits, TTL and recency, and per-origin backoff. Keep one application agent and one submission lane.
- [ ] 3.2 Filter handled roles before expensive scoring or form preparation using stable ATS role IDs, normalized URLs, verified receipt URLs, and transactional role reservations; keep truly unattempted listings eligible.
- [ ] 3.3 Require a verified current employer application destination and reopenability check before preparation. Record why each candidate failed location, seniority, fit, authorization, closure, duplicate, or destination gates.
- [ ] 3.4 Add source health and yield diagnostics for empty feeds, parse changes, pagination exhaustion, access blocks, and missing employer destinations; repair high-yield broken adapters using fixture evidence. Investigate Jobfluent's destination gap without accepting aggregator-only links.
- [ ] 3.5 Test pagination, exact per-source accepted limit, dedup across sources and listing/application variants, expired jobs, 403/429 stop, challenge stop, and zero-candidate campaigns.

## 4. Fast preparation and queue operation

- [ ] 4.1 Reuse verified profile facts and employer-scoped approved answers. Build one typed answer plan per form step, send only unresolved eligible prose in a bounded evidence packet, and validate the returned fields and factual support.
- [x] 4.2 Keep a durable sequential queue with candidate reserve replacement. A held or uncertain role must not stop independent roles; only one external application tab and one final submission action are active at a time.
- [ ] 4.3 Remove repeated coordinator polling and per-field conversational steps in the common path. Use event-driven state transitions, batched server reads/writes, and compact status updates; count every model and tool round trip.
- [ ] 4.4 Test restart/replay, dynamic questions, stale answer reuse, provider timeout, unknown personal facts, invalid generated prose, and queue continuation after an exception.

## 5. Acceptance and rollout

- [ ] 5.1 Run syntax, unit, browser fixture, policy, privacy, and strict OpenSpec validation. Require zero known duplicate final actions, false receipts, unsupported applicant claims, unconfirmed legal answers, and cross-profile reads.
- [ ] 5.2 Run staging shadow auto-decisions against prepared forms without final clicks; manually audit every would-submit and would-hold result against the current manual policy.
- [ ] 5.3 Enable a small owner-opted-in live cohort with origin-specific rollback. Define and run a live answer/fit audit sample, verify each employer receipt, and compare field correctness, challenges, and manual holds against baseline.
- [ ] 5.4 Pass a fresh **10 new receipts in <=6 minutes** milestone and a fresh **25 in <=15 minutes** milestone, counting discovery/reserve maintenance, failed work, and receipt verification. Report supply shortage separately from speed.
- [ ] 5.5 Attempt the full **100 new suitable verified receipts in <=60 minutes** milestone only with sufficient eligible supply and within configured caps. Publish complete wall/active time and per-stage p50/p95, source yield, tokens, exception rate, and receipt evidence. Do not state the hour target is achieved until this passes.
- [ ] 5.6 Roll out by profile/origin flags with documented automatic rollback on duplicate final action, false receipt, unconfirmed attestation, privacy issue, or material challenge-rate increase; update operations and skill docs with the measured result.
