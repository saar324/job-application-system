## Purpose

Makes discovery and application workflows diagnosable while preserving applicant privacy and ensuring telemetry infrastructure cannot interrupt core processing.

## ADDED Requirements

### Requirement: Workflow telemetry is end-to-end correlated
The system SHALL correlate intake, discovery, scoring, admission, queueing, worker attempts, confirmations, and receipts using opaque workflow identifiers and SHALL expose durations and outcomes for each stage.

#### Scenario: Application requires owner input and later resumes
- **WHEN** an application pauses for confirmation and resumes in a later process invocation
- **THEN** operators can correlate both attempts with the same application workflow without exposing the answer

### Requirement: Operational failures use stable reason codes
The system SHALL classify discovery-source, eligibility, queue, browser-policy, form, confirmation, and receipt failures with stable reason codes and SHALL retain provider-specific diagnostic detail only in redacted operator telemetry.

#### Scenario: One discovery board fails
- **WHEN** a provider returns an error for one board while other boards succeed
- **THEN** the scan records that board failure and reports partial success rather than silently dropping it

### Requirement: Telemetry excludes applicant secrets
Telemetry SHALL NOT contain credentials, tokens, applicant answers, resume contents, full document paths, raw application form payloads, or unrestricted page content.

#### Scenario: Password field fails to submit
- **WHEN** browser execution reports an error associated with a password control
- **THEN** logs and traces identify the control category and reason without recording its value

### Requirement: Export failures do not block workflows
Application processing SHALL continue when a telemetry exporter is unavailable, subject to bounded local buffering and observable dropped-signal counters.

#### Scenario: Trace collector is offline
- **WHEN** the configured trace endpoint cannot be reached
- **THEN** application state continues to progress and the runtime reports exporter failure through local health data
