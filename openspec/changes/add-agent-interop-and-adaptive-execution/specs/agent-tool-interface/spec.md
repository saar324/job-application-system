## Purpose

Exposes the durable job-application service to replaceable agent clients through typed, profile-isolated MCP tools without granting direct storage or browser access.

## ADDED Requirements

### Requirement: Tool authorization determines profile identity
The MCP server SHALL derive the active profile exclusively from authenticated credentials before dispatch and SHALL NOT accept a client-supplied profile identifier as authority.

#### Scenario: Client requests another profile's data
- **WHEN** a credential bound to profile A supplies profile B's identifier or resource ID
- **THEN** the MCP server returns a safe authorization or not-found result without disclosing whether profile B's resource exists

### Requirement: Tools reuse the application service contract
MCP tools SHALL invoke the same validated service operations and state-machine rules as HTTP and CLI clients and SHALL NOT read or mutate persistence directly.

#### Scenario: MCP requests a direct application
- **WHEN** an authenticated client invokes `request_application` with a valid public URL
- **THEN** the normal readiness, deduplication, eligibility, capacity, approval, and audit rules apply

### Requirement: Mutating tools are idempotent and asynchronous
Every mutating MCP tool SHALL require or derive a stable idempotency key, persist the durable result before returning, and SHALL NOT hold the protocol request open for browser completion.

#### Scenario: Client retries after disconnect
- **WHEN** the same authenticated mutation and idempotency key are delivered again
- **THEN** the tool returns the existing durable resource and does not repeat admission or confirmation resolution

### Requirement: Tool schemas and outputs are bounded
Tools SHALL validate versioned inputs, paginate collection results, cap returned text and evidence, and return stable typed errors without credentials, tokens, document contents, or unrestricted page data.

#### Scenario: Client requests an unbounded application history
- **WHEN** a list request omits a limit or asks for more than the configured maximum
- **THEN** the server applies the maximum page size and returns a continuation cursor when more results exist

### Requirement: Confirmation tools preserve owner intent
Confirmation resolution SHALL accept only actions valid for the authenticated profile and current confirmation state and SHALL never infer an answer or approval from conversational text alone.

#### Scenario: Stale confirmation is resolved
- **WHEN** a client attempts to approve a superseded or already resolved confirmation
- **THEN** the tool returns a typed stale-state error and does not queue submission
