# Repository guidance

This service is the durable system of record for multiple applicants. Keep chat runtimes (OpenClaw, Codex, Claude) as replaceable clients.

The repository owner authorized autonomous admin rebase merges and production releases for this system on 2026-10-04, including future releases. After review, required code and privacy checks, and staging verification pass, complete release without another routine permission question. If independent GitHub approval is the only remaining merge gate, use an admin merge. Keep branch protection configured. Never bypass a failed test or privacy check. Preserve private configuration and history, keep rollback available, and verify production behavior and the installed client after release. This authorization does not extend to other systems or unrelated destructive actions.

- Preserve profile isolation: derive `profileId` from authenticated credentials, never request content.
- Never mark an application submitted without a verified employer success evidence for the exact recorded Chrome attempt.
- Never invent applicant facts or silently accept legal attestations.
- Keep `full_time` and `freelance` as configuration modes; `full_time` remains the default.
- Keep discovery sources read-only. Only the owner chat operates Chrome. Never add background application workers.
- Add a regression test for every state-machine, deduplication, authorization, or confirmation-policy change.
- Do not commit resumes, cookies, tokens, local profile files, or application state.
- Use a GitHub no-reply or example author identity for commits. Rebase-merge reviewed commits to preserve their authors; a squash merge can replace the author with the merger's account. Verify the private privacy gate on `main` after merging.
