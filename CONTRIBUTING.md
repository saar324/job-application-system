# Contributing

All changes to `main` must go through a pull request. Direct pushes, force pushes, and branch deletion are blocked. Use a short-lived branch or a fork and keep changes focused. The repository owner must review changes covered by `CODEOWNERS` before merge.

Before opening a pull request:

```bash
npm ci
npm run check
```

Add regression tests for state transitions, profile isolation, authorization, deduplication, confirmation policy, document boundaries, URL policy, or credential handling changes.

Never commit real profiles, resumes, tokens, application records, screenshots, employer selections, personalized writing guidance, or source preferences. Use `example.test`, placeholder identities, and fictional job data in tests and documentation. Run `npm run privacy:check` immediately before pushing. The same check runs in GitHub Actions and scans both the proposed tree and Git history.

Describe any migration or deployment impact in the pull request. Security-sensitive changes should preserve simulation defaults, explicit final approval, verified receipts, and profile-bound authorization.
