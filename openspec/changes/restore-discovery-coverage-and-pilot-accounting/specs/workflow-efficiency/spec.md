## ADDED Requirements

### Requirement: Pilot throughput counts only new verified receipts
The system SHALL report the total campaign wall time from candidate acquisition through the last verified employer receipt or campaign stop, with discovery, preparation, owner wait, browser execution, final action, and receipt-check stages. It SHALL separate raw findings, ready candidates, queued applications, attempts, holds, duplicate exclusions, uncertain outcomes, and new verified receipts. Campaign wall time per verified application SHALL divide total wall time by new verified receipts. Per-application latency SHALL run from that role's first observation to its verified receipt; median and p95 SHALL be calculated across receipt-bearing roles. Both measures SHALL be unavailable when receipts equal zero.

#### Scenario: Search returns no submitted applications
- **WHEN** a 50-source scan finds listings but produces zero new verified receipts
- **THEN** the report states that campaign time per verified application and per-role latency are unavailable and does not extrapolate a 100-application rate

#### Scenario: Ten jobs are found and seven receipts are verified
- **WHEN** three jobs fail, remain held, or have uncertain submission outcomes
- **THEN** the report identifies each outcome, computes campaign wall time per verified receipt using seven, computes latency statistics from those seven receipt-bearing roles, and does not call the run a ten-application completion

#### Scenario: The applicant supply runs out within bounded source limits
- **WHEN** fewer than ten suitable employer destinations are available and all source stop reasons are recorded
- **THEN** the report labels the pilot supply-limited and retains any pending destination or partial-source counts separately
