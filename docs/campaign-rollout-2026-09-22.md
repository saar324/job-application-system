# Timed campaign rollout and live acceptance check — 22 September 2026

## Production result

The timed campaign workflow is deployed to both production services from
`/opt/job-application-system-20260922-campaign-final`. Both services are active with zero restarts. The authenticated API,
MCP tools, and installed `jobctl` expose campaign start, list, status, and exact approval operations. The final local gate
passed **178 tests** plus syntax and repository-privacy checks; the campaign regressions also passed on the production host.

The workflow performs one structured scan, system-level handled-role filtering, deterministic suitability scoring,
employer-destination validation, sequential form preparation, one complete batch review, exact fingerprint approval,
sequential submission, verified receipts, reserve handling, and durable stage timing. Supported Arbeitnow and RemoteOK
listings resolve through fixed board redirect endpoints only after qualifying, avoiding an agent-driven listing-page search.
Handled ATS identities are checked again after that redirect so an aggregator URL cannot reintroduce an already submitted
role. Terminal campaign timings are frozen at the actual end time.

## Live acceptance evidence

Three fresh target-ten campaigns ran without final submission. The final run finished in **13.181 seconds**:

| Metric | Result |
| --- | ---: |
| Fresh source results | 236 |
| Already handled roles removed | 38 |
| Deterministically excluded | 234 |
| Remaining qualifying listings | 2 |
| Listings still missing a verified employer destination | 2 |
| Forms prepared | 0 |
| Submissions | 0 |

The redirect resolver found one additional employer form during the prior run, but its stable Ashby role ID matched a
verified submission from 14 September. The server rejected the duplicate; the post-resolution handled check now removes it
before campaign selection. Several additional official ATS boards were added to the private production catalog after a
current official-posting review. Their matching live roles were either already handled, absent from the current official
feed, or excluded by the saved quality rules.

The five-minute, ten-receipt acceptance target therefore remains unproven because this fresh cohort did not contain ten new
suitable roles. The system did not lower quality thresholds, fabricate destinations, reopen handled roles, or submit
anything to manufacture a throughput result. The live evidence establishes a 13.181-second scan-and-decision result for the
current catalog and a clean candidate-supply shortage, rather than an application-execution timing result.
