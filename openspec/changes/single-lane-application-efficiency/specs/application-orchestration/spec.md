## ADDED Requirements

### Requirement: A single reusable application agent processes a batch sequentially
The coordinator SHALL assign only one active application to the reusable agent at a time. The agent SHALL checkpoint or finish it before receiving another application and SHALL use bounded, application-specific model packets so prior roles do not accumulate in prompts. The server SHALL remain the durable source of truth for blocked, approved, submitted, and uncertain states.

#### Scenario: A question blocks an application
- **WHEN** an application needs an owner answer
- **THEN** the agent records a resumable checkpoint, releases the lane, and may process the next application without starting a concurrent application agent

#### Scenario: The agent restarts
- **WHEN** the next session resumes a pending application
- **THEN** it loads only server-owned state, re-inspects the live form, and does not trust stale locator IDs or chat memory

#### Scenario: The owner approves a prepared batch
- **WHEN** one explicit approval names several application IDs and complete-preview fingerprints
- **THEN** only those exact previews become approved; later or changed forms require another review

#### Scenario: The owner now requires review for an older application
- **WHEN** an application created under automatic submission is explicitly retried after a pre-final failure and the current profile policy is `always`
- **THEN** the server requires a new exact final preview approval before submission

### Requirement: Efficiency is evaluated against quality
The system SHALL measure active and elapsed durations, model/tool use, field accuracy, challenges, manual reviews, and verified receipts per application. It SHALL not promote a faster path that increases unsupported claims, incorrect fills, duplicate submissions, or false submitted states.

#### Scenario: Older attempts have no worker timings or token usage
- **WHEN** the profile owner requests aggregate application metrics
- **THEN** the system reports sample counts separately from outcome counts and represents unavailable call/token values as unknown rather than zero

#### Scenario: A browser tool appears faster
- **WHEN** an alternative browser runtime is evaluated
- **THEN** it uses the same anonymized fixtures and reports timing, token use, correct fill rate, and receipt confidence before adoption

#### Scenario: The employer has removed a posting before the form opens
- **WHEN** the worker observes an explicit employer-hosted job-not-found page before any submission action
- **THEN** the server records a skipped, unavailable-posting attempt without an application receipt or owner submission confirmation

#### Scenario: The browser worker stops unexpectedly
- **WHEN** a worker attempt crashes before the final action marker is written
- **THEN** its durable attempt status identifies the pre-final phase so the owner can review a safe replay
- **WHEN** the marker has been written immediately before a final submission click
- **THEN** the worker fences any replay until the employer outcome is verified, even if no receipt was recorded

### Requirement: Missing public research is a bounded internal state
The server SHALL represent worker `needs_research` as durable `waiting_research`, without creating a human-answer confirmation. It SHALL requeue only after bounded official evidence is attached and SHALL stop automatic replay when the research budget is exhausted.

#### Scenario: A company motivation question lacks evidence
- **WHEN** the worker returns `needs_research` before final submission
- **THEN** the coordinator can fetch official context and requeue a fresh attempt, while the owner is not asked to supply a factual answer that the system can research
