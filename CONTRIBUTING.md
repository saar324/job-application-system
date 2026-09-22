# Contributing

All changes to `main` must go through a pull request. Direct pushes, force pushes, and branch deletion are blocked. Use a short-lived branch or a fork and keep changes focused. The repository owner must review changes covered by `CODEOWNERS` before merge.

Before opening a pull request:

```bash
npm ci
npm run check
```

Add regression tests for state transitions, profile isolation, authorization, deduplication, confirmation policy, document boundaries, URL policy, or credential handling changes.

Never commit real profiles, resumes, tokens, application records, screenshots, employer selections, personalized writing guidance, or source preferences. Shared profile templates must retain placeholder identity fields and empty skills, job titles, locations, services, application answers, source selections, and compensation preferences. Use `example.test`, placeholder identities, and fictional job data in tests and documentation.

Run `npm run privacy:check` immediately before pushing. GitHub also runs a trusted privacy gate against every proposed commit and its history using an encrypted deployment-specific denylist. Pull-request code is never executed with that private denylist available.

Configure Git with a GitHub-provided no-reply email before committing. The privacy gate rejects personal author emails as well as private values in file contents and history.

Describe any migration or deployment impact in the pull request. Security-sensitive changes should preserve simulation defaults, explicit final approval, verified receipts, and profile-bound authorization.
