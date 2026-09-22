## Purpose

Extends application coverage through a deterministic-first, policy-constrained model fallback while preserving profile evidence, browser isolation, approval gates, and verifiable submission receipts.

## ADDED Requirements

### Requirement: Deterministic adapters have precedence
The worker SHALL use a supported provider adapter before adaptive execution and SHALL invoke the adaptive adapter only for an explicitly fallback-eligible unsupported form or control.

#### Scenario: Known adapter reports a security policy failure
- **WHEN** a deterministic adapter stops because navigation, authentication, or document policy is violated
- **THEN** adaptive execution is not attempted and the original safe outcome is retained

#### Scenario: Unknown custom form is allowed for fallback
- **WHEN** no deterministic adapter supports a public allowlisted form and adaptive execution is enabled for the profile
- **THEN** the worker may start a bounded adaptive attempt under the same browser and application policies

### Requirement: Page content cannot change policy or authority
The system SHALL treat all page content and accessibility data as untrusted form evidence, and a model-proposed action SHALL NOT change network policy, reveal secrets, alter confirmation state, or authorize submission.

#### Scenario: Page instructs the agent to reveal a credential
- **WHEN** visible or hidden page content asks the model to output, paste, or transmit a credential
- **THEN** the action is denied, no secret is disclosed, and the attempt records a prompt-injection policy reason

### Requirement: Filled answers require authoritative sources
Adaptive execution SHALL fill applicant facts only from stored profile evidence, an approved confirmation answer, a deterministic safe transformation, or an origin-bound credential handled outside model context.

#### Scenario: Model proposes a plausible unknown answer
- **WHEN** a required question has no authoritative stored or approved answer
- **THEN** the field remains unresolved and the application requests owner input

### Requirement: Adaptive actions are bounded and policy checked
Every adaptive action SHALL be typed and validated by worker-owned policy, and each attempt SHALL enforce configured step, time, navigation, token, cost, and retry limits.

#### Scenario: Attempt reaches its step budget
- **WHEN** the model has used the maximum permitted actions without reaching a safe terminal state
- **THEN** the worker stops and returns manual review without submitting

### Requirement: Final submission remains outside model authority
The worker SHALL block the final submit action unless durable state authorizes the exact current preview, and submitted status SHALL still require newly observed success evidence and a persisted production receipt.

#### Scenario: Model attempts submit before approval
- **WHEN** the current policy requires approval and no matching preview fingerprint is approved
- **THEN** the submit action is denied and the worker returns the redacted preview for confirmation

### Requirement: Adaptive execution is independently disableable
Operators SHALL be able to disable adaptive execution globally or by profile or mode without disabling deterministic adapters or corrupting active application state.

#### Scenario: Kill switch is activated
- **WHEN** adaptive execution is disabled while unsupported applications are queued
- **THEN** those applications move to a supported manual-review outcome and known deterministic applications continue
