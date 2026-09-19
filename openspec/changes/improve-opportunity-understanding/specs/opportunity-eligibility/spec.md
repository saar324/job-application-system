## ADDED Requirements

### Requirement: Skill evidence is boundary-aware and contextual
The scorer SHALL match skills using canonical tokens, phrases, and explicit aliases, and SHALL NOT infer a short skill from an unrelated substring or from text that negates it as a requirement.

#### Scenario: AI and Go appear only inside unrelated words
- **WHEN** a description contains “Maintain Google email systems” and no separate AI or Go skill evidence
- **THEN** neither AI nor Go contributes to the opportunity's skill score

#### Scenario: Canonical alias is present
- **WHEN** a description requires “NodeJS” and the taxonomy maps it to `Node.js`
- **THEN** the canonical Node.js skill contributes with the original phrase retained as evidence

### Requirement: Hard gates dominate semantic ranking
The scorer SHALL evaluate deterministic hard eligibility constraints before semantic similarity, and embedding or model-derived signals SHALL NOT remove or weaken a hard exclusion.

#### Scenario: Semantically strong but location-ineligible role
- **WHEN** a role is highly similar to the profile but has a known incompatible location restriction
- **THEN** the role remains hard-excluded and cannot auto-apply

### Requirement: Unknown high-impact facts remain uncertain
The scorer SHALL distinguish absent evidence from negative evidence for location, work authorization, employment type, compensation, and other configured hard preferences.

#### Scenario: Work authorization is not stated
- **WHEN** neither structured nor textual evidence determines the role's authorization requirement
- **THEN** the scorer marks the fact unknown and follows the configured uncertainty policy instead of assuming eligibility

### Requirement: Score explanations are versioned and decomposable
Every scored opportunity SHALL record the scorer version, deterministic feature contributions, semantic contribution when used, hard-gate results, uncertainty markers, and bounded evidence sufficient to reproduce or audit the decision.

#### Scenario: Embedding similarity changes ranking order
- **WHEN** semantic similarity moves an eligible opportunity above another opportunity
- **THEN** the explanation reports the semantic contribution separately from exact skills and policy gates
