## ADDED Requirements

### Requirement: Pre-submit field evidence is complete and redacted
The worker SHALL report every supported field it filled, every unresolved required field, and the source of each answer before final submission, while redacting passwords and reducing document paths to safe filenames.

#### Scenario: Final approval preview
- **WHEN** a configured application reaches its final submit control
- **THEN** the worker returns a stable preview fingerprint and a summary of filled and unresolved fields without clicking Submit

#### Scenario: Secret field summary
- **WHEN** the worker fills a password or application document
- **THEN** the preview contains a redacted password marker or basename rather than the secret or source path

### Requirement: Browser resources are bounded per attempt
The worker SHALL create one isolated browser context per execution attempt and SHALL close that context and all tabs/popups in a `finally` path for every outcome.

#### Scenario: Repeated pauses
- **WHEN** an application repeatedly pauses for questions, authentication, and final approval
- **THEN** each attempt ends with zero retained tabs or contexts from that attempt

### Requirement: User-requested public domains can be opened safely
The worker SHALL allow the exact initial hostname of an explicitly user-requested direct link after rejecting local, literal-IP, and private-address destinations; redirects remain limited to the initial hostname and configured application providers.

#### Scenario: Direct employer form
- **WHEN** a user supplies a public HTTPS employer application URL not in the static provider list
- **THEN** the worker may open that exact host without broadening access to other arbitrary navigation hosts
