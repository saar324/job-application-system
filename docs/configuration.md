# Configuration

`execution.workflow` is always `chrome_session`. The API stores the FIFO queue, facts and receipts. The owner chat uses Chrome. Legacy worker adapter, concurrency, auto-apply and final-approval switches are stripped when old private configuration is loaded.

Preserve `defaultMode`, `modes.full_time`, `modes.freelance`, score thresholds, daily caps, sources, discovery source options, source quotas and applicant preferences. The source catalog remains in the installed skill's private `references/sources.json`. No schedule is created.

`JOB_SERVER_PROFILES_FILE`, `JOB_SERVER_TOKENS_FILE` and `JOB_SERVER_DATABASE` identify private durable state. `JOB_SERVER_ALLOWED_DOCUMENT_ROOTS` allows the session to download its profile's current résumé. Read-only source API keys belong in the private environment. Never place secrets or applicant files in Git.

See [the workflow](agent-led-workflow.md), [discovery source options](discovery.md), and [deployment](deployment.md).
