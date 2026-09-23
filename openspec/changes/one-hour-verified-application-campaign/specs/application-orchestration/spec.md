## ADDED Requirements

### Requirement: Standing submission authorization is explicit, scoped, and revocable
The service SHALL allow only a separately authenticated profile owner, not an agent token or ordinary profile PATCH, to enable, widen, or revoke a versioned standing submission policy. It SHALL derive profile identity from authenticated credentials, enforce policy scope and caps at the pre-final boundary, and default to exact final-preview approval when no active policy covers the application. Campaign start alone SHALL NOT authorize submission.

#### Scenario: A covered form reaches final review
- **WHEN** an active owner-enabled policy covers the mode, role, destination, answer classes, and current caps, and all final machine checks pass
- **THEN** the service records a policy decision bound to the observed final preview and permits the worker to submit without another owner approval

#### Scenario: The policy is absent or revoked
- **WHEN** an application reaches the final boundary without an active covering policy
- **THEN** the service creates or retains an exact fingerprinted owner approval and does not allow automatic final action

#### Scenario: An agent tries to enable its own authority
- **WHEN** a profile-bound agent token calls the policy mutation route or ordinary profile PATCH with a policy field
- **THEN** the service rejects the change and leaves submission authorization unchanged

#### Scenario: The owner narrows a policy while an application is queued
- **WHEN** a queued application's prior decision refers to an older or revoked policy version
- **THEN** the service re-evaluates the current policy before final action and holds the application if it is no longer covered

#### Scenario: The owner revokes after review but before the click
- **WHEN** the policy is revoked or a cap is reached after a pre-final review
- **THEN** the immediately pre-click permit check rejects the stale decision and no final click occurs

#### Scenario: Default automatic application mode is disabled
- **WHEN** a role is covered by an active standing policy but the mode default is `autoApply: false`
- **THEN** the service may prepare it under the policy without creating a redundant `manual_policy` confirmation, while uncovered roles retain that confirmation

#### Scenario: The owner authorizes a 100-role daily ceiling
- **WHEN** the owner explicitly sets a policy cap within the allowed schema range
- **THEN** the service enforces that cap on reserved final actions across campaign waves and does not consume it for skipped records or duplicate discoveries

### Requirement: Automatic final review stops on factual and site exceptions
The service SHALL hold automatic submission for unknown applicant facts, unconfirmed legal attestations, conflicting compensation or availability, employer authorship restrictions, authentication challenges, ambiguous destinations or final controls, changed form values, and uncertain earlier final actions, regardless of the mode's `requireConfirmationFor` setting. The hold SHALL identify the precise missing action, persist a resumable checkpoint, and release the sequential lane.

#### Scenario: A required legal question has no confirmed answer
- **WHEN** the form asks a work-authorization or other legal question absent from valid profile facts
- **THEN** the application waits for the owner's exact answer and no final submission action occurs

#### Scenario: An unrelated application is ready
- **WHEN** one application is held for a fact, challenge, or uncertain outcome and another is ready
- **THEN** the one reusable agent may process the ready application without opening a concurrent submission lane

#### Scenario: A completed answer plan changes before final click
- **WHEN** a field, upload, destination, or role key differs materially from the approved machine decision
- **THEN** the decision is invalidated and the full current form is checked again before any final action

### Requirement: Campaign approval mode follows the current profile policy
Campaign selection SHALL NOT unconditionally force final owner approval. It SHALL use the same authenticated policy evaluator as direct and ordinary application intake, while preserving exact fingerprinted approval for uncovered forms and existing pending confirmations.

#### Scenario: A campaign contains covered and uncovered roles
- **WHEN** a campaign prepares both policy-covered and out-of-scope forms
- **THEN** only covered forms may proceed automatically; uncovered forms wait for their own exact review without blocking the covered queue

#### Scenario: A confirmation predates policy enablement
- **WHEN** an owner enables standing authorization while a prior final approval remains pending
- **THEN** the prior confirmation is not auto-approved; the application receives a new policy decision only after a safe, explicit replay and complete current review

### Requirement: One final action has one durable outcome path
The service SHALL reserve each role per profile, durably record the worker phase before a final click, and prevent a second final action while an earlier outcome is uncertain. It SHALL mark `submitted` only with a verified employer receipt and SHALL count previously submitted roles separately from new receipts.

#### Scenario: A worker response is lost after the final action starts
- **WHEN** the client times out or disconnects after the durable final-action marker
- **THEN** the application is fenced until employer-side evidence or a late receipt resolves the outcome; an automatic retry cannot click Submit again

#### Scenario: A listing and direct URL identify the same submitted role
- **WHEN** a new candidate matches an existing submitted ATS role key or verified receipt destination
- **THEN** it is handled as a duplicate before form preparation and cannot consume a new submission slot
