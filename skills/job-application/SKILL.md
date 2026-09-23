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
3. Scan configured sources, evaluate results from listing and profile evidence, and request eligible applications within policy limits. For a comprehensive campaign, use the all-source pool below.
4. Observe newly queued applications for a bounded period. Never repeat an apply request because polling ended or a transport call timed out.
5. Report new verified submissions and actionable blocks, then yield. Leave queued, blocked, and waiting-confirmation work on the server for the next cycle.

Do not overlap cycles for the same profile or start a new application sub-agent for each role. One reusable application agent processes one application at a time with a bounded per-role packet; the server owns durable resume, deduplication, approval fingerprints, and receipts. Close the external application tab at every pause or completed outcome and reconstruct it in a fresh context on resume. Back off after infrastructure failures, but do not retry an uncertain final submission. The hosting agent runtime owns scheduling and wakeups.

## Workflow

1. Run `jobctl profile`. Ask only for fields listed as missing, then store supplied facts with `jobctl profile-update`. Use `full_time` unless the user or stored opportunity selects `freelance`.
2. For job discovery or source selection, read [references/sources.json](references/sources.json). Run `jobctl sources` to see enabled source filters, then use bounded `jobctl query` plans where useful. Search and score opportunities using only evidence from the listing and the profile. Do not invent skills, dates, work authorization, compensation, rates, or identity facts.
3. When the owner sends an application URL, immediately pass it to `jobctl direct` with the requested mode. Do not require them to provide title, company, or score. For discovered jobs, add qualifying opportunities and request application normally.
4. A successful application request normally returns `queued`. Use `jobctl applications` to observe its later `submitted` or `waiting_confirmation` state; never repeat the apply request because a client stopped waiting.
5. If the state is `submitted`, report the receipt. If it is `waiting_research`, obtain bounded official company context for the recorded question, then attach its URL and excerpt with `jobctl research ID`. If it is `waiting_confirmation`, run `jobctl inbox`. In Telegram DMs, send every text block in the confirmation's `presentation` through the `message` tool and then its buttons. The final-approval presentation must show every filled and unfilled field and every non-secret answer in full.
6. If any application question does not have a clear, verified answer in the saved profile, resume, portfolio, or prior confirmed answers, stop before selecting or entering an answer. Ask the profile owner the question as written and do not submit while it is unresolved. After the owner answers, store any reusable fact in `applicationAnswers` with `jobctl profile-update`, then continue the current form using that exact confirmed answer.
7. Approve a confirmation only after the profile owner supplies the answer. Pass their answers through standard input as JSON.
8. When Telegram sends `callback_data: jobapp:...`, pass only that callback value to `jobctl callback`. If it returns `needs_typed_answer`, ask the owner to type the answer; then resolve the named field with `jobctl confirm CONFIRMATION_ID`.
9. Close the external application tab after every completed or paused attempt. The server persists a checkpoint; the next attempt reconstructs the form in a fresh context. Never treat an abandoned tab as the durable state.
10. During a multi-application batch, checkpoint a CAPTCHA or other owner blocker, close that tab, and continue with the next application. Return to blocked applications one at a time after the owner can act. Never solve a CAPTCHA.

When an application needs original prose, read [references/writing-style.json](references/writing-style.json) before drafting or filling it. Use only relevant verified job, company, and applicant evidence. Review the complete application for accuracy, fit, grammar, and empty required fields. An active owner-issued standing policy may permit grounded prose and final submission for a verified official ATS role after the server's final decision and commit checks. If the role, destination, answer class, or form falls outside that policy, obtain exact approval for the complete preview. A prepared manual-review batch may be approved once with `jobctl approve-batch` only when the owner's explicit approval names every application ID and complete-preview fingerprint. Submit sequentially and verify each receipt.

For an `account_credentials` custom answer, check the encrypted profile vault for a credential bound to the current HTTPS origin before creating an account. Reuse the existing account when present. Create a managed credential only when no matching account exists, then store it in the vault for later applications. If owner-supplied credentials are required, ask for `site_username` and `site_password` in the private owner chat, warn that Telegram retains message history, and send them once to `jobctl confirm`. The server never stores passwords in application state. Prefer the generated managed-account button when offered. Never echo a password or include it in a later message.

Never handle another profile by changing a request parameter. Profile identity comes exclusively from `JOB_SERVER_TOKEN`. Never expose tokens, passwords, CV contents, or one profile's history in another chat.

## All-source campaign pool

When the owner asks for a comprehensive search or a measured application batch, create one campaign containing every
configured `serverAdapters` source and every `visibleBrowserSources` source from the private catalog. The campaign must
collect candidates before it opens application forms:

1. Ask each source for at most 10 new eligible roles. A server adapter uses `limitPerSource: 10`. A browser source follows
   pagination until it has 10 accepted roles, reaches the real end, or reaches the source safety budget.
2. Exclude every canonical role already present in opportunities or applications, including submitted, skipped, rejected,
   failed, and still-active records. Deduplicate again after an aggregator resolves to an employer ATS URL.
3. Search browser sources one at a time. Default safety limits are five result pages, 35 detail pages, 45 navigations, and
   at least 1.5 seconds between navigations to the same host. Stop that source on HTTP 403, 429, or a challenge page and record the outcome.
   Do not bypass login, CAPTCHA, access controls, or a catalog instruction that requires manual use.
4. Send each browser source result through `jobctl campaign-add-source CAMPAIGN_ID`, including pages visited, requests made,
   exhaustion, and rate-limit state. Mark a source complete only after its pagination work is finished or a recorded policy,
   access, or rate-limit outcome prevents further work.
5. Finish every planned source. The server keeps at most 10 candidates per source, ranks the combined pool globally, and only
   then prepares the campaign target plus reserve sequentially. Early sources cannot consume the application quota.

Use one browser context and one application worker. Never create one agent per source or per application.

## Visible browser handoff

When the owner uses LinkedIn to choose jobs, treat every `linkedin.com` page as user-controlled: open or preserve the requested tab, but do not click, type, scroll, or navigate there unless the owner explicitly changes that instruction. Wait for the owner to open the employer or ATS application page, then work only on that external destination.

The source catalog distinguishes server adapters from public boards that require visible-browser discovery. Do not pass a browser-only source ID to `jobctl scan`. LinkedIn is excluded from every autonomous source list.

On an external application page, fill repeatable contact and link fields from the saved profile, then review the visible values. Pause for any unknown fact, legal attestation, verification step, or résumé upload that was not explicitly requested. In a batch, defer CAPTCHAs using step 10 instead of pausing the whole batch. A verified official ATS role covered by an active owner standing policy may pass the server's final permit and commit checks without another owner approval. This includes a browser-discovered role only when the server has independently fetched and verified its exact current official ATS board, role, and destination. Direct links, unverified browser roles, and any uncovered or changed form require exact owner approval for that application. After the authorized final action, verify the result. Keep the current form available for manual corrections or takeover.

Read [references/commands.md](references/commands.md) when constructing commands or request payloads.

When asked to reconcile applications from email, read and follow [references/email-reconciliation.md](references/email-reconciliation.md). Review the complete requested date range, match conservatively, record employer-side statuses through the server, and keep actionable or ambiguous messages unread unless the owner explicitly asks otherwise.
