# Commands

Resolve the CLI from the installed skill:

```bash
JOBCLI="node {baseDir}/scripts/jobctl.js"
```

Common operations:

```bash
$JOBCLI health
$JOBCLI me
$JOBCLI profile
$JOBCLI fit-context
$JOBCLI fit-context freelance
$JOBCLI scan
$JOBCLI filter
$JOBCLI consider
$JOBCLI sources
$JOBCLI opportunities
$JOBCLI applications
$JOBCLI application-log
$JOBCLI application-metrics
$JOBCLI campaigns
$JOBCLI inbox
```

For the primary agent-led workflow, collect unseen raw candidates from a bounded server-adapter scan. Review
their fit with the agent before opening any form. Repeat per source and increase the pool or use a query when needed:

```bash
printf '%s' '{"sources":["ashby"],"reviewOnly":true,"limitPerSource":100}' | $JOBCLI scan
```

For a visible-browser source, pass its extracted page candidates to `filter` before model review:

```bash
printf '%s' '{"items":[{"source":"sample_board","title":"Platform Developer","company":"Sample Company","description":"Build an API service","applyUrl":"https://jobs.ashbyhq.com/demo/11111111-1111-4111-8111-111111111111/application"}]}' | $JOBCLI filter
```

After reading the role and profile, send one fit verdict. `relevant` verifies the current official ATS posting and
queues a normal application unless `apply:false`; `irrelevant` durably skips the role; `uncertain` does neither.
When the official posting differs, review the returned official candidate and decide again:

```bash
printf '%s' '{"candidate":{"source":"ashby","title":"Platform Developer","company":"Sample Company","description":"Build an API service","applyUrl":"https://jobs.ashbyhq.com/demo/11111111-1111-4111-8111-111111111111/application"},"fit":{"decision":"relevant","reason":"Responsibilities and required skills match the verified profile."},"apply":true,"idempotencyKey":"fit-demo-11111111"}' | $JOBCLI consider
```

The older score-first campaign command is retained for historical reports and compatibility. It deterministically excludes handled roles and listings without an
employer application destination, then prepares the target plus reserve sequentially. Covered official ATS roles follow
the owner standing policy; uncovered roles wait for exact final-preview review:

```bash
printf '%s' '{"target":10,"reserve":10,"idempotencyKey":"campaign-2026-09-22-01"}' | $JOBCLI campaign-start
$JOBCLI campaign-status CAMPAIGN_UUID
```

For an all-source campaign, pass the catalog's server adapter IDs in `sources` and visible-browser IDs in
`fallbackSources`, with `limitPerSource:10`. Submit each browser source only after bounded pagination is finished:

```bash
printf '%s' '{"target":10,"reserve":10,"limitPerSource":10,"sources":["ashby","lever","greenhouse"],"fallbackSources":["example_board"],"idempotencyKey":"all-source-campaign-01"}' | $JOBCLI campaign-start
printf '%s' '{"sourceId":"example_board","items":[],"pagesVisited":3,"requestsMade":12,"exhausted":true,"completed":true,"idempotencyKey":"all-source-campaign-01-example-board"}' | $JOBCLI campaign-add-source CAMPAIGN_UUID
```

The private catalog is authoritative; the short example lists are placeholders. The server caps accepted candidates at
10 per source, tracks coverage and paging telemetry, waits for every fallback source, then ranks the combined pool before
preparing applications.

Campaign targets up to 50 use the normal limit. A target from 51 to 100 requires an active owner-issued standing policy
for the campaign mode whose `dailyCap` and `campaignCap` both meet the requested target. The policy is set only through
the owner-authenticated `PUT /v1/standing-submission-policy` API. An agent profile update cannot grant that authority.
The default global and mode daily caps still apply to uncovered and manual applications. Policy-covered final actions
reserve a cap slot before Submit; unused reservations expire, and consumed attempts count across campaign waves.

The status response includes scan, preparation, approval-wait, submission, and worker-active timing; every ready
review entry includes the company, role, destination, full presentation, application ID, and preview fingerprint.
`scan.fitReviewCandidates` lists a bounded set of strong but uncertain roles excluded from automatic selection.
These have no queued application. Inspect current employer eligibility, salary evidence, and the complete role before
manually promoting one; a search title or model opinion does not override a verified hard exclusion.
For entries awaiting exact review, submit only after the owner explicitly approves the exact entries shown:

```bash
printf '%s' '{"idempotencyKey":"campaign-approval-2026-09-22-01","entries":[{"applicationId":"APPLICATION_UUID","previewFingerprint":"64_HEX_CHARACTERS"}]}' \
  | $JOBCLI campaign-approve CAMPAIGN_UUID
```

For each recurring cycle, use this order:

1. `health` and `profile`;
2. `applications` and `inbox` to recover durable work;
3. `scan` and evidence-based opportunity evaluation;
4. `add`/`apply` for eligible work;
5. bounded `applications`/`inbox` observation before yielding.

The external agent runtime schedules the next cycle. Do not implement an unbounded shell polling loop, overlap cycles for one profile, or repeat a mutation after an ambiguous timeout.

`application-log` joins each durable application with its opportunity. It reports the company, role, URLs, status, timestamps, receipt, and structured questions with answers. Credential-like values are redacted.

`application-metrics` returns profile-bound aggregate attempt counts and p50/p95 queue, execution, owner-wait, and worker-stage durations. Every duration includes a sample count; unavailable token counts are `null`, not zero.

