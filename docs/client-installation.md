# Client installation

Install the job-application skill in the owner's chat runtime. The chat uses the durable API and controls Chrome. No extra agent or messaging runtime is required.

For an existing Codex installation, back up and update `SKILL.md`, `agents/openai.yaml`, `scripts/jobctl.js`, `references/commands.md` and `references/efficient-batches.md` in place. Keep `.job-server-token`, `.job-server-url`, private sources, factual references, prior-answer helpers and writing preferences. Save owner-specific factual guidance in `references/applicant-facts.md`. Replace obsolete manager and per-form approval instructions with the current [workflow](agent-led-workflow.md).

Activate the client only after the matching Chrome-queue API is live. Run `health` and `queue` with its existing profile-bound credential. Do not create new agents, rotate credentials or overwrite private configuration as part of an instruction update.

For the account-vault update, install `scripts/account-file.js` and `references/accounts.md`, update `scripts/jobctl.js`, and add the account workflow/reference to the existing skill and commands. Preserve local cover-letter instructions, approved applicant facts, source settings and browser preferences. Check `account-status` on the current application without exposing its credentials before using the private handoff.
