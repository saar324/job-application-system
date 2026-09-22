# Live application pilot, 22 September 2026

## Final result (16:10:42 UTC)

The pilot started at 13:06:04 UTC and finished with **ten new, verified submissions** at 16:10:42.045 UTC. Every application has a server receipt backed by an employer success page. Restream also has an employer receipt email. HTTPie was submitted by the updated worker and has a non-simulated receipt with a private success screenshot. The other nine receipts were manually recorded after visible Chrome success pages.

**End-to-end wall time:** 3 hours 4 minutes 38 seconds for ten submissions. **Mean throughput:** one verified submission per 18 minutes 28 seconds, including discovery, duplicate and fit checks, debugging, blocked attempts, approval waits, and form work. **Median interval between receipts:** 1 minute 24 seconds, counting the interval from pilot start to the first receipt. The first receipt took 2 hours 20 minutes 19 seconds, so the median interval should not be interpreted as the time to discover and apply to a new role. A mechanical projection of the observed end-to-end mean is **30 hours 46 minutes for 100 applications**; it is not a forecast of steady-state performance. HTTPie's worker reported 7.77 seconds of active time after final approval. From the HTTPie receipt to the final Emidat receipt, the final five completions took 16 minutes 32 seconds, or 3 minutes 18 seconds per completion, but those applications were already found and prepared.

| Role | Receipt time (UTC) | Evidence |
| --- | --- | --- |
| Restream, Senior Software Engineer - Backend - Billing Team | 15:26:22 | Ashby success page, successful submit mutation, and employer receipt email |
| Umbrel, umbrelOS Apps Engineer (Docker) | 15:48:51 | Chrome success page after the server path returned `RECAPTCHA_SCORE_BELOW_THRESHOLD` |
| Clera, Senior Backend Engineer | 15:49:42 | Chrome success page after the server path returned `RECAPTCHA_SCORE_BELOW_THRESHOLD` |
| Farseer, Senior Backend Engineer | 15:50:45 | Chrome success page |
| HTTPie, Senior Fullstack Engineer (Remote) | 15:54:10 | Worker receipt and private success screenshot |
| Cyberhaven, Senior Software Engineer (Browser Extension) | 16:06:07 | Chrome success page |
| SplitMetrics, Backend Engineer (Python) | 16:07:48 | Chrome success page |
| Mimica, Staff/Lead Python Engineer (FastAPI, Orchestration) | 16:08:55 | Chrome success page |
| Farseer, Senior Frontend Engineer | 16:09:36 | Chrome success page |
| Emidat, Senior Frontend Engineer | 16:10:42 | Chrome success page |

The StackBlitz Senior Applied AI Engineer role was excluded because the recorded profile cannot meet its required daily US-Pacific overlap. Four indexed Ashby roles were excluded because the live official board no longer listed them. The search history already exceeds 1,700 application records, so finding distinct, current, high-fit roles is a material part of this pilot.

The Canonical Python/Golang role was rejected before submission because it requires an own-words/no-AI attestation and school results absent from the saved profile. A Transparent Technology recruiter listing was queued, but its candidate portal requires an account and its destination is outside the worker allowlist; it has no submission. Several search results had already been handled, were closed in the live employer feed, or did not meet the location and skill preferences.

## What the pilot found and fixed

- Ashby saves field values asynchronously. A click before the final save settles can silently do nothing. The worker now waits for the resume-upload acknowledgement, blurs the focused field, and waits for network idle before Submit. A browser regression test reproduces the lost-click condition.
- A successful Ashby page can say “application was successfully submitted.” The success detector now recognizes that wording. This is how the Restream success page was first missed by the old detector and then independently verified and recorded.
- The final-review fingerprint now excludes volatile DOM control indices and render signatures while still binding approval to the reviewed answers and files.
- Optional fields with known profile values now recognize common link-label variants and current location. Optional skill checkboxes can use exact verified profile skills. Unsupported skills remain blank.
- Ashby's explicit spam rejection is now classified as a blocked submission instead of an ambiguous outcome. Private diagnostics captured its error code and page state for both blocked roles.
- Earlier fixes during the same pilot covered conditional Greenhouse fields, hidden ATS backing controls, portfolio URL versus upload controls, Comeet styled checkbox/radio controls, and the Coralogix domain allowlist.
- Chrome recovery exposed a remaining Ashby save race. Cyberhaven initially reported a missing LinkedIn URL despite the visible field value; re-entering and blurring it led to a verified submission. SplitMetrics initially reported a missing English answer despite the visible radio selection; toggling and restoring it led to a verified submission. The worker's save wait did not cover these manual browser cases. These retries were validation failures, not duplicate submissions.

The full syntax, **172-test**, and repository-privacy checks pass. The latest worker is deployed. Main contains the Ashby save and success fix (`b93c343`) and the link-label and spam-block fix (`337f251`).

## Follow-up backlog

1. Address Ashby's asynchronous field-save race so both worker and manual-browser paths wait for persisted answers before final submission.
2. Diagnose why the worker's Ashby path gets `RECAPTCHA_SCORE_BELOW_THRESHOLD` for some employers while ordinary Chrome succeeds. Keep CAPTCHA handling in the user's hands.
3. Keep discovery, review, approval wait, browser work, and verified receipt timestamps separately. The end-to-end total was dominated by early debugging and discovery; receipt intervals alone cannot measure a new role from search to submission.
4. Coralogix remains unverified and was not needed to reach ten. Its form includes a privacy-policy attestation; resolve that before any further submission attempt. Do not count the prior uncertain click as a submission.
