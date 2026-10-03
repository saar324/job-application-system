# Architecture

```text
Owner <-> one interactive session <-> Chrome <-> official job and employer forms
                    |
                 jobctl
                    |
             profile-bound API
                    |
        SQLite queue, facts, logs and receipts
```

The interactive session owns browsing, fit review, form filling, original prose and submission. The API is passive: it never starts application forms or advances the queue after an owner blocker. A job belongs to one chat session until completion or explicitly authorized session recovery.

Links and reviewed opportunities append in durable order. New messages can add links while a job is active or waiting. Atomic claims allow only one current application per applicant. Checkpoints preserve safe observed values and provenance. Browser tabs stay visible during owner help; state survives tab loss and chat changes.

Before Submit, the session saves the complete live preview and real reviewer provenance. The API checks required fields, applicable legal facts and consent, current applicant authority, daily capacity and a matching review fingerprint. It records one final attempt before the click. Retries require an explicit employer validation rejection and fresh review; unknown outcomes never authorize a replay.

An employer success receipt must match the recorded attempt, destination and observation time, with success text and a visual evidence hash. Only verified employer receipts count toward a request. Historical records, manual reconciliation, employer statuses and recruiter drafts remain separate evidence.

Authentication derives the applicant from the profile credential. Credentials, verification codes and cookies never enter queue previews or checkpoints. Source catalogs and applicant facts remain private. Existing source adapters, known-role filtering, source budgets, official destination verification and historical log inspection continue to work.

The default runtime exposes passive queue APIs. Automatic campaign mutation, server browser callbacks and batch approval execution are retired. Retired browser workers and campaign runners have been removed. Historical state remains readable.
