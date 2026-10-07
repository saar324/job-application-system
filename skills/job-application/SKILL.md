---
name: job-application
description: Coordinate two search agents and apply through one interactive Codex internal browser session, with a durable ordered queue, verified applicant facts, submission receipts, and immediate pauses for owner help.
---

# Job Application

Use one session with the owner in the Codex internal browser. Keep the owner's Chrome independent. For an active search-and-apply request, this main session manages exactly two search and draft subagents. They claim separate sources, prepare structured answer drafts and append passive jobs during a 20/30 refill cycle; only this session fills, reviews and submits applications. Read [search-workers.md](references/search-workers.md) for synchronization, daily source resets, buffer thresholds and worker prompts. Read [application-drafts.md](references/application-drafts.md) for the one-packet review and fill workflow. Do not create parallel form workers or server background campaigns. Use `node {baseDir}/scripts/jobctl.js` to save and retrieve state; the server is the source of truth for the queue, answers, history and receipts. Never read or print the installed profile credential.

## Start and recover

Run `health`, `profile`, `fit-context` and `queue`. Use `session-context` for the authenticated applicant's contact details, links, document paths and saved answers. Keep private facts out of user-facing output. Read [applicant-facts.md](references/applicant-facts.md) and saved owner facts and corrections before relying on older CV text. The profile readiness response does not contain the actual answers.

Use the current chat ID as `sessionId` in queue actions. Recover the current application before taking another job. An open tab is not durable state. Keep its checkpoint, non-secret answers and outcome evidence on the server. If a previous final action may have run, check the employer outcome before any further Submit action.

## Owner LinkedIn confirmations

When the owner pastes a LinkedIn “Application submitted” confirmation, call `record-external-submission` immediately, including when no URL is supplied. The server log must succeed before saying the dashboard will count it. Read [external-submissions.md](references/external-submissions.md) for evidence, deduplication and historical answers. A private archive alone does not update the dashboard. Keep listings and review screens separate from confirmed sends. This passive logging does not resolve or advance the current application blocker.

## Queue and search

Save each new owner URL immediately with `queue-add` (or `direct`). New messages can add links while this session searches, applies or waits. Record duplicates without creating another attempt. Appending links does not interrupt the current application or resolve its blocker. Process the queue in recorded order. Do not start a second application while the current one needs owner help or an outcome check.

Read `references/sources.json` for configured sources and filters. When its autonomous lists are empty, use `references/public-sources.json`. Preserve source settings, location and compensation preferences. Search workers use public discovery tools and leased server feeds. This main chat uses the internal browser for application forms. LinkedIn remains user-controlled unless the owner explicitly changes that instruction. Respect source limits, manual-only entries and 403/429/challenge stops. An application challenge stops the session; do not route around it.

Server source retrieval remains available through `sources`, `scan` with `reviewOnly:true`, `query` and `filter`. Read the full official listing before judging fit. Review responsibilities, core skills, seniority, location and work authorization, compensation and employer quality. Unknown bonus skills alone do not disqualify a suitable role. Do not invent mandatory qualifications. A relevant `consider` verdict verifies the official destination and adds passive queue work; `apply:false` records review without adding work. For an unsupported official destination, save the reviewed opportunity and add its `opportunityId` to the queue. Never label a discovered role as owner-supplied.

Use `search-control` before spawning or resuming the two workers and after queue consumption or additions. Start a refill at 20 or fewer pending jobs, continue until 30, then stop workers. New jobs append at the bottom with tentative draft packets. Process queued applications while these workers refill from exclusive ranked source leases. Daily Europe/Sofia resets reopen the source priority order without clearing job history. Discovery runs only within the active authorized session. Read [search-workers.md](references/search-workers.md); do not create a schedule.

## Apply in Chrome

For sign-in or registration, read [accounts.md](references/accounts.md). Check the encrypted, applicant and origin bound vault before asking the owner for credentials. Reuse a saved login through the private browser handoff. Never create or reset a password, accept new Terms or complete a CAPTCHA autonomously. An account-access blocker can be resolved by a verified saved login without another owner question; keep all other queue holds intact.

