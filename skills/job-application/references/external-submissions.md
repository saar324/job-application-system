# Owner LinkedIn submission logging

The owner confirms that pasted application details without links come from LinkedIn. Record explicit “Application status / Application submitted” evidence on the server immediately. Missing URLs do not delay logging. Never convert “Clicked apply”, a review page, “Resume uploaded” or an Easy Apply listing into a submitted application.

Call `jobctl record-external-submission` with JSON on stdin:

```json
{
  "recordKey": "chat-id/stable-confirmation-id",
  "company": "Example",
  "title": "Software Engineer",
  "mode": "full_time",
  "jobUrl": null,
  "submissionDate": "2026-10-06",
  "observedAt": "2026-10-06T12:00:00Z",
  "evidence": {
    "source": "owner_provided_linkedin",
    "successText": "Application status\nApplication submitted\nnow",
    "reference": "Owner pasted confirmation in this chat",
    "sha256": "SHA256_OF_ACTUAL_SOURCE_TEXT"
  },
  "historicalAnswers": [{"question": "Experience years", "answer": "3"}]
}
```

Use the actual source hash, observation time and Sofia submission date. Resolve “now” to the message date, not a later import date. If the send date is missing or uncertain, ask for the date while preserving the evidence; do not invent it. Date-only evidence remains date-only, not a precise send timestamp. Use `freelance` for contract applications. Include the actual job link when available; never invent an employer destination.

Choose a stable recordKey from the chat and source attachment/message identity. Repeating the same record is idempotent. A changed recordKey payload returns a conflict and must be investigated. The exception is adding a previously missing jobUrl to the same record, with all original evidence, answers and submission date unchanged. This resolves identity and merges an existing exact-role receipt without counting twice. Exact job URL identities merge with existing history without moving its original receipt date. Same-company/same-title records without links are saved for identity checking and do not add another counted send; report `identityMatchPending` honestly. A similar title from another company does not establish that Jobgether's unnamed partner is that company.

Store submitted answers only under `historicalAnswers`. They are explicitly non-reusable and never update profile/config. In particular, owner-marked uncertain dates, experience durations or work rights must not become new reusable facts. Do not include credentials, authentication links, codes or tokens. Missing cover-letter text does not prove a letter was attached.

The result distinguishes owner-reported sends from browser-verified employer receipts. No agent final action is created. This logging is allowed during an owner-held queue and does not resume it. Optionally save an archive after the server succeeds. The dashboard collector refreshes once per minute. Verify the visible dashboard when reporting a repaired count, and do not promise that a local-file-only record is counted.
