## ADDED Requirements

### Requirement: Final machine review uses the live completed form
Before any automatic final action, the worker SHALL inspect all reachable form steps, compare observed values with the typed answer plan, verify required fields and supported optional fields, check upload identity and client-side persistence, and detect validation errors or newly revealed questions. It SHALL bind the result to a form fingerprint and destination.

#### Scenario: A field contains drafted prose
- **WHEN** a prose answer is evidence-grounded, passes the current policy, and every other final check succeeds
- **THEN** drafted prose alone does not force a new owner approval

#### Scenario: A value appears in the UI but was not persisted
- **WHEN** a contact field or radio choice displays a value but the application state or reopened control does not retain it
- **THEN** the worker does not submit and repairs or holds the form before another review

#### Scenario: A Next button appears beside Submit
- **WHEN** the page exposes navigation and final controls together
- **THEN** the worker distinguishes their semantics and performs no final action until the complete form is reviewed

#### Scenario: A required field appears after Next
- **WHEN** navigating to another step reveals a new required question
- **THEN** the worker re-inventories that step, obtains a supported answer or holds the application, and refreshes the final review

### Requirement: Browser path selection is evidence-based and reversible
The worker SHALL choose an origin-specific browser path only after comparing verified receipt rate, challenge rate, correctness, active duration, and resource use on comparable cases. A path SHALL back off on 403, 429, employer challenges, or spam blocks and SHALL NOT evade or solve human challenges.

#### Scenario: Headless execution is blocked but regular browser succeeds
- **WHEN** controlled evaluation shows materially better compliant success with a supported regular-browser path
- **THEN** that origin may use the regular-browser path behind a rollback flag while preserving final review and receipt checks

#### Scenario: The employer presents a CAPTCHA
- **WHEN** a final form presents a human challenge
- **THEN** the worker saves state, stops automation for that role, and exposes a human handoff; other independent roles may continue

### Requirement: Submission receipts require new employer evidence
The worker SHALL isolate the final action from prior fill/navigation actions and SHALL produce a receipt only from newly observed employer success evidence tied to the attempted application. A generic message or unrelated page change SHALL NOT count as success.

#### Scenario: A final click returns an ambiguous page
- **WHEN** the final action yields no definitive employer confirmation, success URL, or equivalent verifiable response
- **THEN** the application remains uncertain and fenced rather than becoming submitted or being clicked again
