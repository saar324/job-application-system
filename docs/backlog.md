# Job application system backlog

This is the shared follow-up list for the efficiency upgrade and the 22 September 2026 live pilot. The detailed original acceptance criteria remain in [the OpenSpec tasks](../openspec/changes/single-lane-application-efficiency/tasks.md); measured pilot evidence is in [the pilot report](pilot-2026-09-22.md). Keep application quality and verified receipts ahead of raw attempt count.

| Priority | Work | Completion evidence |
| --- | --- | --- |
| Done | Finish the ten verified-submission pilot. | Ten employer receipts were verified and recorded on 22 September 2026; total wall time was 3 hours 4 minutes 38 seconds. |
| P0 | Validate the implemented [30-second end-to-end campaign flow](30-second-throughput-plan.md) on a fresh real batch; finish bounded production drafting and exception auto-replacement if the trace shows they are needed. | A fresh ten-role campaign produces ten suitable verified receipts within five minutes, counting search, review, owner wait, failures, and recovery; quality gates remain green. |
| Done | Implement the initial handled-role filter using application history and stable ATS role IDs. Keep unattempted discovered roles searchable. | The original Kestra query was filtered. The 23 September pilot exposed receipt URL and direct-intake gaps, tracked in the next row. |
| P0 | Roll out and verify the 23 September cross-source duplicate correction. | The isolated branch indexes employer receipt URLs and matches listing/application ATS variants; 218 tests and privacy check pass. Verify a live RapidSOS, Wayflyer, and n8n lookup is filtered before production deployment. |
| P0 | Replace failed headless Ashby submissions with a reliable regular-browser path. | The 23 September pilot yielded one headless success but regular Chrome was needed for five Ashby receipts. Compare verified success and challenge rates without bypassing anti-bot controls. |
| P0 | Recheck official posting status and Bulgaria remote eligibility before preparing a form. | Stale and geographically restricted roles are removed before a browser attempt. |
| P0 | Fill relevant optional answers when supported by verified applicant evidence; review all filled and unfilled fields. | Dash0-style AI and startup questions receive grounded answers or an explicit owner decision to leave blank; refreshed preview is accurate. |
| P1 | Reuse confirmed links, facts, and employer-scoped answers without treating unreviewed drafts as facts. | Fewer repeated owner questions and no incorrect cross-employer answer reuse. |
| P1 | Identify the actual application form on multi-form pages, and preserve human challenge handoffs. | Intetics-style page does not confuse contact, newsletter, and application forms; no automated CAPTCHA solving. |
| P1 | Record verified employer and role names for directly queued ATS URLs. | Application log and approval preview name the employer and role rather than the ATS host. |
| P1 | Measure discovery, eligibility checks, owner wait, drafting, browser work, token use, and receipts as distinct stages. | Comparable time and token cost per verified submission, including blocked and failed outcomes. |
| P2 | Run the broader fixture and browser-tool comparison from the original upgrade plan. | Same cases and quality gates for Playwright, CLI/MCP, and adaptive alternatives; measured gain before changing the production worker. |

The handled-role filter and campaign control path are deployed to production with HTTP, MCP, and CLI support. The
[production campaign check](campaign-rollout-2026-09-22.md) passed 178 tests and made a fresh scan decision in 13.181
seconds, but the cohort had no new role that passed both quality and employer-destination gates, so the ten-receipt timing
target remains open. The follow-up pilot is recorded in [the second pilot report](pilot-2026-09-22-followup.md). The other
items remain open unless their completion evidence is recorded here.

The follow-up pilot exposed one additional performance blocker: production prose drafting is disabled (`draftCalls: 0`), so every company-specific answer reaches the owner. Evaluate a securely configured draft provider with factual grounding and final review before counting any time gain. The optional-portfolio upload mapping was fixed and deployed in `1dfcaf4`.

The [23 September pilot](pilot-2026-09-23.md) produced seven new verified receipts from ten owner-approved roles. Three
were already submitted in earlier runs, exposing cross-source and URL-variant duplicate misses. A fresh scan found no
replacement candidates. The 30-second acceptance target remains unmet.
