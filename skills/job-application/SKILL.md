---
name: job-application
description: Run recurring job-discovery and application cycles, submit full-time or freelance opportunities, inspect durable status, and resolve pending applicant questions through the Job Application Server. Use for scheduled job-search loops and direct application requests.
metadata: {"openclaw":{"emoji":"💼","requires":{"bins":["node"]}}}
---

# Job Application

Use the server as the source of truth for opportunities, applications, confirmations, and submission receipts. Run `node {baseDir}/scripts/jobctl.js` for every operation. The installed skill contains its own profile-bound credential; never print or read that credential into the conversation.

## Recurring cycle

Treat each scheduled or continuous invocation as one bounded cycle, not as a permanent chat turn:

1. Check `health` and `profile`, then inspect `applications` and `inbox` before discovering new work.
2. Surface new confirmations or failures that need the owner. Do not repeat notifications for unchanged items.
3. Collect unseen candidates from configured sources, review fit with the agent using listing and profile evidence, and pass relevant roles through `jobctl consider`. Use the agent-led flow below.
4. Observe newly queued applications for a bounded period. Never repeat an apply request because polling ended or a transport call timed out.
5. Report new verified submissions and actionable blocks, then yield. Leave queued, blocked, and waiting-confirmation work on the server for the next cycle.

Do not overlap cycles for the same profile or start a new application sub-agent for each role. One reusable application agent processes one application at a time with a bounded per-role packet; the server owns durable resume, deduplication, approval fingerprints, and receipts. Close the external application tab at every pause or completed outcome and reconstruct it in a fresh context on resume. Back off after infrastructure failures, but do not retry an uncertain final submission. The hosting agent runtime owns scheduling and wakeups.

## Workflow

1. Run `jobctl profile`. Ask only for fields listed as missing, then store supplied facts with `jobctl profile-update`. Use `full_time` unless the user or stored opportunity selects `freelance`. Before calling an application unfinished or asking the owner to repeat an answer, check its application log, prior confirmed answers and conversation, and any earlier browser receipt for the same role. If a prior success page proves a manual submission while the server was offline, reconcile it with `record-submission`; do not reopen or resubmit the form. A stale pending confirmation does not override a verified receipt.
2. For job discovery or source selection, read [references/sources.json](references/sources.json). When its autonomous source lists are empty, use the public starter at [references/public-sources.json](references/public-sources.json). Run `jobctl fit-context` for the profile-bound facts used in model fit review and `jobctl sources` for enabled source filters. Search broadly enough to find a useful pool. Use `jobctl scan` with `reviewOnly:true` for server adapters and `jobctl filter` for browser-source results; these remove known roles before model review. Do not invent skills, dates, work authorization, compensation, rates, or identity facts.
3. When the owner sends an application URL, immediately pass it to `jobctl direct` with the requested mode. For discovered jobs, read the complete listing and saved profile, then call `jobctl consider` with `relevant`, `irrelevant`, or `uncertain` and a short evidence-based reason. A relevant decision verifies the current official ATS posting and queues application preparation; a skipped role is filtered on future searches. If the official employer posting differs, review its returned content and decide again. Do not label an agent-selected role as `userRequested`.
4. A successful application request normally returns `queued`. Use `jobctl applications` to observe its later `submitted` or `waiting_confirmation` state; never repeat the apply request because a client stopped waiting.
5. If the state is `submitted`, report the receipt. If it is `waiting_research`, obtain bounded official company context for the recorded question, then attach its URL and excerpt with `jobctl research ID`. If it is `waiting_confirmation`, run `jobctl inbox`. In Telegram DMs, send every text block in the confirmation's `presentation` through the `message` tool and then its buttons. The final-approval presentation must show every filled and unfilled field and every non-secret answer in full.
6. Before asking for an application answer, run `node {baseDir}/scripts/find-prior-answer.js "Company" "Question"` and review its same-employer candidates from the application log. Also check the saved profile, resume, portfolio, and prior owner messages. Compare the meaning of each candidate; a high text-similarity score is a lead, not approval. Reuse an exact previously submitted answer only when the owner has authorized that reuse and its facts and role scope still fit. Store reusable short facts in `applicationAnswers` with `jobctl profile-update`; keep prose in the current application's answer or an owner-approved, employer-scoped answer record. Do not put motivation, project, cover-letter, or other narrative prose in generic `applicationAnswers`. If no clear, verified answer exists, ask the owner the question as written and do not submit while it is unresolved. If the employer prohibits AI-written answers, use only wording known to be written by the owner; a prior submission alone does not establish authorship.
7. Approve a confirmation only after the profile owner supplies the answer. Pass their answers through standard input as JSON.
8. When Telegram sends `callback_data: jobapp:...`, pass only that callback value to `jobctl callback`. If it returns `needs_typed_answer`, ask the owner to type the answer; then resolve the named field with `jobctl confirm CONFIRMATION_ID`.
9. Close the external application tab after every completed or paused attempt. The server persists a checkpoint; the next attempt reconstructs the form in a fresh context. Never treat an abandoned tab as the durable state.
10. During a multi-application batch, checkpoint a CAPTCHA or other owner blocker, close that tab, and continue with the next application. Return to blocked applications one at a time after the owner can act. Never solve a CAPTCHA.

