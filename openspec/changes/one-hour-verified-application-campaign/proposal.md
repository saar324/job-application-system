## Why

The 23 September pilot produced seven new verified receipts from ten approved roles in 196.75 minutes (28.11 minutes per new receipt). Preparation, approval wait, failed headless submissions, Chrome recovery, and duplicate reconciliation were included. Even the 60.70 minutes after approval extrapolate to 14.45 hours for 100 new receipts. Three roles were already submitted, and a bounded scan of all 50 configured sources produced no accepted replacements. The earlier 47-hour extrapolation is not a reliable steady-state forecast because it multiplies one-off coordination and waiting, but the measured workflow is far from the owner's goal of 100 suitable, verified applications per hour.

The owner wants to remove repeated final-submission approvals while preserving accurate, high-quality applications. The server accepts an `automatic` submission policy, but campaigns currently force `forceFinalApproval: true`; the installed agent skill also requires exact approval for each named form or batch. The default config also sets `autoApply: false` and caps total/daily applications at 10/8. The policy, service, worker, caps, and skill must change together. A config-only toggle cannot make campaigns automatic or permit a 100-role run.

## What Changes

- Add a profile-bound, revocable standing submission authorization for suitable roles within explicit policy limits. The server evaluates the policy after a complete final machine review. It submits eligible forms without another owner approval and routes exceptions to the owner.
- Make campaign creation honor that policy instead of forcing final approval. Preserve exact-preview approval as the default/fallback for profiles without standing authorization, out-of-scope jobs, and material changes.
- Replace conversation-paced per-form coordination with one durable sequential application lane, deterministic field plans, batched evidence-grounded prose drafting, live value checks, and automatic receipt recording.
- Build a continually maintained, rate-limited reserve of new official employer destinations. Filter handled roles across sources and ATS URL variants before preparation; record source yield and diagnose inaccessible or unparseable sources.
- Repair the Ashby execution path using measured regular-browser compatibility and persisted-value checks. Do not evade challenges, bypass employer controls, or submit directly to private application APIs without authorization.
- Add an end-to-end campaign trace and staged acceptance gates that count discovery, preparation, submission, exceptions, failed attempts, and verified receipts. Do not claim an hourly rate from preselected or prefilled forms.

## Capabilities

### Modified Capabilities

- `application-orchestration`: standing authorization, campaign selection, sequential submission, exception handling, and exact-once recovery.
- `secure-browser-execution`: full machine review, reliable final actions, form state replay, and receipt evidence.
- `source-query-discovery`: fresh candidate reserve, provenance, duplicate exclusion, source health, and bounded access.
- `workflow-efficiency`: complete funnel accounting and staged speed/quality release gates.

## Scope and relationship to prior changes

This change builds on `single-lane-application-efficiency` and the current campaign implementation. It supersedes that change's unconditional final-approval behavior only when a profile has an active, scoped standing authorization. It keeps one application agent and one active submission lane; server-side source fetches may run concurrently within per-origin budgets. It does not enable the same-profile concurrent submission proposal in `optimize-application-throughput`. The 23 September cross-source duplicate correction is on `codex/all-source-campaign` and must be merged and deployed before live automatic campaigns.

## Success criteria

The full target is **100 new, suitable, verified employer receipts within 60 minutes of counted work** (36 seconds per receipt), with no repeated owner approval for policy-covered forms. Milestones are 10 in six minutes and 25 in fifteen minutes on fresh suitable cohorts, followed by the 100-role test. Every test starts with a fresh eligibility and duplicate check and includes candidate acquisition/maintenance work, browser failures, recovery, and receipt verification. A cohort with fewer than the target number of eligible roles is reported as a supply shortage, not a speed pass. Automatic submission must produce zero known duplicate final actions, unsupported applicant claims, silently accepted legal attestations, false submitted states, or cross-profile leaks. The hour target is a hypothesis until a qualifying live run proves it.
