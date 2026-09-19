## ADDED Requirements

### Requirement: Adaptive observations are compact and generation-bound
The worker SHALL send one redacted structural snapshot followed by bounded deltas identified by an attempt-local page generation and SHALL NOT expose applicant values, credentials, document paths, tokens, or unrestricted page content through the compact protocol.

#### Scenario: A multi-step form changes one control group
- **WHEN** execution advances to the next client-side step without changing origin
- **THEN** the next provider observation contains the new generation and relevant structural changes rather than repeating unchanged page content

### Requirement: Adaptive action batches remain locally authoritative
The provider MAY propose a bounded ordered batch, but the worker SHALL validate every action immediately before execution and SHALL stop the batch on a generation change, navigation, popup, missing target, policy denial, challenge, owner-input requirement, approval boundary, or budget exhaustion.

#### Scenario: Form changes after the first batched action
- **WHEN** the first action replaces the form and a later action refers to the prior generation
- **THEN** the later action is not executed and the worker creates a fresh observation

#### Scenario: Batch includes final submission
- **WHEN** a provider proposes ordinary form actions together with a final-submit action
- **THEN** the final-submit action is separated and cannot run until the current preview, approval, and submission policies authorize it

### Requirement: Proven form recipes can replay only on strict matches
The worker SHALL replay a sanitized recipe only when its origin, structural fingerprint, schema version, and policy version are compatible, SHALL validate every replayed action, and SHALL fall back safely on the first mismatch.

#### Scenario: Employer adds a required question
- **WHEN** a cached recipe is considered for a form whose fingerprint now includes an additional required control
- **THEN** recipe replay stops before submission and ordinary deterministic or adaptive inspection handles the changed form

### Requirement: Transition waits are event-driven and bounded
The worker SHALL prefer observable navigation, popup, load, control, and DOM-generation events over fixed sleeps, SHALL retain a bounded fallback for silent transitions, and SHALL keep submission-evidence verification independent from transition timing.

#### Scenario: Client-side transition completes immediately
- **WHEN** clicking Next replaces the current form synchronously
- **THEN** the worker proceeds after observing the new generation rather than waiting for an unconditional delay

#### Scenario: Page never exposes a transition
- **WHEN** no expected event or bounded fallback condition occurs before the attempt deadline
- **THEN** execution stops with a precise review outcome and does not extend the deadline or infer success
