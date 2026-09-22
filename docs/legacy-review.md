# Review of `openclaw-skill-job-hunter`

The old project is a strong discovery prototype. Its reusable parts are the platform-adapter boundary, normalized listing model, URL/platform deduplication, evidence-based scoring, salary samples, lifecycle tracking, follow-up scheduling, structured JSON output, and optional Notion reporting.

## Keep and port

- API/RSS sources such as RemoteOK and We Work Remotely, especially for full-time remote work
- independent failure handling per source
- composite dedup keys and lifecycle progression
- explainable scoring dimensions rather than one opaque model score
- market statistics and optional Notion projection
- follow-up suppression as soon as an employer replies

## Replace in the new system

- The single global `USER.md` profile becomes server-owned, profile-scoped facts and documents.
- `scout` / `advisor` / `agent` is split from work type. `full_time` / `freelance` controls search and scoring, while `autoApply` controls execution.
- “Applied” is recorded only after a production adapter returns evidence. A draft or browser attempt is not a submission.
- Browser credentials move out of the OpenClaw skill into isolated worker profiles.
- Confirmation becomes a durable inbox item, so a reply from OpenClaw, Codex, or Claude can safely resume the same application.

The existing Python scrapers can initially run as discovery workers that POST normalized opportunities to this server. They should be ported incrementally rather than copied wholesale into the API process.
