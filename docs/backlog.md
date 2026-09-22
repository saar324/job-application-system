# Job application system backlog

This is the shared follow-up list for the efficiency upgrade and the 22 September 2026 live pilot. The detailed original acceptance criteria remain in [the OpenSpec tasks](../openspec/changes/single-lane-application-efficiency/tasks.md); measured pilot evidence is in [the pilot report](pilot-2026-09-22.md). Keep application quality and verified receipts ahead of raw attempt count.

| Priority | Work | Completion evidence |
| --- | --- | --- |
| Done | Finish the ten verified-submission pilot. | Ten employer receipts were verified and recorded on 22 September 2026; total wall time was 3 hours 4 minutes 38 seconds. |
| P0 | Build and validate the [30-second end-to-end campaign flow](30-second-throughput-plan.md), including coordinator timing, candidate reserve, bounded drafting, exact batch review, sequential receipts, and exception continuation. | A fresh ten-role campaign produces ten suitable verified receipts within five minutes, counting search, review, owner wait, failures, and recovery; quality gates remain green. |
| Done | Exclude already handled roles from every search result using the profile's durable application history and stable ATS role IDs. Keep unattempted discovered roles searchable. | 162 tests and privacy gate pass. Production Ashby query for an already handled Kestra role returned `handledFiltered: 1`, `found: 0`, and no items. |
| P0 | Recheck official posting status and Bulgaria remote eligibility before preparing a form. | Stale and geographically restricted roles are removed before a browser attempt. |
| P0 | Fill relevant optional answers when supported by verified applicant evidence; review all filled and unfilled fields. | Dash0-style AI and startup questions receive grounded answers or an explicit owner decision to leave blank; refreshed preview is accurate. |
| P1 | Reuse confirmed links, facts, and employer-scoped answers without treating unreviewed drafts as facts. | Fewer repeated owner questions and no incorrect cross-employer answer reuse. |
| P1 | Identify the actual application form on multi-form pages, and preserve human challenge handoffs. | Intetics-style page does not confuse contact, newsletter, and application forms; no automated CAPTCHA solving. |
| P1 | Record verified employer and role names for directly queued ATS URLs. | Application log and approval preview name the employer and role rather than the ATS host. |
| P1 | Measure discovery, eligibility checks, owner wait, drafting, browser work, token use, and receipts as distinct stages. | Comparable time and token cost per verified submission, including blocked and failed outcomes. |
| P2 | Run the broader fixture and browser-tool comparison from the original upgrade plan. | Same cases and quality gates for Playwright, CLI/MCP, and adaptive alternatives; measured gain before changing the production worker. |

The handled-role filter is deployed to the production API. The follow-up pilot is recorded in [the second pilot report](pilot-2026-09-22-followup.md). The other items remain open unless their completion evidence is recorded here.

The follow-up pilot exposed one additional performance blocker: production prose drafting is disabled (`draftCalls: 0`), so every company-specific answer reaches the owner. Evaluate a securely configured draft provider with factual grounding and final review before counting any time gain. The optional-portfolio upload mapping was fixed and deployed in `1dfcaf4`.
