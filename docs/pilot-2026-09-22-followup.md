# Live application pilot, 22 September 2026

## Current checkpoint (15:41 UTC)

The target remains ten **new, verified submissions**. The pilot started at 13:06:04 UTC. One new application has a verified receipt: Restream, Senior Software Engineer - Backend - Billing Team. Its Ashby success page was visible at about 15:25:54 UTC, and an employer email at 15:25:49 UTC independently confirmed receipt. The server recorded the submission at 15:26:22 UTC and the employer email as `application_received`.

The start-to-recorded-receipt wall time for that first result was **2 hours 20 minutes 19 seconds**. This includes discovery, duplicate and fit checks, several form fixes, failed and blocked attempts, and owner wait. It is not a steady-state form-filling time. A median per completed application and a valid 100-application projection require more completed samples. Do not divide this wall time by attempted or prepared roles.

| Role | Current outcome | Evidence or blocker |
| --- | --- | --- |
| Restream, Senior Software Engineer - Backend - Billing Team | Submitted | Ashby success page, successful submit mutation, and employer receipt email |
| Umbrel, umbrelOS Apps Engineer (Docker) | Blocked | Ashby returned `RECAPTCHA_SCORE_BELOW_THRESHOLD`; no submission |
| Clera, Senior Backend Engineer | Blocked | Ashby returned `RECAPTCHA_SCORE_BELOW_THRESHOLD`; no submission |
| Mimica, Staff/Lead Python Engineer | Unverified | No submit mutation in captured network trace; do not count or blindly retry |
| Farseer, Senior Backend Engineer and Senior Frontend Engineer | Unverified | Final action was attempted, but no independent receipt; do not count |
| SplitMetrics, Backend Engineer (Python) | Unverified | No submit mutation in captured network trace; do not count |
| Emidat, Senior Frontend Engineer | Unverified | No independent receipt; do not count |
| Cyberhaven, Senior Software Engineer (Browser Extension) | Unverified | Filled form remained after click, no independent receipt; do not count |
| Coralogix, Senior Frontend Engineer | Unverified | No independent receipt; do not count |

The StackBlitz Senior Applied AI Engineer role was excluded because the recorded profile cannot meet its required daily US-Pacific overlap. Four indexed Ashby roles were excluded because the live official board no longer listed them. The search history already exceeds 1,700 application records, so finding distinct, current, high-fit roles is a material part of this pilot.

## What the pilot found and fixed

- Ashby saves field values asynchronously. A click before the final save settles can silently do nothing. The worker now waits for the resume-upload acknowledgement, blurs the focused field, and waits for network idle before Submit. A browser regression test reproduces the lost-click condition.
- A successful Ashby page can say “application was successfully submitted.” The success detector now recognizes that wording. This is how the Restream success page was first missed by the old detector and then independently verified and recorded.
- The final-review fingerprint now excludes volatile DOM control indices and render signatures while still binding approval to the reviewed answers and files.
- Optional fields with known profile values now recognize common link-label variants and current location. Optional skill checkboxes can use exact verified profile skills. Unsupported skills remain blank.
- Ashby's explicit spam rejection is now classified as a blocked submission instead of an ambiguous outcome. Private diagnostics captured its error code and page state for both blocked roles.
- Earlier fixes during the same pilot covered conditional Greenhouse fields, hidden ATS backing controls, portfolio URL versus upload controls, Comeet styled checkbox/radio controls, and the Coralogix domain allowlist.

The full syntax, **172-test**, and repository-privacy checks pass. The latest worker is deployed. Main contains the Ashby save and success fix (`b93c343`) and the link-label and spam-block fix (`337f251`).

## Remaining work

1. Complete blocked applications in a regular browser once destination-specific browser data-sharing approval is available. The browser's computer-use policy requires that approval before entering private contact details or uploading the resume. Do not retry the blocked server path.
2. Reconcile uncertain attempts against employer-side evidence before any retry. Do not count a click without a receipt.
3. Continue distinct live-role discovery and sequential applications until ten new submissions are verified. Then compute total wall time, arithmetic mean, median, and a clearly labeled 100-application projection. Keep discovery, debugging, and owner wait separate where the event data permits.
