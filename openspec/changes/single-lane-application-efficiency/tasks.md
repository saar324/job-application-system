## 1. Deployment audit and baseline

Implementation note (2026-09-21): the local code and synthetic integration tests are complete for the core form, research, query, approval, and receipt paths. This checklist also includes production audit, benchmark, and live-pilot gates; unchecked items remain open until those are measured.

Verification update (2026-09-22): the release is deployed and a known stale employer posting correctly ended `skipped` without a receipt. A narrow 30-case synthetic form benchmark passed 30/30 on both release `9ab8a5d` and the upgraded worker in two runs, with the upgraded worker reducing p95 from about 1,154 ms to 411 ms but not median time. The authenticated metrics endpoint has only one new live worker-stage sample. The owner-approved real-form pilot, representative operational baseline, expanded fixture corpus, tool comparison, and history-wide private CI gate remain open. See `docs/application-efficiency-upgrade.md` for exact scope and timings.

- [x] 1.1 Confirm which repository, worker, and installed skill serve the owner; record versions and a migration path without copying private profile data into Git.
- [ ] 1.2 Instrument privacy-safe stage timings and call/token counts for started, blocked, failed, and verified applications; include coordinator tokens when available and distinguish unavailable from zero. Separate active time, queue time, owner wait, and source yield.
- [ ] 1.3 Capture a representative operational baseline and at least 30 synthetic/anonymized fixtures with expected fields, transitions, errors, and receipt outcomes.

## 2. Immediate review and submission correctness

- [x] 2.1 Replace clipped field summaries and the 3,500-character approval presentation with a complete private review artifact and numbered display parts when needed; hash the full canonical observed answers.
- [x] 2.2 Scope action selection to the active application form, distinguish Next/Review from final Submit, and stop on competing or ambiguous controls.
- [x] 2.3 Strengthen post-submit evidence so generic success text plus unrelated body changes cannot produce a receipt; retain uncertain-outcome manual review.
- [ ] 2.4 Add regressions for long prose, many fields, repeated labels across steps, multi-step approvals, changed replay values, simultaneous Next and Submit controls, final-click validation with a new review, and false success text.

## 3. Form inventory and deterministic planning

- [ ] 3.1 Add versioned `FormStep`, `Field`, and `AnswerPlan` schemas and batched native-control extraction, including current values, constraints, and option/group semantics.
- [ ] 3.2 Implement explicit alias matching with type/context checks, source provenance, browser validity checks, and ambiguous-match handoff. Add scoped approved-answer records and a conservative legacy-answer migration.
- [ ] 3.3 Add per-step signatures, cycle detection, conditional-field re-inventory, hidden-file-input support, and provisional ATS metadata support.
- [ ] 3.4 Add fixtures for first/family-name variants, referral-email confusion, scoped and legacy prior answers, disabled controls, custom widgets, files, and inaccessible frames.

## 4. Model work only for unresolved prose

- [ ] 4.1 Classify unresolved fields into owner facts/attestations, eligible original prose, optional blanks, and unsupported controls; honor employer AI-use and human-authorship restrictions before drafting.
- [ ] 4.2 Have the API stage a minimal `ApplicationEvidencePacket`; add a constrained in-attempt worker `DraftProvider` and a typed `needs_research` return for missing company context. Extend the webhook adapter/service with `waiting_research`, bounded replay, and deadline-aware error handling.
- [ ] 4.2a Define a worker phase/error contract: only a received typed pre-final response may safely report a draft timeout; lost responses and interrupted `submitting` attempts remain uncertain until durable proof of phase exists. Test timeout before drafting finishes, timeout after final click, and server recovery during both phases.
- [ ] 4.2b Add attempt-status and durable-receipt reconciliation for lost responses. Fence an uncertain application until the previous worker run has ended and the employer outcome has been checked; test a worker that completes after the client's 180-second deadline and a retry requested before it finishes.
- [ ] 4.3 Request one typed JSON draft batch per step, validate field IDs, evidence, length, factual claims, and cost; allow one targeted revision.
- [ ] 4.4 Test unsupported claims, changed questions, prompt injection, context minimization, provider failure/timeout, company-research replay and state transitions, owner-answer reuse, and the new-prose owner-approval state transition.

## 5. Fill, navigation, and fresh-context recovery

- [x] 5.1 Apply planned values with fresh locators, read every live value back, and detect native and inline validation errors.
- [x] 5.2 Replace fixed sleeps with bounded event-driven transitions while keeping final receipt verification independent.
- [ ] 5.3 Keep in-attempt step checkpoints; add a bounded versioned checkpoint to typed pause responses, propagate it through adapter errors, and persist it atomically with the server's blocker/research/review transition. Reopen and reconstruct from the start in a fresh context, then compare the complete preview before approved submission.
- [ ] 5.4 Test missing required fields after Next, dynamic questions, back navigation, popups, restart, session-dependent forms, and ambiguous final outcomes.

## 6. Source-query interface

- [x] 6.1 Add adapter `describe()` capabilities and a typed, bounded multi-query `SearchPlan` endpoint/MCP tool with profile-bound authorization, configured-board allowlists, scan-cycle idempotency, and request budgets.
- [ ] 6.2 Distinguish provider-side filters from local filters; discover exact case-sensitive filter values where needed; coalesce board-wide fetches. Implement documented Lever and Himalayas queries while retaining board-wide Greenhouse and Ashby fetches where their public endpoints lack those query options.
- [ ] 6.3 Exclude Ashby `isListed: false` results from autonomous discovery; fetch Greenhouse questions only after shortlisting; recheck live role eligibility and source attribution requirements.
- [ ] 6.4 Add a browser-source fixture harness only for a high-yield source without an adequate feed, with rate limits, challenge stop, change detection, and versioned diagnostics. Keep LinkedIn user-controlled.
- [ ] 6.5 Add source health reports and a repair protocol that checkpoints active work before a single agent updates an adapter.

## 7. One-agent operating model and tool evaluation

- [x] 7.1 Add bounded batch handoff, exact per-application fingerprinted consolidated approval, and per-application stateless model packets while keeping one active application agent and one external tab.
- [x] 7.2 After fresh-context replay tests pass, update the repository skill and installed deployment skill to reuse one sequential application agent rather than creating a fresh one for each role.
- [ ] 7.3 Screen Playwright CLI/MCP, Codex visible browser, Stagehand v3, and Browser Use on a small common fixture set; benchmark viable finalists against the existing Playwright library on the full corpus and publish measured time, tokens, reliability, privacy, and integration cost.
- [ ] 7.4 Run syntax, unit, browser, policy, privacy, and strict OpenSpec checks; publish baseline and owner-approved live-pilot comparison before enabling production flags.
