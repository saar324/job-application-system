## ADDED Requirements
### Requirement: Exact authenticated field review
The system SHALL bind approved field provenance to authenticated profile and reviewer, policy version, role destination, answer value and complete preview fingerprint.
#### Scenario: Reviewed known facts
- **WHEN** each held answer has verified matching provenance and the exact review remains current
- **THEN** ordinary final-policy checks can issue one permit
#### Scenario: Unknown or changed content
- **WHEN** a field is unknown, legal scope uncovered, fingerprint changed or prior permit consumed
- **THEN** review SHALL NOT issue a permit
### Requirement: Coherent measurable execution
Health SHALL expose nonsecret release identity and active/queued execution counts. Execution SHALL record queue delay alongside stage timings. Release checks SHALL verify API and worker identities match before live execution.

#### Scenario: Paired release and queue visibility
- **WHEN** a tested API and worker are released
- **THEN** both health responses SHALL identify the same revision and report actual execution queue state

### Requirement: Finite safe discovery funnel
The pipeline SHALL distinguish observed raw roles, canonical unseen roles, current official roles, fit-eligible roles, verified destinations, prepared forms and new verified receipts. It SHALL preserve source cursors, historical unknown budgets and403/429/challenge stops. Indexed stale roles and absent eligible supply SHALL NOT be reported as worker failure or global market exhaustion.
#### Scenario: Complete eligible flow
- **WHEN** normal consideration verifies an eligible current official role and the executor is available
- **THEN** the browser SHALL fill, review, submit once and persist a verified receipt
- **AND** simulated fixture receipts SHALL NOT count in real batch totals
#### Scenario: Independent destination or access hold
- **WHEN** a route is unverified, blocked by policy, inaccessible or human challenged
- **THEN** the system SHALL save a specific checkpoint without expanding host permissions or retrying uncertain final actions

### Requirement: Bounded unseen ATS continuation
Official ATS queries SHALL remove unchanged profile-bound irrelevant postings before the adapter result cap using their exact normalized public posting fingerprint. They SHALL preserve existing handled applications, source request budgets and changed-posting re-review. A selected result cap SHALL NOT imply source exhaustion.
#### Scenario: Reviewed first window
- **WHEN** the first bounded ATS rows have unchanged irrelevant decisions and later unseen roles exist
- **THEN** the later unseen roles SHALL occupy the returned window without extra provider requests or source budget reset
#### Scenario: Changed or other-profile posting
- **WHEN** a reviewed posting changes or its irrelevant decision belongs to another profile
- **THEN** the posting SHALL remain available for fit review
#### Scenario: Previously executed posting
- **WHEN** a posting has a handled application or uncertain final action for this profile
- **THEN** its existing canonical identity protection SHALL remain effective

### Requirement: Exact observed multiselect execution
For an observed multi-value combobox the executor SHALL select supplied array options independently and SHALL preserve an exact selected set in live readback, review preview and checkpoint. It SHALL NOT serialize the array into a guessed comma-joined option.
#### Scenario: Verified language array
- **WHEN** the observed multi control exposes each known supplied option
- **THEN** the executor SHALL select each option and present the typed array for exact review
#### Scenario: Changed or unknown selection
- **WHEN** an option is unknown, ambiguous, missing, changed or extra at final readback
- **THEN** the executor SHALL hold before permit commit or submission
#### Scenario: Ordinary single selection
- **WHEN** the control is a single-value combobox
- **THEN** existing scalar selection SHALL remain supported and an array SHALL NOT become a guessed scalar
