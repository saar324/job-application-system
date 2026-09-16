---
name: job-application
description: Search, record, review, and submit full-time or freelance opportunities through the private Job Application Server. Use when the user asks to find work, apply, inspect application status, or answer a pending application question.
metadata: {"openclaw":{"emoji":"💼","requires":{"bins":["node"]}}}
---

# Job Application

Use the server as the source of truth for opportunities, applications, confirmations, and submission receipts. Run `node {baseDir}/scripts/jobctl.js` for every operation. The installed skill contains its own profile-bound credential; never print or read that credential into the conversation.

## Workflow

1. Run `jobctl profile`. Ask only for fields listed as missing, then store supplied facts with `jobctl profile-update`. Use `full_time` unless the user or stored opportunity selects `freelance`.
2. For job discovery or source selection, read [references/sources.json](references/sources.json). Search and score opportunities using only evidence from the listing and the profile. Do not invent skills, dates, work authorization, compensation, rates, or identity facts.
3. When the owner sends an application URL, immediately pass it to `jobctl direct` with the requested mode. Do not require them to provide title, company, or score. For discovered jobs, add qualifying opportunities and request application normally.
4. A successful application request normally returns `queued`. Use `jobctl applications` to observe its later `submitted` or `waiting_confirmation` state; never repeat the apply request because a client stopped waiting.
5. If the state is `submitted`, report the receipt. If it is `waiting_confirmation`, run `jobctl inbox`. In Telegram DMs, send the confirmation's `presentation` through the `message` tool so its buttons are native inline buttons. The final-approval presentation must be sent in full, including every filled and unfilled field.
6. If any application question does not have a clear, verified answer in the saved profile, resume, portfolio, or prior confirmed answers, stop before selecting or entering an answer. Ask the profile owner the question as written and do not submit while it is unresolved. After the owner answers, store any reusable fact in `applicationAnswers` with `jobctl profile-update`, then continue the current form using that exact confirmed answer.
7. Approve a confirmation only after the profile owner supplies the answer. Pass their answers through standard input as JSON.
8. When Telegram sends `callback_data: jobapp:...`, pass only that callback value to `jobctl callback`. If it returns `needs_typed_answer`, ask the owner to type the answer; then resolve the named field with `jobctl confirm CONFIRMATION_ID`.
9. After a submission is verified and its receipt is recorded, close that external application tab. Keep tabs open when an application is waiting, blocked, or not submitted unless the owner asks to close them.
10. During a multi-application batch, do not stop the batch when a CAPTCHA appears. Complete every safe field first, keep the application tab open, record it as waiting for CAPTCHA, and immediately continue with the next application. After all non-CAPTCHA applications are finished, return to the CAPTCHA tabs with the owner for one fast human-action pass. Never solve a CAPTCHA or close a CAPTCHA-blocked tab before the owner completes it or asks to close it.

When an application needs original prose, read [references/writing-style.json](references/writing-style.json) before drafting or filling it. Review the complete application for accuracy, fit, grammar, and empty required fields. Show or summarize the final reviewed content and request approval at the final submission step. After the owner approves that specific application, submit it and verify the success page or receipt.

For an `account_credentials` custom answer, check the encrypted profile vault for a credential bound to the current HTTPS origin before creating an account. Reuse the existing account when present. Create a managed credential only when no matching account exists, then store it in the vault for later applications. If owner-supplied credentials are required, ask for `site_username` and `site_password` in the private owner chat, warn that Telegram retains message history, and send them once to `jobctl confirm`. The server never stores passwords in application state. Prefer the generated managed-account button when offered. Never echo a password or include it in a later message.

Never handle another profile by changing a request parameter. Profile identity comes exclusively from `JOB_SERVER_TOKEN`. Never expose tokens, passwords, CV contents, or one profile's history in another chat.

## Visible browser handoff

When the owner uses LinkedIn to choose jobs, treat every `linkedin.com` page as user-controlled: open or preserve the requested tab, but do not click, type, scroll, or navigate there unless the owner explicitly changes that instruction. Wait for the owner to open the employer or ATS application page, then work only on that external destination.

The source catalog distinguishes server adapters from public boards that require visible-browser discovery. Do not pass a browser-only source ID to `jobctl scan`. LinkedIn is excluded from every autonomous source list.

On an external application page, fill repeatable contact and link fields from the saved profile, then review the visible values. Pause for any unknown fact, legal attestation, verification step, or résumé upload that was not explicitly requested. In a batch, defer CAPTCHAs using step 10 instead of pausing the whole batch. Never click the final submission control without the owner's explicit approval for that application. After approval, click the final control and verify the result. Keep the current form available for manual corrections or takeover.

Read [references/commands.md](references/commands.md) when constructing commands or request payloads.

When asked to reconcile applications from email, read and follow [references/email-reconciliation.md](references/email-reconciliation.md). Review the complete requested date range, match conservatively, record employer-side statuses through the server, and keep actionable or ambiguous messages unread unless the owner explicitly asks otherwise.
