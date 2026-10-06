# Commands

Run `node {baseDir}/scripts/jobctl.js COMMAND [ID]`. Mutation payloads are JSON on standard input. Authentication binds the applicant; never include or read credentials in the conversation.

## Session and queue

- `health`, `profile`, `fit-context`, `session-context`: readiness, verified facts, contact details and current CV location.
- `queue`: ordered entries, current job, blocker, pending count and verified receipt count.
- `queue-add` or `direct`: `{ "url": "https://employer.example/job", "mode": "full_time" }`. Adds passive work. An existing opportunity can use `{ "opportunityId": "UUID" }`. Repeated links return the existing application. No form opens.
- `queue-next`: `{ "sessionId": "CURRENT_CHAT_ID" }`. Claims one job or returns the same current job. A blocker prevents advancement.
- `queue-checkpoint ID`: `{ "sessionId": "CURRENT_CHAT_ID", "kind": "captcha", "message": "Complete the visible CAPTCHA", "checkpoint": { "url": "https://employer.example/apply", "fields": [] } }`. Holds the entire session queue. Keep Chrome visible and wait.
- `queue-resume ID`: `{ "sessionId": "CURRENT_CHAT_ID", "resolution": "Owner supplied the missing fact in this chat" }`. Use only after owner help. Cannot resume an uncertain final action for another Submit.
- `queue-skip ID`: `{ "sessionId": "CURRENT_CHAT_ID", "reason": "Evidence-based reason" }`. For an uncertain outcome, also require the owner's explicit decision and `ownerStoppedPursuit:true`; the outcome remains unverified.

## Review and final action

`queue-review ID` accepts:

```json
{
  "sessionId": "CURRENT_CHAT_ID",
  "authorizationSource": "Owner request and standing delegation for routine review and submission",
  "preview": {
    "company": "Example",
    "title": "Engineer",
    "destination": "https://employer.example/apply",
    "officialPostingReviewed": true,
    "resumeUploaded": true,
    "fit": { "decision": "relevant", "reason": "Verified experience matches the core role" },
    "filled": [{ "key": "name", "label": "Name", "value": "Verified applicant name", "source": "saved profile", "required": true }],
    "unfilled": []
  },
  "fieldEvidence": []
}
```

List all safe live fields and unfilled optional fields. Required blanks stop review. For legal factual fields, use matching `saved_profile_fact` evidence with the exact complete question as `profileAnswerKey`. For approved recruitment privacy, retention or contact fields, use `saved_recruitment_consent` and the applicable current saved affirmative alias. Combined scopes use `profileAnswerKeys`, an array of up to three current saved aliases that cover every requested scope. Privacy approval cannot cover background checks or other legal commitments. Each evidence item has the exact field `key`, optional zero-based `step`, `sourceKind` and `sourceReference`. Generic Yes values cannot cover a legal commitment. New Terms, waivers or mixed commitments require owner help; do not infer approval.

After the owner answers a waiting question, `queue-resume` can record `ownerAnswers` with the exact field `key`, `label`, `value`, optional `step` and `sourceReference` pointing to the actual owner message. Do this only for input the owner supplied. The resulting application's `resolutions` array provides the zero-based index. Review that field with `sourceKind:"current_owner_answer"`, the matching `resolutionIndex` and the same `sourceReference`. This answer covers only that application's unchanged question and value. It survives an unrelated CAPTCHA pause. A newer owner answer to the same field supersedes it. Do not treat routine submission delegation as a new legal answer or copy this evidence to another application.

Save the returned `previewFingerprint`. Immediately before the final click, use `queue-submit-start ID` with `{ "sessionId": "CURRENT_CHAT_ID", "previewFingerprint": "RETURNED_HASH" }`. Save the returned `attemptId`. The action is one-use; repeating this command after final action began is an error, not permission to click again.

After explicit employer success, use `queue-receipt ID`:

```json
{
  "sessionId": "CURRENT_CHAT_ID",
  "attemptId": "RECORDED_ATTEMPT_UUID",
  "receipt": {
    "manuallyVerified": true,
    "finalUrl": "https://employer.example/thanks",
    "successText": "Exact observed employer confirmation",
    "observedAt": "ACTUAL_ISO_OBSERVATION_TIME",
    "visualReceiptHash": "SHA256_OF_SAVED_RECEIPT_SCREENSHOT"
  }
}
```

The receipt must match the recorded destination and attempt. Do not record simulated success or a pre-submit screenshot. A lost response does not prove failure: read queue state before doing anything else. An uncertain attempt stays held for outcome investigation.

## Owner submitted LinkedIn applications

`record-external-submission` records owner-provided LinkedIn success evidence on the server, with optional `jobUrl:null`. See [external-submissions.md](external-submissions.md). It does not operate a form, record an agent attempt, promote profile answers or advance the queue.

## Discovery and records

`sources`, `scan`, `query`, `filter` and `consider` preserve configured source selection and known-role filtering. Scans are review-only in this workflow. Use `consider` with a full `candidate`, evidence-based `fit` verdict and `apply:false` to review without queueing; relevant verified roles otherwise enter the passive queue. For unsupported employer forms, follow the official Apply link in Chrome and register the reviewed opportunity with `add`, then use `queue-add` with its ID. Do not mislabel a discovered role as owner-supplied.

`applications`, `application-log`, `application-metrics`, `backlog`, `handoff ID`, `config` and `standing-policy` read history or configuration. Backlog and handoff are historical inspection tools; they do not start forms. `profile-update` saves reusable short facts in `applicationAnswers`. Keep narrative prose in the current application's checkpoint and review.

`record-recruiter ID` and `record-employer-status ID` keep recruiter metadata, outreach drafts and verified employer updates. Neither sends a message. Recruiter records preserve verified contact fields; drafts remain `draft`. Do not invent missing contacts.

Automatic campaigns, approve-batch, final-approval buttons and server browser workers are retired from this interactive workflow. Do not use those paths to execute applications.

## Browser file and session recovery

For encrypted job-site accounts, read [accounts.md](accounts.md). `account-status ID` accepts `sessionId` and the observed HTTPS `origin` and returns only configured/available metadata. `account-download ID` accepts the same scope and writes a private, short-lived credential handoff for consumption inside `cua_repl`; never print its contents. `account-store ID` takes the same scope, an absolute `credentialFile` and explicit `storageAuthorization`; it saves an authorized existing password without overwriting another record. These commands neither operate the browser nor advance the application queue.

Use `resume-download /absolute/local/output.pdf` to retrieve the current authenticated resume to a new private local file for Chrome's file chooser. It never uploads a file or prints its contents. Verify that Chrome shows the actual uploaded CV before review.

For a confirmed live employer validation rejection, use `queue-validation-error ID` with `sessionId`, the current `attemptId`, `employerExplicitlyRejected:true` and the exact `errors` array. Repair only known answers, review the complete live form again and obtain a new final attempt. This path allows at most three known-rejected attempts; it cannot clear an uncertain result.

When the owner explicitly requests recovery in a new chat, use `queue-takeover ID` with the new `sessionId` and `ownerRecoveryReference`. It records the transfer, invalidates a pre-submit review and keeps a prior final action held for outcome inspection. Do not use it to race a still-working session.
