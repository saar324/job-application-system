## 1. MCP Service Boundary

- [x] 1.1 Add the official MCP TypeScript SDK and a Streamable HTTP endpoint that calls the existing application service rather than storage repositories directly
- [x] 1.2 Implement credential-to-profile authentication middleware and reject profile selection through tool arguments; verify cross-profile reads and writes are impossible
- [x] 1.3 Define versioned schemas for `profile_status`, `scan_jobs`, `list_opportunities`, `list_applications`, `get_application`, `request_application`, `list_confirmations`, and `resolve_confirmation`
- [x] 1.4 Add pagination, output bounds, idempotency keys for mutations, stable typed errors, and audit events; verify repeated mutations return the same durable resource
- [x] 1.5 Add MCP protocol, authorization, malformed-input, disconnect, and concurrent-client integration tests while keeping HTTP and CLI behavior compatible

## 2. Adaptive Execution Contract

- [x] 2.1 Define a provider-neutral adaptive adapter with typed observations, proposed actions, outcomes, usage, and fallback-eligibility reasons
- [x] 2.2 Route known providers to deterministic adapters first and invoke adaptive execution only for explicitly eligible unsupported forms or controls
- [x] 2.3 Implement a worker-owned action policy for origins, navigation, field sources, credential handling, document staging, confirmation state, and final submission
- [x] 2.4 Add immutable prompt boundaries that classify page content as untrusted and deny requests for secrets, policy changes, unrelated browsing, or unapproved destinations
- [x] 2.5 Enforce per-attempt step, time, token, cost, navigation, and retry budgets; convert exhaustion or uncertainty to a precise manual-review outcome

## 3. Preview, Approval, and Evidence

- [x] 3.1 Make adaptive attempts produce the existing redacted normalized field preview and preview fingerprint; verify unsupported or invented values remain unresolved
- [x] 3.2 Enforce the durable final-approval gate outside model control and verify changed previews invalidate prior approval
- [x] 3.3 Require newly observed success evidence and persisted production receipts before marking an adaptive attempt submitted
- [x] 3.4 Add redacted action traces, screenshots where policy permits, usage metrics, and policy-denial reason codes without recording credentials or applicant answers

## 4. Development Harness and Evaluation

- [x] 4.1 Add a development-only Playwright MCP/CLI workflow for capturing accessibility snapshots and generating synthetic, anonymized application fixtures
- [x] 4.2 Disable arbitrary browser-code tools and verify production agent credentials cannot reach the development browser harness
- [x] 4.3 Build a corpus covering supported ATS forms, custom controls, popups, redirects, authentication challenges, prompt injection, and confirmation boundaries
- [x] 4.4 Compare deterministic and adaptive results for completion, correctness, policy violations, latency, token usage, cost, and manual-review rate

## 5. Controlled Rollout

- [x] 5.1 Implement the first adaptive provider behind a disabled feature flag and simulation-only mode
- [ ] 5.2 Define acceptance thresholds and progress through synthetic fixtures, allowlisted preview-only domains, selected profiles, and approved submissions
- [x] 5.3 Add a runtime kill switch and verify disabling adaptive execution immediately returns unsupported forms to manual review without affecting deterministic adapters
- [x] 5.4 Run syntax, unit, MCP integration, browser, prompt-injection, privacy, dependency-audit, and OpenSpec strict validation checks before each rollout stage
