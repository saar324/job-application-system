## ADDED Requirements

### Requirement: Post-submit email verification remains uncertain and fenced
When an employer asks for an emailed security code after the authorized final click, the worker SHALL identify that requirement separately from an unknown submission outcome. It SHALL keep the durable final-action marker, request manual completion of the existing employer verification flow, and SHALL NOT record a receipt or automatically click Submit again. A retry request SHALL check the worker's durable final-action state before requeueing.

#### Scenario: Greenhouse requests an eight-character email code after Submit
- **WHEN** the Greenhouse page changes from the reviewed application form to a visible security-code form with eight one-character boxes after the final click
- **THEN** the application pauses as `submission_email_verification`, tells the owner to finish the existing verification flow and verify the outcome, and remains without a receipt and fenced against automatic retry

### Requirement: Broadened discovery has a separate advisory release stage
The system SHALL keep newly broadened roles from a source in advisory/manual fit review until the paired quality promotion gate passes. A private source-specific flag SHALL default off and SHALL be reversible independently. The server SHALL derive and durably store advisory provenance from fetched role evidence; request metadata SHALL NOT grant or erase this status. Campaign selection, reserve replacement, standing policy intake, automatic final permit, and final permit commit SHALL NOT automatically submit an advisory role. An already stored baseline role SHALL retain its existing submission policy when broader retrieval is enabled. Every newly stored role from a flagged source SHALL be advisory, including an exact-title role that appears only on a later page. Stage 1 SHALL NOT be reported as passing the prose-quality gate or ten-receipt throughput target.

#### Scenario: A broadened role is found on a flagged source
- **WHEN** an official ATS title variant or added board yields a role outside the pre-broadening configured-board path
- **THEN** the role remains visible with advisory provenance, but no automatic application or final-action permit is created

#### Scenario: A source flag is disabled after discovery
- **WHEN** a previously flagged source is rolled back or the same role is discovered again
- **THEN** new broadened retrieval stops and the already stored advisory role remains in manual review rather than gaining standing-policy authority

#### Scenario: A configured-board baseline role is found
- **WHEN** an unflagged configured-board role matches the pre-broadening configured-title path and all existing policy gates
- **THEN** its existing automatic submission behavior is preserved without advisory provenance

#### Scenario: A flagged source finds an exact-title late-page opening
- **WHEN** a source flag is on and a new configured-title role appears on a later fetched page
- **THEN** the role is advisory because the old path did not prove it would have been observed

#### Scenario: A caller forges or omits advisory metadata
- **WHEN** a caller adds or re-adds an opportunity with release-stage fields
- **THEN** the server ignores those fields and never removes a server-owned advisory marker

### Requirement: Substantive application answers are specific and grounded
For substantive prose, the system SHALL use the current question, role requirements, current employer evidence, and verified applicant examples. Each applicant example SHALL record an ID, exact facts, source, owner approval or independent verification, scope, and review date. Each material applicant and employer claim SHALL map to supporting evidence; a reference to an existing evidence ID alone SHALL NOT establish support. An independent review SHALL check claim support and question responsiveness before automatic final action. If a draft or review provider is unavailable, new prose SHALL receive explicit manual review and automatic final action SHALL be held. If evidence is insufficient, the system SHALL ask for research or applicant input rather than produce generic or invented text. Optional substantive questions SHALL be evaluated for value and answered only when specific supported content is available.

#### Scenario: Company motivation has only a generic listing
- **WHEN** a form asks why the applicant wants this role and the listing contains no useful company context or applicant example
- **THEN** the system requests targeted official research or applicant input and does not draft boilerplate praise

#### Scenario: A draft cites a valid evidence ID but adds an unsupported achievement
- **WHEN** a draft claims an applicant project or impact that is absent from verified profile examples despite citing `applicant:skills`
- **THEN** the draft fails claim-level validation and cannot reach automatic final submission

#### Scenario: Draft or independent reviewer is unavailable
- **WHEN** an application needs new substantive prose and its configured draft or review provider is unavailable
- **THEN** the prose goes to explicit manual review and automatic final submission remains held

#### Scenario: Same employer asks a different role-specific question
- **WHEN** an approved answer exists for the employer but its project example or role focus does not fit the new opening
- **THEN** the answer is not reused without review and a revised grounded answer is prepared

#### Scenario: A relevant optional question can strengthen the application
- **WHEN** a company asks for an optional, substantive example and verified evidence can answer it specifically
- **THEN** the system considers filling it and includes it in the complete final review

### Requirement: Quality gates precede speed promotion
The system SHALL freeze the old-path outputs and a privacy-safe development corpus of at least 30 cases plus a separate holdout of at least 100 cases before search, ranking, or drafting behavior changes. The corpus SHALL include accepted and rejected roles, nonexact titles, geographic conflicts, same-title distinct openings, optional prose, stale reusable answers, and unsupported claims. Two reviewers blind to old/new labels SHALL score fit, question relevance, company specificity, and factual support, with disagreements adjudicated. Promotion SHALL require zero critical unsupported applicant claims, unconfirmed legal answers, duplicate final actions, or false receipts; no decrease in paired median quality score; and no more than a five percentage point decline in cases rated at least four out of five on the holdout. A smaller holdout SHALL NOT be described as passing that percentage gate. The live ten-application pilot SHALL manually audit all ten selected roles and substantive answers before any throughput success claim. Quality promotion SHALL take precedence over speed milestones.

#### Scenario: Speed improves but quality declines
- **WHEN** the new path is faster but a critical claim is unsupported or its rated quality fails the gate
- **THEN** the new path is not promoted and the report records the quality failure alongside timing