1. Call `queue-next` with this chat's `sessionId`. Use one session-owned Chrome application tab and reuse it for the current job. Preserve owner-owned tabs. Follow the official Apply link to the employer's actual application form.
2. Load `queue-draft ID` once to get the draft, current verified facts and freshness metadata. Inspect the live form, correct the packet before insertion, save `queue-draft-review ID`, and use the pure JSON fill planner from [application-drafts.md](references/application-drafts.md). Check genuine missing facts before asking the owner. Draft review does not replace the later live review or establish legal consent. Review fit and the current posting. Fill contact details, links and verified facts. Upload the verified current CV. Retrieve prior answers with `scripts/find-prior-answer.js` before asking the owner to repeat a fact. Reuse factual answers only when meaning, jurisdiction, contract type and circumstances still match. Owner corrections override stale history. Keep narrative answers application-specific.
3. Read `references/writing-style.json` before writing prose. Ground each material claim in verified applicant, job and company evidence. Respect employer bans on AI-written answers. Save safe answers and provenance in checkpoints.
4. Review the complete live form, including every filled and unfilled field, custom controls, the actual CV upload, role and destination. Routine final review and submission are delegated to this session during an owner-requested application or search. Do not ask the owner to say “I approve” for each form. Record the session as reviewer and the actual owner delegation as authorization, not personal owner review of an unseen form.
5. Save the exact preview with `queue-review`. Call `queue-submit-start` with the returned fingerprint immediately before the final click. This records a one-use attempt and checks capacity and changed facts. Inspect the live form again if it changed; review the new preview before requesting a final action. A button containing “Review and Submit” can be final.
6. Click Submit once. Read the result and check field errors. Save a receipt only when the employer explicitly confirms receipt of this application. Record its final URL, success text, observation time and screenshot hash through `queue-receipt`. A click, permit, filled form or queued role is not a receipt.
7. After a verified receipt, close the session-owned application tab and take the next queued role. Preserve history and recruiter metadata. If a recruiter is known, save a grounded follow-up draft; do not send outreach without an explicit request.

## Stop and wait

For a CAPTCHA, genuinely missing or conflicting fact, uncovered legal commitment, account action or tool-required permission: save a `queue-checkpoint`, leave the current Chrome form visible, ask the owner only for what is needed, and stop. Do not open another application, choose a replacement or defer the question to a batch-end backlog. Search-only workers may continue passive discovery and enqueue without clearing the hold or using the application tab. New links may still be recorded while waiting.

Check saved answers and applicable recruitment consent before treating a fact or permission as missing. Matching authorized email verification can be completed in the same application, without saving or echoing the code. Never solve CAPTCHAs. Legal attestations require verified applicable owner evidence; routine submission delegation does not approve new Terms, marketing or other commitments. Tool-specific permission and account requirements still apply.

After owner help, record the resolution and use `queue-resume`. Verify the live values and complete form before submission. Keep the active tab open while waiting; close it when the application completes, the owner explicitly skips it, or the owner ends the session. If the tab is lost, rebuild from the checkpoint and recheck every live value.

An uncertain final action holds the queue. Do not repeat Submit because a timeout, restart or lost tab occurred. Investigate saved evidence and matching employer correspondence. Record a receipt only with proof. If the owner explicitly abandons an uncertain attempt, record the outcome as unverified, never “not submitted.”

## Evidence and privacy

Preserve profile isolation, deduplication, daily caps, scoped legal consent and final-action checks. Do not change an applicant by supplying `profileId`; authentication binds the profile. Never log credentials, cookies, verification codes or authentication tokens. Use only safe values in previews and checkpoints. Reconcile prior applications conservatively and preserve historical answers.

For a requested count, count only new verified employer receipts from this request. Report the current application and actual blocker when waiting. Keep counts for queued, submitted and skipped roles distinct. Do not claim market exhaustion from a bounded search pass.

Read [commands.md](references/commands.md) for payloads and recovery commands. Read [efficient-batches.md](references/efficient-batches.md) for sequential queue execution. Read [email-reconciliation.md](references/email-reconciliation.md) only when asked to reconcile employer email.

## Owner completes Submit before an attempt is registered

Inspect the employer result first. If the owner supplies an explicit employer receipt for the exact current role, record `queue-owner-receipt` with its real confirmation text/hash, message reference, final URL, observation time and Sofia submission date. This separate owner-reported send counts once and completes that queue entry. Never create a retrospective agent attempt or request the already-completed privacy action again. Never use the LinkedIn import for a Greenhouse or other browser confirmation. Keep agent/legacy uncertain attempts on their existing exact-attempt receipt path. See [commands.md](references/commands.md).
