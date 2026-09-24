## ADDED Requirements

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
