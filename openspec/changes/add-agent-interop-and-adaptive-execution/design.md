## Context

The application server is intentionally the durable, profile-isolated system of record, while chat runtimes are replaceable clients. MCP provides a typed interoperability layer that fits that architecture. The worker already uses Playwright and provider adapters; model-assisted control is most useful as a fallback for unfamiliar forms, not as the primary execution engine.

This change depends on `strengthen-application-foundations` for durable idempotency, per-profile scheduling, telemetry, and connection-bound egress controls. It also assumes the preview and approval behavior in `direct-link-guided-applications`. The opportunity-understanding change is useful but not required for MCP delivery.

## Goals / Non-Goals

**Goals:**

- Let Codex, OpenClaw, Claude, and other MCP clients use stable, typed, profile-bound tools.
- Preserve the HTTP/service layer as the authority and keep MCP replaceable.
- Improve coverage of unsupported forms while retaining deterministic adapters, approval rules, and verifiable receipts.
- Measure adaptive execution against fixtures before and during a limited production rollout.

**Non-Goals:**

- Turning the service into an autonomous peer agent through A2A.
- Giving agent clients arbitrary browser-code execution or general filesystem/network access.
- Allowing page content or model output to authorize final submission.
- Replacing known ATS adapters with model-driven navigation.
- Solving CAPTCHA, MFA, passkeys, identity verification, or adversarial anti-bot challenges.

## Decisions

### Implement MCP as a thin service adapter

The MCP server uses the official TypeScript SDK and Streamable HTTP transport. It invokes the same application service methods as the HTTP API and CLI; it does not access storage directly. Authorization middleware maps the bearer credential to one profile before tool dispatch, and profile identifiers supplied in tool arguments are rejected or ignored.

Initial tools are `profile_status`, `scan_jobs`, `list_opportunities`, `list_applications`, `get_application`, `request_application`, `list_confirmations`, and `resolve_confirmation`. Read results are bounded and paginated. Mutating tools require idempotency keys and return durable resource IDs rather than waiting for browser completion.

### Keep deterministic adapters first

The worker selects a known provider adapter when available. The adaptive adapter may run only when no deterministic adapter supports the form or when an adapter returns an explicitly fallback-eligible unsupported-control result. Policy, authentication challenges, uncertain submission, and security failures are never fallback-eligible.

### Put model actions behind a local policy engine

The model proposes typed actions such as inspect, click, fill, select, upload-staged-document, and scroll. A worker-owned policy engine validates each action against allowed origins, field sensitivity, application state, remaining budgets, and submission approval. The model receives no credentials; deterministic worker code handles an origin-bound credential only when the existing vault policy permits it.

### Treat page instructions as untrusted

Page text, accessibility data, labels, and hidden content are evidence about the form, never policy instructions. The model context includes immutable task rules separating application data from page data. Attempts to request secrets, change destinations, disable safeguards, or perform unrelated actions are denied and recorded using safe reason codes.

### Preserve preview and receipt authority

Adaptive execution must produce the same normalized field preview and fingerprint as deterministic execution. The policy engine blocks the final submission action unless current durable state authorizes the exact preview. Submitted status still requires newly observed confirmation evidence and a persisted production receipt.

### Use Playwright MCP only in the development harness

Playwright MCP or CLI may help capture accessibility snapshots, build anonymized fixtures, and explore form flows. Production agents do not receive Playwright MCP, filesystem access, or `browser_run_code`-style capabilities. Recorded fixtures remove applicant data, cookies, tokens, and site credentials.

### Stage the adaptive provider behind an interface

The first pilot can use Stagehand because it fits the Node/Playwright runtime, but the internal adapter contract remains provider-neutral. Rollout is disabled by default, then simulation-only, allowlisted domains, selected profiles, and finally broader unsupported-form use after meeting success, policy-violation, latency, and cost thresholds.

## Risks / Trade-offs

- **[Prompt injection changes agent behavior]** → Treat page content as data and validate every proposed action in deterministic policy code.
- **[Model fills a plausible but false answer]** → Allow values only from stored profile evidence, approved answers, deterministic transformations, or an owner confirmation.
- **[MCP mutation is repeated by a client]** → Require idempotency keys and return the existing durable result.
- **[Adaptive execution is expensive or slow]** → Enforce step, wall-time, token, and cost budgets and fall back to manual review.
- **[Fixture capture leaks personal data]** → Capture only synthetic accounts and scrub cookies, tokens, uploaded documents, and entered values before storage.
- **[Provider lock-in]** → Keep model control behind a small typed adapter and evaluate replacements against the same corpus.

## Migration Plan

1. Ship read-only MCP tools in a local environment and verify profile isolation and bounded output.
2. Add idempotent mutation and confirmation tools, then migrate one agent client from CLI parsing.
3. Build synthetic fixtures and establish deterministic adapter baselines.
4. Implement the adaptive adapter in simulation mode with no final-submission capability.
5. Enable allowlisted production previews and compare success, latency, cost, and policy denials.
6. Permit approved final submissions only after the evaluation threshold is met and rollback has been tested.
7. Retain the CLI and HTTP API throughout rollout.
