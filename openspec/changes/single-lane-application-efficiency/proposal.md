## Why

The owner reports roughly eight hours for 100 discovered and prepared applications (4.8 minutes each), but the system has no end-to-end baseline that attributes this time to search, screening, form work, model calls, approval waits, and site latency. The current worker already fills common profile fields deterministically and handles simple multi-step forms. It still discovers and fills one control at a time, stops at the first page with an unknown required answer, and relies on fixed post-click waits. Its approval presentation can truncate later fields and long answers. Agent-led browser searches repeat site navigation that could be expressed as bounded source queries. The installed agent skill also creates a fresh sub-agent for every application, adding setup and context repetition.

## What Changes

- Measure the full funnel before changing execution, with one active application agent and one external application tab at a time. First repair the complete-review and final-action classification gaps.
- Introduce a versioned field inventory and answer plan. Inspect each reachable form step, resolve verified profile facts deterministically, send only genuinely open questions to one bounded model call, and keep every answer tied to its source.
- Fill the planned answers, read values back from the live form, detect validation errors and newly revealed fields, and produce one complete pre-submit review across all steps. The existing explicit approval and receipt rules remain authoritative.
- Add a typed source-query catalog so an agent can discover available filters and ask the server to run an allowed search. Prefer official listing feeds where available; use a browser adapter only for sources without a suitable feed and where permitted.
- Reuse one application agent across a bounded batch, sequentially. It checkpoints each application in the server and discards private per-application context before the next one.
- Evaluate the existing Playwright library against Playwright CLI/MCP, Codex browser control, Stagehand, and Browser Use on the same anonymized fixtures before adopting any additional runtime.

## Scope and relationship to existing changes

This change refines the unimplemented `optimize-application-throughput` proposal. Its same-profile concurrency work is deferred because the owner wants one application agent and one active application at a time. Durable public-job caching, compact adaptive observations, recipe replay, and event-driven waits remain complementary ideas; this change gives the field and search protocols they must respect. The older `job-application-server` repository and installed skill need an explicit deployment/migration check before this repository is treated as live production.

## Success criteria

Establish a measured baseline first. Compare active time for all started applications as well as verified completions, and report owner wait separately. Set speed and token targets against that baseline for comparable cohorts; a provisional aim is 30% lower median active time and 40% fewer model input tokens on applications that actually invoke a model. No optimization may increase wrong-field fills, unsupported factual claims, policy violations, duplicate submissions, or unverified receipts. These figures are hypotheses, not current measurements or unconditional rollout gates.
