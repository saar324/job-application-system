## Why

The September 24 ten-application pilot has not established a time per application: its first 50-source campaign produced zero new verified receipts in about nine minutes. The source report had 149 found rows, 140 excluded rows, 37 handled matches, eight timeouts, eleven cooldowns, and eighteen zero-extractable sources. Those counts do not prove the market is empty. Several adapters discard rows before server scoring, and the browser runner uses a narrow default query. A later three-query Himalayas probe fetched 107 listings in seconds but accepted none; a country-filtered probe accepted two rows whose employer destinations were unresolved. Search breadth, eligibility, destination resolution, and source coverage must be measured separately.

## What changes

- Remove hidden title and raw-result truncation before deduplication and eligibility screening. Search enough bounded pages or rows to find up to ten *new, suitable, employer-actionable* roles per source, or report why the source stopped.
- Build a bounded query plan from configured preferences, verified prior submitted role titles, curated synonyms, and source capabilities. Historical titles are search vocabulary only; they never independently authorize an application or override location, fit, salary, or legal gates.
- Treat provider geography tags as candidate hints. Check the current employer listing and destination before queuing, and preserve uncertain listings for resolution without counting them as ready applications.
- Make source coverage and the live pilot funnel honest: raw rows, fetched pages, title filter, handled, scored, eligible, destination resolved, queued, attempted, and verified receipts, plus stop reasons and time by stage.
- Add a quality review path for relevant jobs a cheap scorer cannot judge and require company-specific, evidence-grounded answers. A faster search or drafting path is promoted only when its relevance and answer quality are at least as good as the current path.
- Use strong ATS IDs or verified canonical employer URLs for automatic handled filtering. Keep company-and-title matches visible as possible duplicates, and hold ambiguous repeat final actions for identity review.
- Preserve rate limits, challenge stops, per-origin budgets, and one active application lane.

## Relationship to existing changes

This is a focused corrective change to `source-query-discovery` and `workflow-efficiency`. It refines the broader supply and measurement work in `one-hour-verified-application-campaign` without changing submission authorization, final-click policy, or verified-receipt semantics. Its quality gate takes precedence over the older speed milestones. The one-hour goal remains a hypothesis until a fresh live cohort validates it.

## Success criteria

For a ten-application pilot, report both supply and execution: ten new suitable employer destinations if the bounded source plan can find them, ten verified receipts only if final submissions succeed, and campaign wall time divided by the number of verified new receipts. Report per-application latency separately from first observation to each receipt. A source reaching a cap, timeout, cooldown, challenge, manual policy, unsupported pagination, or unresolved destination must never be described as exhausted or fully searched. Freeze the old-path baseline first, then use blinded reviewers and a separate holdout of at least 100 cases for the five-point quality gate in the design. Quality outranks throughput: no duplicate, unsupported applicant fact, generic nonresponsive answer, or uncertain legal attestation may be submitted to improve speed.