After the owner or agent verifies a submission in an external browser, record the result and any form answers:

```bash
printf '%s' '{"manuallyVerified":true,"finalUrl":"https://company.example/application/complete","company":"Example","title":"Example Role","questionsAndAnswers":[{"field":"work_authorization","question":"Are you authorized to work here?","answer":"Yes"}]}' \
  | $JOBCLI record-submission APPLICATION_ID
```

Use this only after the site shows reliable submission evidence. Never include passwords, tokens, or one-time codes. The server redacts credential-like values if they are supplied by mistake.

If a final preview is found incomplete before owner approval, supersede only that pending preview and queue a fresh inspection. Supply verified corrections or relevant optional answers in `answers`; this does not approve or submit the application:

```bash
printf '%s' '{"answers":{"portfolio_url":"https://example.test/portfolio"}}' \
  | $JOBCLI refresh-preview APPLICATION_ID
```

Record an employer-side status without changing the application's submission state:

```bash
printf '%s' '{"status":"assessment","observedAt":"2026-09-15T08:00:00Z","source":"email","sourceId":"gmail-message-id","subject":"Assessment invitation","sender":"recruiting@example.com","note":"Complete within one week"}' \
  | $JOBCLI record-employer-status APPLICATION_ID
```

Allowed statuses are `application_received`, `under_review`, `action_required`, `awaiting_response`, `assessment`, `interview`, `rejected`, `withdrawn`, `offer`, `hired`, and `closed`. Process evidence oldest to newest. The server rejects older evidence and treats the same `sourceId` as idempotent.

Store profile facts supplied by the active owner:

```bash
printf '%s' '{"contact":{"firstName":"...","email":"..."},"skills":["..."]}' | $JOBCLI profile-update
```

Submission authority is read from the owner-issued standing policy. Ordinary `profile-update` preferences cannot enable
automatic final submission or raise the configured daily caps. The default is exact final-preview approval.

Never add an `id` or `profileId`; authentication selects the profile.

Scan configured full-time sources, or explicitly select freelance mode:

```bash
printf '%s' '{}' | $JOBCLI scan
printf '%s' '{"mode":"freelance"}' | $JOBCLI scan
```

Start from a URL sent by the owner:

```bash
printf '%s' '{"url":"https://company.example/jobs/apply","mode":"full_time"}' | $JOBCLI direct
```

The server creates the direct opportunity, deduplicates it, and queues browser preparation. Poll applications/inbox rather than sending the URL again.

Add a discovered opportunity:

```bash
printf '%s' '{"title":"Engineer","company":"Example","applyUrl":"https://example.com/apply","source":"company_site","score":88,"mode":"full_time"}' | $JOBCLI add
```

Request application. Omit `mode` to keep the opportunity/default mode:

```bash
printf '%s' '{"answers":{}}' | $JOBCLI apply OPPORTUNITY_ID
```

The request persists and returns `queued` before browser work finishes. Poll `$JOBCLI applications` for the final status; do not repeat the apply command after a timeout.

Resolve a confirmation only after receiving the owner's answer:

```bash
printf '%s' '{"answers":{"question_key":"owner answer"}}' | $JOBCLI confirm CONFIRMATION_ID
$JOBCLI reject CONFIRMATION_ID
```

Handle an inline Telegram callback exactly as received:

```bash
$JOBCLI callback 'jobapp:CONFIRMATION_UUID:choose:0'
$JOBCLI callback 'jobapp:CONFIRMATION_UUID:approve'
$JOBCLI callback 'jobapp:CONFIRMATION_UUID:custom'
```

`custom` leaves the confirmation pending. After the owner types an answer, pass the field from the confirmation as JSON to `confirm`. Existing site credentials use `site_username` and `site_password`; never print either value after the call.

For a manual-review confirmation, approve with `{"answers":{"retry":true}}` only when a retry is safe. If the owner verifies that the site already submitted, use `{"answers":{"submitted":true,"finalUrl":"...","externalId":"..."}}` instead. Treat a `submitted` receipt with `simulated: true` as a test result, never as a real application.

Run bounded source queries only after inspecting `sources`. A scan-cycle key can be reused only for an identical plan; use a new cycle ID for a fresh search:

```bash
printf '%s' '{"source":"ashby","scanCycleId":"cycle-2026-09-21","idempotencyKey":"ashby-engineering-1","queries":[{"filters":{"title":"Engineer"},"limit":50}]}' | $JOBCLI query
```

If a result has `applicationBlockedBySource: "employer_application_url_required"`, its
`applyUrl` is still the Himalayas listing. Verify the employer's application URL before
calling `direct` with that URL, and retain the Himalayas listing for attribution. Do
not retry a listing-page browser challenge as though it were an application form.

When an application is `waiting_research`, verify a public official company page and attach a short relevant excerpt. The same agent then resumes the queued application:

```bash
printf '%s' '{"url":"https://company.example/about","excerpt":"Official company description relevant to the question.","officialSourceConfirmed":true}' | $JOBCLI research APPLICATION_ID
```

After the owner explicitly approves the exact complete previews listed in a batch, submit their IDs and fingerprints together. Other pending questions must be resolved first:

```bash
printf '%s' '{"entries":[{"applicationId":"APPLICATION_UUID","previewFingerprint":"64_HEX_CHARACTERS"}]}' | $JOBCLI approve-batch
```
