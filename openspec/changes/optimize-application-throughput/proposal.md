## Why

The system preserves application quality, but it spends avoidable time and model budget in three places. Semantic discovery can enrich up to twenty candidates sequentially, repeats the same profile embedding, and loses its in-memory cache on restart. The scheduler serializes all work for one profile even when isolated browser capacity is available. Adaptive execution sends a full observation and requests one action per model round trip. These costs reduce applications completed per hour without improving eligibility, answer accuracy, approval safety, or receipt confidence.

## What Changes

- Make semantic enrichment decision-directed: invoke it only when unresolved evidence can change eligibility or ranking, persist versioned public-job results, separate job and profile embeddings, and batch provider requests.
- Add configurable bounded concurrency within a profile while retaining exclusive application claims, global limits, daily caps, per-origin throttles, and conservative submission recovery.
- Replace action-at-a-time adaptive execution with compact initial observations, subsequent deltas, and worker-validated action batches that stop at navigation, uncertainty, approval, or submission boundaries.
- Compile successful sanitized adaptive traces into versioned form recipes that can be replayed deterministically only when origin and structural fingerprints match exactly.
- Replace fixed browser sleeps with event-driven transition detection and bounded fallbacks.
- Measure provider calls, tokens, cache effectiveness, queue time, browser time, manual review, policy denials, and verified submissions so efficiency changes ship only when quality remains non-regressed.

## Capabilities

### New Capabilities

- `workflow-efficiency`: Defines privacy-safe efficiency measurement, baselines, quality gates, and rollback requirements.

### Modified Capabilities

- `opportunity-eligibility`: Adds decision-directed enrichment, durable versioned caches, split embeddings, and batching without weakening deterministic hard gates.
- `application-orchestration`: Adds bounded same-profile and per-origin concurrency while preserving exactly-once claims and submission uncertainty handling.
- `secure-browser-execution`: Adds compact adaptive plans, safe recipe replay, and event-driven waits while preserving approval and receipt requirements.

## Impact

- Discovery: enrichment selection, provider interfaces, persistent cache schema, batch execution, and score telemetry.
- Scheduling: profile queues, global/profile/origin semaphores, fairness, claims, and backoff.
- Browser worker: observation protocol, action validation, form fingerprints, recipe storage, and transition detection.
- Operations: new efficiency dashboards, baseline reports, rollout flags, and rollback controls.
- Tests: provider-call accounting, cache invalidation, concurrent scheduling, stale plans and recipes, prompt-injection boundaries, and verified receipt regressions.
