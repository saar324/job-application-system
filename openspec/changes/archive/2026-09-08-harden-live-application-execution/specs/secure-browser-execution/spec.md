## Purpose

Protects the host system and applicant data while automating untrusted job websites, and defines reliable behavior for documents, forms, and submission evidence.

## ADDED Requirements

### Requirement: Dedicated worker security boundary
The production browser worker SHALL run as an operating-system principal distinct from the the host system/OpenClaw user, SHALL have no access to the host system home data, and SHALL have write access only to its dedicated runtime directory.

#### Scenario: Worker process permissions
- **WHEN** the production worker service is inspected
- **THEN** it runs as the dedicated worker principal with home protection, system protection, no privilege escalation, and only its runtime directory writable

### Requirement: Application documents are staged safely
The server SHALL resolve application document paths against configured source roots, accept only regular supported files within those roots and the configured size limit, and copy only the required documents into the worker staging root.

#### Scenario: Valid resume
- **WHEN** a profile references a supported resume inside an allowed source root
- **THEN** the server stages it under the application ID and sends the worker only the staged path

#### Scenario: Escaping or unsafe document
- **WHEN** a profile references a path outside the allowed roots, a symlink escaping a root, a non-regular file, an unsupported extension, or an oversized file
- **THEN** the application pauses with an actionable document confirmation and no worker submission begins

### Requirement: Worker validates its inputs
The worker SHALL reject malformed application/profile identifiers, profile mismatches, and document paths outside its staging root before launching an application flow.

#### Scenario: Arbitrary file path
- **WHEN** a worker request contains `/etc/passwd` or another non-staged document path
- **THEN** the worker rejects the request without opening the target job page

### Requirement: Standard file controls are supported
The worker SHALL populate native file inputs even when the input itself is visually hidden, while unsupported custom controls SHALL produce a manual-review result.

#### Scenario: Hidden resume input
- **WHEN** a standard application form uses a CSS-hidden native file input for the resume
- **THEN** the worker attaches the staged resume and continues the form

### Requirement: Submission evidence is newly observed
The worker SHALL record submission only when the submit action causes a new confirmation URL or newly appearing success message; success-like text already present before submission SHALL not count.

#### Scenario: Pre-existing success wording
- **WHEN** a form contains instructional text such as “you will receive confirmation after your application is submitted” before Submit and no new confirmation appears afterward
- **THEN** the worker returns manual review rather than a submitted receipt

### Requirement: Worker submission is idempotent
The worker SHALL serialize requests by application ID and persist verified results before responding, returning the same receipt for an identical repeated request.

#### Scenario: Repeated successful request
- **WHEN** the same application request is received again after a verified submission
- **THEN** the worker returns the stored receipt without reopening the job site

#### Scenario: Reused ID with different payload
- **WHEN** an application ID is reused with a different profile or opportunity fingerprint
- **THEN** the worker rejects it for manual review
