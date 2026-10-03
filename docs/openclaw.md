# Client installation

The job-application skill is a replaceable client of the durable API. The same one-session Chrome workflow applies in Codex and other chat runtimes. No application manager or spawned agents are needed.

The optional `scripts/bootstrap-openclaw.js` installs the skill and provisions one profile-bound client credential. Its explicit installation command preserves private sources and writing style. It does not run a campaign or operate an employer form.

For an existing Codex installation, update instructions and `scripts/jobctl.js` in place. Preserve `.job-server-token`, `.job-server-url`, private source configuration and writing style. See [the workflow](agent-led-workflow.md).
