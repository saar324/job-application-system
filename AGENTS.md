# Repository guidance

This service is the durable system of record for multiple applicants. Keep chat runtimes (OpenClaw, Codex, Claude) as replaceable clients.

- Preserve profile isolation: derive `profileId` from authenticated credentials, never request content.
- Never mark an application submitted without a verifiable production-adapter receipt.
- Never invent applicant facts or silently accept legal attestations.
- Keep `full_time` and `freelance` as configuration modes; `full_time` remains the default.
- Add provider-specific scraping or browser behavior behind adapters.
- Add a regression test for every state-machine, deduplication, authorization, or confirmation-policy change.
- Do not commit resumes, cookies, tokens, local profile files, or application state.
