## ADDED Requirements

### Requirement: Unseen candidates are available before relevance scoring

The system SHALL provide a bounded agent-review scan that returns unseen public listing evidence before numeric fit scoring or employer destination resolution. It SHALL preserve source request and pagination limits.

#### Scenario: Low-score role reaches agent review

- **WHEN** a configured source returns an unseen posting that meets explicit work-arrangement and employment preferences but scores below the legacy threshold
- **THEN** the agent-review scan returns it without opening an application form

#### Scenario: Handled role is filtered

- **WHEN** a role has already been submitted, attempted, or explicitly skipped as irrelevant for the authenticated profile
- **THEN** the scan and browser-candidate filter omit its canonical ATS identity before agent fit review

### Requirement: An agent fit decision is bound to a fresh official posting

The system SHALL accept relevant, irrelevant, and uncertain fit decisions. A relevant decision SHALL trigger fresh official destination verification and SHALL bypass the old numeric score and inferred skill gates only while the reviewed posting fingerprint still matches. Simple explicit work-arrangement, employment-type, and excluded-title preferences SHALL still apply. The decision SHALL NOT grant submission authority.

#### Scenario: Relevant low-score official role

- **WHEN** the agent marks an unseen role relevant with a reason and the official ATS confirms the same current title, company, and destination
- **THEN** the system records the posting-bound decision and prepares the role through the normal application policy

#### Scenario: Changed official role

- **WHEN** the official ATS title or company differs from the reviewed listing
- **THEN** the system returns the official posting for another fit review without starting an application

#### Scenario: Explicit remote mismatch

- **WHEN** the saved profile requires remote work and the verified posting is on-site or hybrid
- **THEN** the system filters the role despite a relevant model verdict

#### Scenario: Irrelevant or uncertain role

- **WHEN** the agent marks a role irrelevant
- **THEN** the system stores its role identity for later filtering and starts no application
- **WHEN** the agent marks a role uncertain
- **THEN** the system starts no application and does not mark the role handled
