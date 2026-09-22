# Live application pilot, 22 September 2026

## Current checkpoint (16:00 UTC)

The target remains ten **new, verified submissions**. The pilot started at 13:06:04 UTC. Five new applications have verified receipts: Restream, Umbrel, Clera, Farseer Backend, and HTTPie Fullstack. Restream's Ashby success page and employer email independently confirmed receipt. Umbrel, Clera, and Farseer showed success pages in the regular Chrome browser; their manually verified receipts were recorded in the server. HTTPie was submitted by the updated worker and has a non-simulated receipt with a success screenshot.

The start-to-recorded-receipt wall time for the first result was **2 hours 20 minutes 19 seconds**. This includes discovery, duplicate and fit checks, several form fixes, failed and blocked attempts, and owner wait. It is not a steady-state form-filling time. HTTPie's worker reported 7.77 seconds of active time after final approval. A median per completed application and a valid 100-application projection require the rest of the ten-submission batch. Do not divide wall time by attempted or prepared roles.

| Role | Current outcome | Evidence or blocker |
| --- | --- | --- |
| Restream, Senior Software Engineer - Backend - Billing Team | Submitted | Ashby success page, successful submit mutation, and employer receipt email |
| Umbrel, umbrelOS Apps Engineer (Docker) | Submitted | Chrome success page after the server path returned `RECAPTCHA_SCORE_BELOW_THRESHOLD` |
| Clera, Senior Backend Engineer | Submitted | Chrome success page after the server path returned `RECAPTCHA_SCORE_BELOW_THRESHOLD` |
| Farseer, Senior Backend Engineer | Submitted | Chrome success page; original worker attempt sent no submit mutation |
| HTTPie, Senior Fullstack Engineer (Remote) | Submitted | Worker receipt and private success screenshot; 7.77 seconds active worker time |
| Mimica, Staff/Lead Python Engineer | Unverified | No submit mutation in captured network trace; do not count or blindly retry |
| Farseer, Senior Frontend Engineer | Unverified | Final action was attempted, but no independent receipt; do not count |
| SplitMetrics, Backend Engineer (Python) | Unverified | No submit mutation in captured network trace; do not count |
| Emidat, Senior Frontend Engineer | Unverified | No independent receipt; do not count |
| Cyberhaven, Senior Software Engineer (Browser Extension) | Unverified | Filled form remained after click, no independent receipt; do not count |
| Coralogix, Senior Frontend Engineer | Unverified | No independent receipt; do not count |

The StackBlitz Senior Applied AI Engineer role was excluded because the recorded profile cannot meet its required daily US-Pacific overlap. Four indexed Ashby roles were excluded because the live official board no longer listed them. The search history already exceeds 1,700 application records, so finding distinct, current, high-fit roles is a material part of this pilot.

The Canonical Python/Golang role was rejected before submission because it requires an own-words/no-AI attestation and school results absent from the saved profile. A Transparent Technology recruiter listing was queued, but its candidate portal requires an account and its destination is outside the worker allowlist; it has no submission. Several search results had already been handled, were closed in the live employer feed, or did not meet the location and skill preferences.

## What the pilot found and fixed

- Ashby saves field values asynchronously. A click before the final save settles can silently do nothing. The worker now waits for the resume-upload acknowledgement, blurs the focused field, and waits for network idle before Submit. A browser regression test reproduces the lost-click condition.
- A successful Ashby page can say “application was successfully submitted.” The success detector now recognizes that wording. This is how the Restream success page was first missed by the old detector and then independently verified and recorded.
- The final-review fingerprint now excludes volatile DOM control indices and render signatures while still binding approval to the reviewed answers and files.
- Optional fields with known profile values now recognize common link-label variants and current location. Optional skill checkboxes can use exact verified profile skills. Unsupported skills remain blank.
- Ashby's explicit spam rejection is now classified as a blocked submission instead of an ambiguous outcome. Private diagnostics captured its error code and page state for both blocked roles.
- Earlier fixes during the same pilot covered conditional Greenhouse fields, hidden ATS backing controls, portfolio URL versus upload controls, Comeet styled checkbox/radio controls, and the Coralogix domain allowlist.

The full syntax, **172-test**, and repository-privacy checks pass. The latest worker is deployed. Main contains the Ashby save and success fix (`b93c343`) and the link-label and spam-block fix (`337f251`).

## Remaining work

1. Continue previously prepared, uncertain applications in a regular browser once destination-specific browser data-sharing approval is available. The browser's computer-use policy requires that approval before entering private contact details or uploading the resume. The server correctly refused a blind SplitMetrics retry after an uncertain final action.
2. Reconcile uncertain attempts against employer-side evidence before any retry. Do not count a click without a receipt.
3. Continue distinct live-role discovery and sequential applications until ten new submissions are verified. Then compute total wall time, arithmetic mean, median, and a clearly labeled 100-application projection. Keep discovery, debugging, and owner wait separate where the event data permits.
