# Thirty-second end-to-end application throughput

## Decision and measurement

Target **ten new, suitable, verified submissions in at most five minutes of wall time**, starting with a fresh source scan and ending at the tenth employer receipt. The target is an average of 30 seconds per submission, not a promise that every individual form finishes in 30 seconds. Count every search, suitability check, model call, form preparation, review, approval wait, failed attempt, browser fallback, and receipt check inside that clock. Report attempted, blocked, rejected, and submitted roles separately. Keep one coordinating application agent and one sequential submission lane.

The 22 September pilot took 11,078 seconds for ten verified submissions. Three gaps consumed 10,484 seconds (**94.6%**): 8,419 seconds before the first receipt, 1,349 seconds before the second, and 717 seconds between HTTPie and Cyberhaven. They include discovery, debugging, and waits, so they are not clean stage samples. The last four receipt gaps averaged 69 seconds each for already prepared forms. The updated Playwright worker needed 7.77 seconds of active time to submit HTTPie. The narrow synthetic benchmark prepared forms in about 0.35 seconds median. This evidence points first to coordination, candidate supply, exceptional form handling, and uncertain receipts, not to Playwright's click speed. These are inferences from the pilot, not a controlled browser comparison.

## Proposed campaign flow

1. **One fresh structured scan.** Fetch configured employer ATS feeds concurrently, filter handled role IDs before ranking, reject closed or geographically ineligible postings, and retain a candidate reserve. Greenhouse job-board GET is public but application POST needs an employer API key; Lever provides public postings and hosted apply URLs; Ashby provides a public postings feed. Use these feeds for discovery and the hosted employer form for submission. Do not send an agent through search-result clicks for supported sources.
2. **One batch suitability pass.** Apply hard rules for location, work authorization, title, compensation, and known exclusions. Use a bounded model call only for ambiguous fit among the remaining candidates. Emit evidence for every selected role, including the exact current official posting. If fewer than ten suitable unapplied roles exist, report the shortage; do not lower the bar to meet a speed target.
3. **Prepare sequentially without per-field chat.** The worker inventories each live form, fills verified fields, reads them back, and builds one complete answer plan. Reuse scoped, confirmed facts. Send all novel company-specific prose questions in one batch model request with the listing and relevant applicant evidence. Reject unsupported claims. Unknown personal facts, legal attestations, human-authorship requirements, and challenges remain exceptions.
4. **One exact batch review.** Present every prepared role with its employer, destination, material answers, required uploads, and caveats. Approval binds to the complete preview fingerprint for each role. The single reply authorizes only those named previews. Continue preparing other roles while exceptions await an answer; never let one blocked form stop the batch.
5. **One submission lane.** After approval, submit prepared roles one at a time, wait for an explicit employer success signal, record the receipt, and move on. If a final action is uncertain, fence that role and use a reserve candidate. Do not retry a possibly submitted form blindly. Route anti-bot challenges to a human; do not try to disguise automation or solve CAPTCHAs.

## Timing budget to test, not assume

| Stage for a ten-role batch | Budget |
| --- | ---: |
| Fresh ATS scan, deduplication, eligibility, and shortlist | 35 s |
| Live form preparation and bounded question drafting | 100 s |
| Exact batch review and owner response | 60 s |
| Sequential final submissions and receipts | 90 s |
| Recovery buffer | 15 s |
| **Total** | **300 s** |

The owner-response budget cannot be guaranteed by software. Measure it explicitly. A CAPTCHA, login, or missing applicant fact can consume the entire buffer; record the miss and continue with reserve candidates. The first implementation goal is a reliable five-minute campaign on a cohort with ten available suitable postings, not a speed claim based on prefilled forms.

## Build order

1. **Campaign trace first:** issue a campaign ID and timestamps for scan, shortlist, each form start/end, draft call, batch review, owner wait, submit, receipt, and exception. Attribute model tokens and browser calls. The current `application-metrics` endpoint measures worker attempts but not all coordinator time.
2. **Candidate reserve and auto-handoff:** pull more than ten suitable, unapplied official roles, verify remote eligibility before form work, and replace blocked roles without a new search conversation.
3. **Bounded drafting and answer reuse:** enable a scoped production draft provider after evidence and privacy checks; reuse confirmed employer-scoped answers. Today production drafting is disabled, so the coordinator writes or asks about each novel prose field.
4. **Ashby reliability:** wait for persisted field values, not just visible values, before submission. The pilot had two form validation failures where a visible LinkedIn value or radio choice was not saved. Investigate why the headless worker received `RECAPTCHA_SCORE_BELOW_THRESHOLD` while ordinary Chrome succeeded, without bypassing a challenge.
5. **Compare browsers only after tracing:** benchmark the existing Playwright worker against one alternative on the same real-compatible synthetic fixtures, including success rate, p50/p95 time, model tokens, and challenge rate. Playwright already auto-waits for actionability; replacing it without a measured bottleneck risks adding model calls and latency.

Do not count ten preselected, prefilled forms as a complete 30-second end-to-end win. The acceptance run starts at the scan and includes the batch's unsuccessful work. Preserve zero fabricated facts, zero false submitted states, zero duplicate final clicks, and the existing exact approval and human challenge gates.

## Source notes

- [Greenhouse Job Board API](https://docs.greenhouse.io/job-board.html): public GET endpoints and authenticated application POST.
- [Lever Postings API](https://github.com/lever/postings-api): public per-site posting feed and hosted application URL.
- [Ashby public job postings API](https://developers.ashbyhq.com/docs/public-job-posting-api): employer posting feed.
- [Playwright auto-waiting](https://playwright.dev/docs/actionability): actionability checks for browser controls.
