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

### Requirement: Safe checkpoint evidence
The API SHALL preserve bounded typed arrays and file readback counts and flags, redact sensitive values, and SHALL NOT infer an upload from an unrelated optional file control.
#### Scenario: Detached resume readback
- **WHEN** the final resume attachment cannot be established
- **THEN** bounded acknowledgement, detached state and exact resume-container readback flags SHALL persist without weakening the guard

### Requirement: Verification-only live continuation
An explicit supported employer email challenge MAY retain a bounded live browser context. Continuation SHALL bind profile, application, attempt, destination and exact approved preview. Codes SHALL remain transient and absent persistent state, request caches, logs and errors. No new permit or initial submission SHALL occur.
#### Scenario: Current authorized challenge
- **WHEN** current authority and exact live binding remain valid before a verified challenge-only control action
- **THEN** one continuation MAY capture an actual employer receipt without repeating initial Submit
#### Scenario: Expired or lost session
- **WHEN** a session expires, changes destination, closes or is lost on restart
- **THEN** an outcome hold SHALL remain with no automatic replay

### Requirement: Exact acknowledged Teamtailor resume
The executor SHALL distinguish a Teamtailor remote resume success preview from its reset native file input. It SHALL require one exact resume container, one completed preview, matching filename, enabled matching remote URL input and removal of progress. Current uploaded document content and remote URL hashes SHALL bind the exact review. An unrelated attachment or body filename SHALL NOT count.
#### Scenario: Native input reset after successful upload
- **WHEN** exact current resume storage success is acknowledged while an optional attachment input remains
- **THEN** final review MAY use the bound completed resume preview
#### Scenario: Changed resume preview
- **WHEN** URL, filename, preview cardinality, upload progress or acknowledgement changes
- **THEN** final review SHALL hold before permit commit and Submit

#### Scenario: Upload rerender within the same live attempt
- **WHEN** the native resume input is replaced after this worker acknowledged the current document
- **THEN** private live-page evidence MAY reuse only the same document content hash, size, filename and acknowledged remote URL hash, without a second upload
- **AND** an unknown preexisting attachment SHALL remain held

#### Scenario: Exact approval survives a fresh storage URL
- **WHEN** a new worker context uploads the same reviewed document bytes under a different ephemeral storage URL
- **THEN** canonical approval SHALL bind the unchanged document content SHA, name and size, while the new live URL SHALL be independently acknowledged and guarded
- **AND** changed document content, owner facts, question or destination SHALL invalidate approval

### Requirement: Verification-only live-session continuation
The worker SHALL retain a supported explicit Greenhouse post-submit email-code form for at most15minutes. The authenticated continuation SHALL bind the same profile, application, consumed attempt, destination, exact approved fingerprint, current policy, and current profile/answer authority hash. The code SHALL remain transient and SHALL bypass request idempotency persistence. This continuation SHALL use only the captured unambiguous code-form action, never reset the original final permit or repeat initial application Submit. Successful receipt capture SHALL close the retained browser context. Expired, restarted, closed, changed, unauthorized, and already-claimed sessions SHALL remain outcome holds.

#### Scenario: Live code form yields a verified receipt
- **WHEN** the initial final action shows the exact supported code form and the authenticated owner-delegated code continuation passes all bindings
- **THEN** the worker performs one verification action and persists the receipt against the original final-action marker without creating another application or permit

#### Scenario: Closed attempt cannot resume
- **WHEN** a process restart or expired/closed browser removes the live session
- **THEN** the continuation refuses the code and preserves the uncertain outcome without another application Submit

### Requirement: Exact Teamtailor receipt route with ancillary form
The worker SHALL recognize a newly reached same-origin, same-role applications/UUID/thanks route with explicit employer receipt text and no invalid controls as successful even when a separate Connect-profile form remains. Unrelated roles/origins, missing receipt text, and invalid controls SHALL not qualify through this rule.

#### Scenario: Ancillary Connect form does not obscure receipt
- **WHEN** a new same-role application UUID thanks route displays explicit receipt text and only an ancillary Connect form remains without invalid controls
- **THEN** the receipt detector recognizes submission; unrelated destinations and missing receipt text remain unverified

### Requirement: Explicit official remote metadata survives nullable or escaped transport
The official scan, destination verification, and current-role revalidation SHALL use the same remote predicates. A null or missing Ashby remote flag may use an explicit remote role location; false flags and onsite/hybrid workplace contradictions SHALL hold. An HTML-escaped leading Greenhouse Remote - region role header may establish remote status; generic company prose SHALL not. This classification SHALL not establish applicant country eligibility or replace complete agent fit review, policy, exact canonical destination, dedupe or source budgets.

#### Scenario: Official explicit remote role is not lost to nullable metadata
- **WHEN** an exact current Ashby role has a null flag and Remote location or a Greenhouse role has a decoded leading Remote - EMEA header
- **THEN** scan and destination verification retain it for full fit review and revalidation uses the same predicate

#### Scenario: Contradictory or generic evidence remains held
- **WHEN** the flag is false, workplace is hybrid/onsite, wording requires office work, or only company prose mentions remote
- **THEN** the missing-flag/header fallback does not authorize the role

### Requirement: Preserve the original form during email verification
The worker SHALL retain a supported explicit employer email-code challenge when the original application form remains visible. It SHALL scope only the labeled security or verification code control, preserve and recheck all other application input values, reject ambiguous code controls, and use the unchanged exact challenge form and button. Closed attempts SHALL remain non-retryable.

#### Scenario: Original form remains visible
- **WHEN** the employer adds one labeled eight-character security code input to the existing application form
- **THEN** the worker retains the live attempt and permits only verification of that code with unchanged original inputs

#### Scenario: Application values change during verification
- **WHEN** an original non-code input changes or a second code input appears
- **THEN** no verification click or receipt occurs

### Requirement: Preserve review-only continuation across public feed adapters
RemoteOK and Arbeitnow SHALL pass the current title, company, description and destination into the same profile-bound handled predicate before their existing result limit. An unchanged irrelevant review SHALL not consume the next result batch. Changed postings SHALL remain reviewable. Submitted and uncertain-final identities SHALL remain handled. Provider page limits, request budgets, rate-limit stops and raw-row reporting SHALL remain unchanged.

#### Scenario: Arbeitnow retained reviewed rows precede an unseen row
- **WHEN** the first two retained current postings have unchanged irrelevant reviews for this profile
- **THEN** a limit-two review-only scan returns the following unseen posting without increasing provider requests or treating the source as exhausted

### Requirement: Unanswered optional legal controls preserve non-consent
The service SHALL review filled legal answers and SHALL allow optional legal controls to remain unanswered without implying consent. Required unanswered controls SHALL remain blocked.

#### Scenario: Optional mixed marketing checkbox unchecked
- **WHEN** the preview leaves an optional marketing consent control unfilled
- **THEN** that control requires no consent approval and all other final guards remain active

#### Scenario: Required legal checkbox unanswered
- **WHEN** the preview leaves a required legal control unfilled
- **THEN** the required-field gate blocks submission
