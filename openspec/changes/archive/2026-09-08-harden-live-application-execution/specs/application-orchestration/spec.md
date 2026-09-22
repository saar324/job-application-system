## Purpose

Ensures application execution is durable, bounded, non-blocking for chat clients, and resistant to duplicate submissions during concurrency or failure.

## ADDED Requirements

### Requirement: Application admission is atomic
The server SHALL evaluate opportunity existence, duplicate application state, global daily capacity, mode daily capacity, and application creation in one serialized state mutation.

#### Scenario: Concurrent requests for one opportunity
- **WHEN** two requests attempt to apply to the same profile opportunity concurrently
- **THEN** exactly one application is created and the other receives the existing-application conflict

#### Scenario: Concurrent requests at the cap
- **WHEN** concurrent requests arrive with one remaining daily slot
- **THEN** at most one non-skipped application consumes that slot

### Requirement: Execution is asynchronous
The server SHALL return a durable `queued` application without waiting for browser automation and SHALL process queued applications independently of the originating HTTP connection.

#### Scenario: Slow browser application
- **WHEN** browser execution takes longer than the CLI request timeout
- **THEN** the client already has the application ID and can observe its later status without retrying admission

### Requirement: Queue claims are exclusive
The server SHALL atomically transition an application from `queued` to `submitting`, and only the successful claimant SHALL call the execution adapter.

#### Scenario: Duplicate queue delivery
- **WHEN** the same application ID is enqueued more than once
- **THEN** the execution adapter is invoked once

### Requirement: Interrupted submissions recover conservatively
The server SHALL resume persisted `queued` applications after restart and SHALL never automatically retry an application found in `submitting` state after restart.

#### Scenario: Restart with queued work
- **WHEN** the server starts with a persisted queued application
- **THEN** it schedules that application for execution

#### Scenario: Restart during submission
- **WHEN** the server starts with an application persisted as submitting
- **THEN** it creates one manual-review confirmation describing the uncertain submission and waits for explicit review

### Requirement: Execution uncertainty is not failure
Timeouts or lost worker responses that could occur after a submit action SHALL produce manual review rather than a retryable failed state.

#### Scenario: Worker response timeout
- **WHEN** the server loses the worker response after execution began
- **THEN** the application waits for manual verification and is not automatically retried
