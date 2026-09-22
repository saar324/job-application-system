## ADDED Requirements

### Requirement: Direct application links are durable intake
The server SHALL accept a public HTTPS application URL from an authenticated profile, create a deduplicated user-requested opportunity, apply the normal profile readiness and daily-cap policy, and return a durable application record.

#### Scenario: User sends an application URL
- **WHEN** a profile owner sends a valid public HTTPS job application URL without discovery metadata
- **THEN** the system creates a direct opportunity and returns its queued or confirmation-required application

#### Scenario: User repeats a direct URL
- **WHEN** the same profile submits the same normalized direct URL again
- **THEN** the system returns the existing opportunity and does not create a second active application

### Requirement: Final approval is configuration-driven
The server SHALL resolve `submissionApproval` independently for each profile and mode as either `automatic` or `always`, persist the chosen behavior on the application, and require an approval matching the latest preview when set to `always`.

#### Scenario: End-to-end mode
- **WHEN** the active profile and mode resolve to automatic submission
- **THEN** a fully answered supported form may submit without final confirmation

#### Scenario: Approval mode
- **WHEN** the active profile and mode resolve to mandatory approval
- **THEN** the application stops before the final click and cannot submit until the owner approves the exact preview

#### Scenario: Form changes after approval
- **WHEN** the field preview changes between approval and the repeated browser run
- **THEN** the old approval is invalid and the system requests a new approval
