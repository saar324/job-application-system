# Follow-up live application pilot, 22 September 2026

## Scope and current result

The target is ten **new, verified submissions** with elapsed time per submitted application. This follow-up began at 13:06:04 UTC. At 13:50:33 UTC, five distinct new roles had entered the server and **zero had been submitted**. The 44 minutes 29 seconds of wall time include source discovery, official-posting checks, duplicate checks against prior applications, form defect repair, and owner wait. They are not a per-submission throughput measurement.

| Employer and role | First queued (UTC) | State at 13:50 UTC | Outstanding action |
| --- | --- | --- | --- |
| StackBlitz/Bolt.new, Senior Applied AI Engineer | 13:10:27 | Waiting for owner facts | 7–10 AM Pacific overlap, engineering years, production LLM experience; stale unlabelled-control confirmation requires recheck |
| Emidat, Senior Frontend Engineer | 13:19:14 | Waiting for owner facts and prose | Germany work authorization, monthly Munich travel, real B2B and scale-up examples, motivation |
| Farseer, Senior Backend Engineer | 13:25:11 | Complete final preview | Explicit approval of name, email, and resume before Submit |
| Cyberhaven, Senior Software Engineer (Browser Extension) | 13:26:03 | Waiting for motivation answer | Owner review of the company-specific draft |
| Coralogix, Senior Frontend Engineer | 13:45:16 | Waiting for legal attestations | Privacy-policy agreement and valid authorization to work in Europe |

All five are live on official employer or ATS pages and allow remote work from Europe or Bulgaria. Advertised pay is €90–110k at Emidat and undisclosed at the other four. No advertised USD-paying role entered the batch while the EUR-only preference remains unresolved. Farseer has the only complete preview. Neither queued nor waiting applications count as submitted.

## Measurements and constraints

- Server-wide attempt count increased from 32 at the start to 40 at 13:50 UTC. These eight executions include retries; they are not eight distinct applications.
- The cumulative worker active median was 3.9 seconds over 23 measured executions at 13:50 UTC. The server-wide queue median was 478 ms over 28 samples. Both include earlier work and do not isolate this follow-up batch.
- The end-to-end wall time is dominated by finding and verifying new eligible roles in a history of over 1,700 applications, plus owner-dependent questions. The form worker itself usually took seconds. The service does not record coordinator discovery time or model token usage; token counters remain unavailable.
- At the 13:50 checkpoint, wall time divided by five distinct prepared or blocked roles was 8 minutes 54 seconds per role. This is a preparation/attempt ratio that includes debugging and waiting, not a completed-application rate.
- With zero verified submissions, elapsed time **per completed application** and a normalized 100-submission estimate are undefined. Do not divide the wall time by five attempts or extrapolate it as throughput.

## Defects repaired during this follow-up

- Conditional Greenhouse fields are replanned when the form changes, preventing a timeout from being mislabeled as submission uncertainty (`e93acd5`).
- Hidden Ashby and Greenhouse backing inputs are excluded from the form inventory (`0e7c381`).
- A saved portfolio URL no longer gets passed to a file-upload control just because its label says “Portfolio” (`1dfcaf4`). An optional upload remains visibly unfilled in the final preview. The targeted browser test, full 165-test suite, syntax check, and privacy gate passed. The worker fix is deployed.
- The official Coralogix application domain was added to the production worker's exact allowlist, retaining the prior Intetics entry. The worker successfully reached the employer's Comeet form and filled contact fields and the resume.

## Resume point

Resolve the pending owner answers and exact final previews, then submit approved forms sequentially and verify receipts. Continue searching only for distinct live roles that match the applicant's stack, Bulgaria/Europe eligibility, compensation preference, and unhandled history. Do not substitute low-quality or duplicate applications to reach ten.
