## Purpose

Makes every application question and final submission decision actionable from the correct owner’s Telegram chat.

## ADDED Requirements

### Requirement: Confirmations expose channel-neutral presentations
The API SHALL attach a presentation containing readable context and bounded callback values to every pending application confirmation.

#### Scenario: Multiple-choice question
- **WHEN** a required form control has known options
- **THEN** the confirmation presents one button per option plus an “I’ll type an answer” button

#### Scenario: Free-text question
- **WHEN** a required question has no safe known options
- **THEN** the confirmation recommends the custom-answer path and prompts the owner to type a response

### Requirement: Recommendations never invent applicant facts
The system SHALL label a recommended option only when it follows stored profile evidence or a safe workflow action; otherwise it SHALL recommend that the owner provide an answer.

#### Scenario: Unknown eligibility answer
- **WHEN** the profile contains no evidence for a yes/no eligibility question
- **THEN** neither yes nor no is recommended and the custom-answer action is recommended

### Requirement: Button callbacks resolve only matching confirmations
The OpenClaw skill SHALL translate a callback containing a confirmation ID and option index into the corresponding profile-bound API action, and SHALL reject stale, foreign-profile, or out-of-range callbacks.

#### Scenario: Owner chooses an option
- **WHEN** the correct owner presses an option button on a pending confirmation
- **THEN** the selected value is stored as the answer and the application is queued again

#### Scenario: Owner chooses custom answer
- **WHEN** the owner presses “I’ll type an answer”
- **THEN** the confirmation stays pending while the bot asks for the typed response

### Requirement: Final approval includes the complete preview
The final Telegram approval prompt SHALL show the opportunity, destination, filled fields, unresolved fields, and redaction notices, with approve and decline buttons.

#### Scenario: Owner approves preview
- **WHEN** the owner presses Approve on the latest final preview
- **THEN** its fingerprint is persisted and only that application is queued for final submission
