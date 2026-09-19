## ADDED Requirements

### Requirement: Network destinations are canonicalized before policy evaluation
The worker SHALL canonicalize host and address representations, including IPv4-mapped IPv6, and SHALL reject literal or resolved loopback, private, link-local, reserved, multicast, and otherwise non-global destinations.

#### Scenario: IPv4 private address encoded as IPv6
- **WHEN** a user-requested hostname or redirect resolves to `::ffff:192.168.1.10`
- **THEN** the worker classifies the canonical address as private and opens no connection

#### Scenario: Mixed public and private DNS answers
- **WHEN** an allowed hostname resolves to both a global address and a non-global address
- **THEN** the navigation is rejected rather than selecting the global answer opportunistically

### Requirement: Address validation is bound to outbound connections
The worker SHALL apply destination policy to initial navigation, redirects, popups, and subresources through a network path that connects only to the resolution that passed validation, and SHALL NOT rely on a stale cross-attempt DNS decision.

#### Scenario: DNS answer changes before connection
- **WHEN** a hostname first resolves publicly but the address available for the browser connection is private
- **THEN** the connection is blocked and the application returns a policy-denial outcome

#### Scenario: Allowed page loads a private subresource
- **WHEN** a public application page requests a loopback or private-network subresource
- **THEN** the subresource is blocked and the event is recorded without disclosing internal content

### Requirement: Policy failures are actionable and redacted
The worker SHALL return stable destination-policy reason codes sufficient for owner review while omitting credentials, request bodies, query secrets, and internal response content.

#### Scenario: Redirect is denied
- **WHEN** a navigation redirect violates host or address policy
- **THEN** the application enters manual review with the safe destination hostname and reason code but without sensitive URL parameters
