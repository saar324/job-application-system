## ADDED Requirements

### Requirement: Discovery breadth is independent of automatic eligibility
The system SHALL generate a bounded, versioned query plan from configured role preferences, curated role-family variants, and titles of this profile's verified submitted applications. Historical titles SHALL be retrieval terms only. A retrieved role SHALL pass the current profile, employer-location, fit, destination, and submission-policy gates before automatic application.

#### Scenario: Relevant title variant is not an exact preferred phrase
- **WHEN** an official ATS feed lists a suitable role whose spacing or occupation noun differs from the configured wording
- **THEN** the role reaches normalization and scoring; the adapter does not discard it merely because exact title tokens differ

#### Scenario: Historical title was rejected or simulated
- **WHEN** a prior opportunity with that title has no verified production submission receipt
- **THEN** it does not become a history-derived query term or automatic eligibility authority

#### Scenario: Bounded query plan preserves breadth
- **WHEN** a comprehensive campaign searches a lexical source
- **THEN** it runs at least one supported broad probe, rotates configured role families across completed cycles, and reports skipped terms, yield, and any source budget that prevents coverage of each family within three cycles

#### Scenario: A broad search term finds a role outside the applicant's geography
- **WHEN** the public board says worldwide but the current employer posting restricts hiring to another region
- **THEN** the role is held or excluded with the employer restriction as evidence and is not queued for automatic submission

#### Scenario: A browser source has a selected regional location
- **WHEN** a reviewed source listing URL opens with Europe, EMEA, or remote already selected
- **THEN** generic role search leaves that location control unchanged and preserves the posting's own location in candidate evidence

#### Scenario: A provider supports both continent and country search scopes
- **WHEN** the same lexical source has separate Europe and residence-country searches
- **THEN** bounded queries rotate those scopes with recorded provenance instead of combining them into a request that may favor one scope

#### Scenario: A relevant role scores below the deterministic semantic shortlist
- **WHEN** a close-fit role has unfamiliar title wording or skills expressed as synonyms and misses the preliminary top-20 score window
- **THEN** a bounded stratified review sample can examine it using role and verified applicant evidence, and any proposed eligibility change is reviewed without overriding hard exclusions

#### Scenario: Required skill is absent from an incomplete profile
- **WHEN** the listing names a required technology that is missing from the saved skill list, but the system has no verified evidence that the applicant lacks it
- **THEN** the role is held for fit review rather than reported as a known ineligibility, while automatic submission stays blocked until the fact is verified

#### Scenario: Specialist role overlaps incidental software skills
- **WHEN** a specialist engineering title or explicit must-have specialty is not supported by verified specialty evidence in the applicant profile, even though common software tools produce a high score
- **THEN** the role retains its score and remains in a bounded fit-review lane, while automatic application and final permit require a fresh fit review; a role with verified matching specialty evidence proceeds through the normal gates

### Requirement: Per-source accepted limits follow screening
The system SHALL seek up to ten distinct new actionable candidates per source after stable-ID deduplication, handled-role filtering, score/fit screening, and employer destination verification. Adapter raw-row or first-page slicing SHALL NOT masquerade as the accepted limit. Each provider SHALL stop at its documented request, page, time, and access-policy limits and report the stop reason.

#### Scenario: Early results are already handled
- **WHEN** the first page contains only previously handled roles and a suitable new role appears on a later page within budget
- **THEN** discovery continues to that page and may select the new role

#### Scenario: The source has no pagination and a large returned feed
- **WHEN** the response has more rows than the screening budget
- **THEN** the system screens the bounded response, records total observed and omitted rows, and marks coverage partial rather than exhausted

#### Scenario: Rate limit or challenge interrupts pagination
- **WHEN** the provider returns 403/429 or a bot challenge
- **THEN** discovery stops that source, applies a cooldown, preserves independent source work, and does not bypass the restriction

### Requirement: Historical official boards are bounded retrieval seeds
The system SHALL use a profile's recent verified official-role evidence or non-simulated employer submission receipts only to seed a bounded set of additional official ATS boards. It SHALL exclude another profile's history, rotate the eligible boards across completed source cycles, pace requests to the same ATS origin, and stop queued requests on 403/429. A board seed SHALL NOT prove that any current role is open or eligible; every fetched posting SHALL still pass the normal current-role checks.

#### Scenario: Recent receipt identifies a previously unconfigured board
- **WHEN** the receipt is genuine, profile-bound, recent, and its opportunity has a recognized official ATS role URL
- **THEN** that board may enter a capped retrieval cycle with receipt provenance, while every returned role is screened afresh

#### Scenario: Official board rejects more requests
- **WHEN** the first queued request to an ATS origin returns 403 or 429
- **THEN** later queued requests to that origin are not sent during the same scan and the source reports the restriction

### Requirement: Seen and pending roles are recoverable
The system SHALL distinguish an actual handled application from an observed listing and an unresolved employer destination. A pending listing SHALL be retried only within bounded freshness and backoff policy and SHALL not be permanently excluded solely because an opportunity record exists. Matching official ATS IDs, verified canonical employer application URLs, and verified receipt URLs SHALL prevent duplicate final applications. Company and title alone SHALL signal a possible duplicate, not suppress a separate opening; a weak-only match SHALL stay visible for identity review and SHALL NOT receive an automatic second final action while ambiguity remains.

#### Scenario: Destination was missing on the first scan
- **WHEN** a suitable aggregator listing has no verified employer application URL on one scan but obtains one on a later scan
- **THEN** it may transition from pending to ready after current employer role and geography checks without creating a duplicate application

#### Scenario: The role was already submitted
- **WHEN** a later board or direct link resolves to the same ATS role or receipt URL
- **THEN** it remains handled even if the source, URL tracking parameters, or title wording differs

#### Scenario: Same employer and title, separate official openings
- **WHEN** two listings share company and title but have different verified ATS role IDs
- **THEN** both remain visible and independently eligible for screening; the title match alone cannot mark either handled

#### Scenario: Matching title has unresolved employer identity
- **WHEN** an aggregator listing matches an earlier application by company and title but cannot establish whether its employer role ID differs
- **THEN** it remains visible as a possible duplicate and its automatic final action is held pending identity review

### Requirement: Source coverage is explicit
Each source scan SHALL report attempted query terms, pages visited, raw rows observed, adapter rejects, handled rows, scored rows, qualified rows, destination-pending rows, selected actionable rows, requests, elapsed time, and an explicit completion or partial stop reason. Unknown provider totals SHALL remain unknown.

#### Scenario: Fifty sources are configured but several time out or cool down
- **WHEN** a campaign summarizes coverage
- **THEN** it reports configured, attempted, exhaustive, partial, cooldown, manual, and blocked counts separately and never calls all fifty exhaustively searched