When an application needs original prose, read [references/writing-style.json](references/writing-style.json) before drafting or filling it. Use only relevant verified job, company, and applicant evidence. Review the complete application for accuracy, fit, grammar, and empty required fields. An active owner-issued standing policy may permit grounded prose and final submission for a verified official ATS role after the server's final decision and commit checks. If the role, destination, answer class, or form falls outside that policy, obtain exact approval for the complete preview. A prepared manual-review batch may be approved once with `jobctl approve-batch` only when the owner's explicit approval names every application ID and complete-preview fingerprint. Submit sequentially and verify each receipt.

For an `account_credentials` custom answer, check the encrypted profile vault for a credential bound to the current HTTPS origin before creating an account. Reuse the existing account when present. Create a managed credential only when no matching account exists, then store it in the vault for later applications. If owner-supplied credentials are required, ask for `site_username` and `site_password` in the private owner chat, warn that Telegram retains message history, and send them once to `jobctl confirm`. The server never stores passwords in application state. Prefer the generated managed-account button when offered. Never echo a password or include it in a later message.

Never handle another profile by changing a request parameter. Profile identity comes exclusively from `JOB_SERVER_TOKEN`. Never expose tokens, passwords, CV contents, or one profile's history in another chat.

## Agent-led discovery and application

For a measured batch, read every configured server adapter and visible browser source in the private catalog, or the public starter when there is no private catalog. Keep one agent and one application worker.

1. For each server adapter, request a bounded pool with `jobctl scan` and `reviewOnly:true`. Start with up to 100 unseen raw results per source, then paginate or use another query when the source exposes more. The returned candidates have not passed a fit score; no form is opened.
2. For each browser source, follow its real pagination until enough potentially relevant unseen roles are collected, the source ends, or its safety budget is reached. Use `jobctl filter` on a page's extracted candidates before sending listing text to the model. Default safety limits are five result pages, 35 detail pages, 45 navigations, and at least 1.5 seconds between navigations to the same host. Stop on HTTP 403, 429, or a challenge. Respect manual-only catalog entries and never bypass access controls.
3. Review candidate batches as an LLM using the saved profile and job evidence; open the full listing when the returned excerpt is incomplete. Decide whether each role is relevant, irrelevant, or uncertain. Consider actual responsibilities, skills, seniority, location/work authorization, compensation, and employer quality. Titles and numeric scores can help prioritize what to read, but cannot make the fit decision. Keep up to 10 relevant roles per source for the application pool; continue searching if fewer than 10 qualify.
4. Send every decided role through `jobctl consider`; it stores irrelevant decisions for future deduplication. A relevant role gets official destination verification after fit review. An unresolved destination stays pending, and a changed official role comes back for another review. Never use `jobctl direct` to promote an agent-found role.
5. Work through relevant verified roles sequentially. The browser worker fills known fields, holds unknown facts, checks the complete form, and uses the existing final permit/receipt path. Nikita's “Review and Submit Application” action is final, even when its label also contains “Review.” Count only verified new receipts in timing and quality reports.

The old score-first `campaign-start` path remains for compatibility and historical reports, but it is not the default for a new application batch. Its low yield does not prove there are no suitable jobs.

## Visible browser handoff

When the owner uses LinkedIn to choose jobs, treat every `linkedin.com` page as user-controlled: open or preserve the requested tab, but do not click, type, scroll, or navigate there unless the owner explicitly changes that instruction. Wait for the owner to open the employer or ATS application page, then work only on that external destination.

The source catalog distinguishes server adapters from public boards that require visible-browser discovery. Do not pass a browser-only source ID to `jobctl scan`. LinkedIn is excluded from every autonomous source list.

On an external application page, fill repeatable contact and link fields from the saved profile, then review the visible values. Pause for any unknown fact, legal attestation, verification step, or résumé upload that was not explicitly requested. In a batch, defer CAPTCHAs using step 10 instead of pausing the whole batch. A verified official ATS role covered by an active owner standing policy may pass the server's final permit and commit checks without another owner approval. This includes a browser-discovered role only when the server has independently fetched and verified its exact current official ATS board, role, and destination. Direct links, unverified browser roles, and any uncovered or changed form require exact owner approval for that application. After the authorized final action, verify the result. Keep the current form available for manual corrections or takeover.

Read [references/commands.md](references/commands.md) when constructing commands or request payloads.

When asked to reconcile applications from email, read and follow [references/email-reconciliation.md](references/email-reconciliation.md). Review the complete requested date range, match conservatively, record employer-side statuses through the server, and keep actionable or ambiguous messages unread unless the owner explicitly asks otherwise.
