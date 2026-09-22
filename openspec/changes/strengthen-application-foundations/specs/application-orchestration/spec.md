## ADDED Requirements

### Requirement: Durable state mutations are transactional
The server SHALL persist opportunity admission, application transitions, attempt claims, confirmations, receipts, and audit events in transactions that preserve uniqueness and state-machine invariants across concurrent processes and restarts.

#### Scenario: Concurrent admission from separate processes
- **WHEN** two authenticated requests in separate server processes attempt to create an application for the same profile opportunity
- **THEN** exactly one application is created and both requests observe a consistent durable result

#### Scenario: Process exits during a state mutation
- **WHEN** the server exits before a multi-record mutation commits
- **THEN** none of that mutation becomes visible after restart

### Requirement: Profile execution lanes progress independently
The scheduler SHALL serialize execution for each profile independently and SHALL enforce a configurable global concurrency bound without allowing one profile's pending confirmation or slow application to block another profile.

#### Scenario: One profile waits for confirmation
- **WHEN** profile A has an application waiting for owner input and profile B has queued work
- **THEN** profile B can be claimed and executed within the configured global limit

### Requirement: Claim recovery respects the submission uncertainty boundary
The server SHALL recover an expired claim automatically only when durable state proves browser execution did not begin; once external execution may have begun, interruption SHALL require manual review and SHALL NOT trigger automatic retry.

#### Scenario: Claim expires before worker invocation
- **WHEN** a claimant exits after reserving queued work but before recording the execution boundary
- **THEN** the application becomes eligible for a new claim after the lease expires

#### Scenario: Claim expires after worker invocation
- **WHEN** the claimant exits after recording that browser execution began
- **THEN** the application waits for manual verification and no new worker invocation occurs automatically

### Requirement: Explicit direct intent supersedes discovery rank
When an authenticated profile directly requests a normalized URL that already belongs to a discovered opportunity, the server SHALL reuse that opportunity, record user-requested provenance, and evaluate admission as explicit intent rather than using the prior discovery score.

#### Scenario: Low-scoring discovered URL is requested directly
- **WHEN** an opportunity was previously skipped or ranked below threshold and its owner directly requests the same normalized URL
- **THEN** the server admits the direct request under normal readiness, eligibility, duplicate-application, and daily-cap rules without retaining the low score as a blocking condition
