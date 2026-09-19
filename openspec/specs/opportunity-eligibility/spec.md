# opportunity-eligibility Specification

## Purpose
Prevents automatic applications to roles that conflict with the active profile’s location, employment-type, or comparable compensation requirements.

## Requirements

### Requirement: Restricted remote locations are enforced
The scorer SHALL distinguish globally remote jobs from remote jobs restricted to named locations and SHALL exclude restricted jobs that do not match the profile’s allowed work locations.

#### Scenario: US-only remote role for a profile in another country
- **WHEN** a remote listing is restricted to the United States and the profile permits Canada
- **THEN** the opportunity is hard-excluded and cannot auto-apply

#### Scenario: Worldwide remote role
- **WHEN** a remote listing is worldwide and the profile accepts remote work
- **THEN** location does not hard-exclude the opportunity

### Requirement: Employment type is enforced when known
The scorer SHALL normalize common employment-type spellings and hard-exclude a known type outside the profile’s configured accepted types.

#### Scenario: Contract role in full-time search
- **WHEN** a profile accepts full-time and part-time employment but a listing is explicitly contract-only
- **THEN** the opportunity is hard-excluded

### Requirement: Comparable compensation minimum is enforced
The scorer SHALL normalize supported pay periods and prevent automatic application when a known maximum is below the profile minimum in the same currency.

#### Scenario: Monthly compensation below annual minimum
- **WHEN** a listing’s monthly maximum annualizes below the profile’s annual minimum in the same currency
- **THEN** the opportunity is hard-excluded

#### Scenario: Different known currency
- **WHEN** compensation is known but its currency differs from the profile minimum currency
- **THEN** the opportunity requires compensation confirmation rather than being treated as directly comparable

### Requirement: Eligibility evidence is retained
Every scored opportunity SHALL include explainable score details, hard-exclusion reasons, and policy conflict markers used to prevent automatic application.

#### Scenario: Agent reports a rejected match
- **WHEN** a listing is excluded by a hard preference
- **THEN** its scoring result identifies the exact location, employment-type, or compensation reason
