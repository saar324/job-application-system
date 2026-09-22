# Job application system backlog

This is the shared follow-up list for the efficiency upgrade and the 22 September 2026 live pilot. The detailed original acceptance criteria remain in [the OpenSpec tasks](../openspec/changes/single-lane-application-efficiency/tasks.md); measured pilot evidence is in [the pilot report](pilot-2026-09-22.md). Keep application quality and verified receipts ahead of raw attempt count.

| Priority | Work | Completion evidence |
| --- | --- | --- |
| P0 | Finish the ten verified-submission pilot. Resolve owner facts and browser challenges, review complete previews, submit only with exact approval, and record receipts. | Ten distinct eligible employer receipts; separate attempted, blocked, closed, and submitted counts. |
| P0 | Exclude already handled roles from every search result using the profile's durable application history and stable ATS role IDs. Keep unattempted discovered roles searchable. | Cross-source, cross-host, per-profile, and result-limit regressions; deployed search query shows no handled roles. |
| P0 | Recheck official posting status and Bulgaria remote eligibility before preparing a form. | Stale and geographically restricted roles are removed before a browser attempt. |
| P0 | Fill relevant optional answers when supported by verified applicant evidence; review all filled and unfilled fields. | Dash0-style AI and startup questions receive grounded answers or an explicit owner decision to leave blank; refreshed preview is accurate. |
| P1 | Reuse confirmed links, facts, and employer-scoped answers without treating unreviewed drafts as facts. | Fewer repeated owner questions and no incorrect cross-employer answer reuse. |
| P1 | Identify the actual application form on multi-form pages, and preserve human challenge handoffs. | Intetics-style page does not confuse contact, newsletter, and application forms; no automated CAPTCHA solving. |
| P1 | Record verified employer and role names for directly queued ATS URLs. | Application log and approval preview name the employer and role rather than the ATS host. |
| P1 | Measure discovery, eligibility checks, owner wait, drafting, browser work, token use, and receipts as distinct stages. | Comparable time and token cost per verified submission, including blocked and failed outcomes. |
| P2 | Run the broader fixture and browser-tool comparison from the original upgrade plan. | Same cases and quality gates for Playwright, CLI/MCP, and adaptive alternatives; measured gain before changing the production worker. |

The handled-role filter is implemented locally with regression tests. It still needs production deployment and a live query check. The other items remain open unless their completion evidence is recorded here.
