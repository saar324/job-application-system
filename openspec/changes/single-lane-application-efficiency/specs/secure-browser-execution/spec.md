## ADDED Requirements

### Requirement: A form step is inventoried before answers are applied
The worker SHALL extract a typed inventory of all accessible active controls on the current step and SHALL construct a versioned answer plan with value provenance and validation outcomes before filling that step. It SHALL inventory subsequent steps after safe non-final navigation and SHALL not claim to know undisplayed future fields from the browser alone.

#### Scenario: An application has multiple pages
- **WHEN** the worker reaches a Next action after verifying the current step
- **THEN** it advances without submitting, inventories the new step, and adds its fields to the cumulative plan

#### Scenario: A conditional question appears
- **WHEN** selecting an option reveals a new required control
- **THEN** the worker re-inventories the current step and resolves the new control before advancing

### Requirement: Deterministic field mapping is unambiguous and verified
The worker SHALL use explicit normalized aliases, field type, and context to map verified profile data; SHALL validate values against known constraints; and SHALL read filled values back from the live page. It SHALL leave ambiguous or unsupported mappings unresolved.

#### Scenario: Referral email and applicant email coexist
- **WHEN** a form contains both controls
- **THEN** only the applicant email control receives the profile email automatically

#### Scenario: A value fails page validation
- **WHEN** the page rejects a planned value or reports an inline error
- **THEN** the worker re-inspects the step and repairs only from authoritative data, or requests owner input

#### Scenario: A prior work-authorization answer has a different jurisdiction
- **WHEN** a reusable answer was approved for a different country or an unscoped legacy question
- **THEN** the worker does not apply it automatically and asks the owner for the current question

### Requirement: Model drafting is bounded to eligible open text
The worker SHALL send only unresolved eligible prose fields and minimal relevant evidence to the model, SHALL require typed field-bound drafts with evidence references, and SHALL never infer unknown personal facts or legal attestations.

#### Scenario: A new prose answer is drafted
- **WHEN** the draft does not match an already approved reusable answer
- **THEN** it is included in the complete owner review and cannot be submitted under automatic approval alone

#### Scenario: The employer prohibits AI-written answers
- **WHEN** the listing or application explicitly requires human-only authorship
- **THEN** the worker does not draft or submit an AI-written answer and hands the application to the owner

#### Scenario: Current evidence cannot support a company answer
- **WHEN** a company-specific question lacks enough official context for a grounded draft
- **THEN** the worker returns `needs_research` with the exact question, the coordinator obtains bounded official evidence, and a fresh attempt rechecks the form before using it

#### Scenario: Research still cannot support a draft
- **WHEN** bounded official research cannot establish enough evidence for a company-specific answer
- **THEN** the worker leaves the field unresolved and asks for owner review rather than inventing a claim or researching indefinitely

#### Scenario: Work authorization is unknown
- **WHEN** the form asks for a work-authorization fact absent from approved profile data
- **THEN** the field remains unanswered and a durable owner question is created

### Requirement: Final review reflects observed values on every step
The worker SHALL produce a cumulative, redacted review containing every observed filled and unfilled field, its source, validation state, and step; SHALL fingerprint complete verified observed values before display truncation; and SHALL revalidate before final-submit in every approval mode. When owner approval is required, the owner-facing review SHALL make every field and the full text of every non-secret answer available, including through numbered parts when one message is too small.

#### Scenario: A long answer exceeds a message limit
- **WHEN** the full preview cannot fit in one presentation
- **THEN** it is split or served as one complete private artifact, and approval refers to the fingerprint of the complete content

#### Scenario: A previous step changed during replay
- **WHEN** a resumed or revisited step yields a different observed value or form signature
- **THEN** the earlier approval is invalidated and a new complete review is required

### Requirement: Navigation and submission have distinct recovery paths
The worker SHALL classify non-final transitions separately from final submission, use bounded event-driven waits, detect cycles and validation blocks, and never retry an ambiguous final submission without reliable outcome evidence.

#### Scenario: Next and Submit are both visible
- **WHEN** a page contains a Next control for the active step and a Submit control elsewhere
- **THEN** the worker does not select the Submit control solely because its text matches a final-action pattern

#### Scenario: A disabled duplicate Apply control is rendered
- **WHEN** a live Apply button and a disabled floating Apply button share the same text
- **THEN** the worker selects only the enabled control and proceeds to the application form

#### Scenario: Next does not advance because a required field is missing
- **WHEN** the form remains on the same step and shows a validation error
- **THEN** the worker inventories the missing field and does not mark the application submitted

#### Scenario: JavaScript validation requires a field without a native required attribute
- **WHEN** Continue leaves the same step visible and adds an inline error beside a control
- **THEN** the worker requests that control and its validation message before retrying the step

#### Scenario: An upload uses custom inline validation
- **WHEN** the final screen has an empty file control and shows an upload error
- **THEN** the worker requests the file before final approval and does not report a changed previously uploaded file

#### Scenario: Final click has no reliable confirmation
- **WHEN** the final action may have run but no new receipt evidence appears
- **THEN** the application enters manual review without automatic resubmission

#### Scenario: Final-click validation rejects a missing field
- **WHEN** the site clearly rejects the form before any application is created and identifies a missing field
- **THEN** the worker re-inventories that step, repairs only from an authoritative answer, and generates a new complete review before any second final click

#### Scenario: Validation changes a page containing old success text
- **WHEN** a failed final click changes the page body while generic success text was already present
- **THEN** the body change alone is not accepted as submission evidence

#### Scenario: The worker response is lost during an attempt
- **WHEN** the server times out or restarts without receiving a typed worker result
- **THEN** it fences the application as uncertain and requires the old worker attempt to finish plus receipt and employer-outcome reconciliation before any retry, even though its `submitting` state may have begun before the browser opened

#### Scenario: A browser proxy tunnel closes unexpectedly
- **WHEN** either side of an HTTPS CONNECT tunnel reports a socket write error
- **THEN** the proxy closes that tunnel without crashing the worker or claiming a submission receipt

#### Scenario: The worker finishes after the client deadline
- **WHEN** the HTTP client gives up but the original worker continues and later records a submission receipt
- **THEN** the server does not dispatch a second browser run and reconciles that receipt with the uncertain application

#### Scenario: A draft times out before final action
- **WHEN** the server receives a valid typed worker response certifying that no final action began
- **THEN** it records a safe pre-submit pause separately from an uncertain submitted outcome and may requeue within the bounded budget

### Requirement: A resumed server attempt reconstructs the form in a fresh context
The worker SHALL return a bounded versioned checkpoint at pause boundaries, and the adapter and server SHALL persist it with the resulting state before completing the server transition. The worker SHALL close the browser context for that attempt, then re-inspect and safely replay pre-submit steps on the next attempt. It SHALL not treat a prior locator or abandoned page as a live resumable session.

#### Scenario: An owner answers a question from step two
- **WHEN** the application resumes after confirmation
- **THEN** the worker opens a fresh context, reconstructs steps one and two with approved answers, and compares the full observed preview before final submission
