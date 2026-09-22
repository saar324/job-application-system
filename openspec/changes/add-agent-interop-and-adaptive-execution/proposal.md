## Why

Agent clients currently depend on bespoke CLI behavior, and unsupported application forms fall directly to manual review. A standards-based tool interface and a tightly bounded AI fallback can improve interoperability and form coverage without replacing the service as the system of record or weakening submission approval.

## What Changes

- Add a profile-scoped MCP server over the existing application service for status, discovery, application intake, confirmations, and application history.
- Derive profile identity exclusively from authenticated credentials and make mutating tools idempotent and auditable.
- Keep provider-specific deterministic Playwright adapters as the default form path.
- Add an optional model-assisted form adapter for unsupported controls or failed known adapters, behind domain, action, time, step, and cost limits.
- Treat page content as untrusted data and prohibit it from modifying system policy, revealing secrets, or authorizing submission.
- Reuse the existing preview, confirmation, receipt, and network-security boundaries for every adaptive attempt.
- Add a Playwright MCP/CLI-based fixture and evaluation workflow for development only; unsafe arbitrary browser code is not exposed to production agents.

## Capabilities

### New Capabilities

- `agent-tool-interface`: Defines authenticated MCP tools and resources over the profile-bound system of record.
- `adaptive-form-execution`: Defines deterministic-first execution and a constrained, evidence-producing AI fallback for unsupported forms.

### Modified Capabilities

<!-- No existing capability requirement changes; the new capabilities depend on and preserve the existing orchestration and browser contracts. -->

## Impact

- API: MCP Streamable HTTP endpoint, tool schemas, authorization middleware, idempotency, and audit events.
- Agent clients: native tool discovery and typed results in place of CLI-output parsing.
- Worker: adaptive form adapter, action policy, model-provider integration, budgets, and additional attempt evidence.
- Security: prompt-injection defenses, secret minimization, network-policy reuse, and final-action enforcement.
- Development: anonymized browser fixtures, Playwright MCP/CLI workflows, and comparative adapter evaluations.
- Operations: optional model credentials, feature flags, per-profile rollout, and cost/quality metrics.
