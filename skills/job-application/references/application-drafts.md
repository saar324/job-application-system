# One packet per application

Search workers prepare suggestions, not live employer drafts. Each new discovered job is enqueued atomically with one JSON packet. The queue entry retains an unreviewed revision, source worker, timestamp and server fingerprints for applicant facts and the posting. Workers can backfill older pending jobs through exclusive preparation leases during a refill cycle. They cannot change a claimed form or another applicant.

## Worker preparation

Read `draft-context` once and keep its `profileFingerprint` with the verified facts. Research the full official role and relevant company evidence. Read public application questions when available. Never insert personal data, open accounts, solve CAPTCHA, upload or submit. A gated or unavailable form is `not_accessible`, with `complete:false`. Do not invent exact questions or options. Generic contact and resume suggestions can use `required:null` and notes stating that the form is not inspected. Explicitly flag uncovered facts, work rights, commitments, unavailable questions and writing restrictions. Do not ask the owner.

Use current owner corrections and writing preferences. Include a tailored cover letter or motivation draft when the posting and public application instructions allow it. If the employer prohibits assisted writing, leave prose empty and record the issue. `not_checked` also requires empty prose. A guessed framework, location, qualification or legal answer stays null. Saved factual suggestions require provenance. Jurisdiction, contract type and consent scope remain part of main-session verification. Drafts never update the profile.

Example packet structure:

```json
{
  "schemaVersion": 1,
  "officialPostingUrl": "https://employer.example/jobs/engineer",
  "formObservation": {
    "url": "https://employer.example/jobs/engineer",
    "observedAt": "2026-10-07T12:00:00Z",
    "complete": false,
    "access": "not_inspected"
  },
  "fields": [
    {
      "key": "first_name",
      "question": "First Name",
      "kind": "text",
      "required": null,
      "value": "Example",
      "status": "draft",
      "evidence": [{"kind":"profile_fact","reference":"Current verified contact.firstName"}],
      "notes": "Generic suggestion. Verify the actual label and requiredness."
    }
  ],
  "coverLetter": {"text":"","aiPolicy":"not_checked","evidence":[]},
  "missingInformation": [{"question":"Application questions","reason":"Public form not inspected"}],
  "research": [{"url":"https://employer.example/jobs/engineer","fact":"Reviewed production software responsibility"}],
  "notes": "Tentative preparation only."
}
```

Field kinds: `text`, `textarea`, `select`, `radio`, `checkbox`, `file`. Status: `draft`, `missing`, `needs_review`, `not_applicable`. Missing values are null. Use the exact question and actual options when observed. Evidence kinds: `profile_fact`, `owner_fact`, `resume`, `job_posting`, `derived`. Add `profileAnswerKey` when an exact saved alias supports the suggestion. Keep application-specific prose, not canned reused answers. Store no credentials, codes, private auth URLs or operational claims such as uploaded, approved or submitted.

## Main session: correct before insertion

1. Recover the current form and any existing final attempt first. Claim the next FIFO item only when the previous outcome is resolved. Load `queue-draft ID` to a private JSON file once. It includes the packet, revision, current facts and fingerprints. Do not print the entire profile or packet in chat.
2. Inspect the actual full live form. Compare questions, field types, options, location selections, writing rules and requiredness. Check the current facts in the response and prior-answer retrieval before treating worker unknowns as genuinely missing. Resolve known items and rewrite weak prose in the packet before any insertion. Ask only for a genuinely missing current fact or uncovered commitment. A stale draft is a suggestion to recheck, not ready input.
3. Save `queue-draft-review ID` with `{sessionId,revision,fingerprint,packet}` from the load response and the corrected packet. Update its form observation to the actual public live form and current time. Set `complete:true` only after reading every field. Check the returned `feedback.events`. If the automatic cause is incomplete or says `needs_investigation`, inspect the original packet, current facts and actual form. Add `feedback:[{key,cause}]` to the review to record a verified cause. Read [draft-feedback.md](draft-feedback.md) for the enum, grounding and recurrence checks. The server fences main-session ownership, revisions and changed facts. `readyToFill` requires a current complete observation, no missing information and no unresolved required values. This remains draft review, not legal approval or final submission authority.
4. Keep the original load response in memory. After the correction is accepted, set its `correctedPacket` to the exact submitted corrected packet and `readyToFill` to the server response. This avoids fetching the packet again. Reload only if facts, the posting or the revision changed. Build a private JSON object `{draft:ACCEPTED_CORRECTED_RESPONSE,live:{url,observedAt,fields:[...]}}`. Each live field has `key`, `question`, `kind`, `required`, and its observed `locator:{by,value,role?,exact?}`. Locator modes are `role`, `label`, `placeholder`, `selector`. Only role locators for actual inputs are accepted. Include actual option labels, `nativeSelect:true` for native selects, and `optionValue` for the specific radio target. An official cross-origin form needs `destinationVerified:true` based on its actual Apply link.
5. Run `node BASE_DIR/scripts/draft-fill-plan.js PRIVATE_JSON_FILE` and save its JSON output privately. It returns one batch of fields, upload suggestions and unresolved mappings. It cannot operate the browser or authorize Submit. Correct required mismatches before filling. Load that plan in the existing CUA session and perform deterministic matching input actions in one call. Use actual observed locators, not generated JavaScript or selectors from worker prose. Custom selects require their normal select-and-observe flow. Upload the verified current CV and reviewed letter through actual file controls.
6. Inspect the resulting live values, selected options, uploaded filenames and exact motivation text. Fix any insertion error and verify again. Archive the actual letter through the existing cover letter workflow. Finish with the existing exact `queue-review`, final-attempt and receipt workflow. Leave CAPTCHA until all preparation is complete, then hand off CAPTCHA and Submit to the owner.

If no packet exists, prepare this current application normally. Do not delay the owner for a worker or clear a form hold to obtain a draft. Existing pending jobs can be prepared during the next refill. New owner links remain accepted even above 30; the high watermark stops autonomous discovery, not explicit owner additions. Counts are waiting jobs, never sent applications. No background browser, overnight daemon or new schedule is installed.
