# Privacy gate remediation plan

## Current state (2026-09-22)

PR #3's standard check passes. The trusted private privacy workflow fails on four current tracked paths (`CHANGELOG.md`, `test/discovery.test.js`, `test/efficiency-upgrade.test.js`, and `test/fixtures/ranking-evaluation.json`), eleven older author records, and blobs in those four paths plus two removed source files. The private denylist is supplied by a GitHub Actions secret and is unavailable in the local checkout. The local public-rule scanner passes, which does not supersede the trusted private result.

The trusted scanner checks every blob and author reachable from `HEAD`. Editing the current files alone cannot clear historical matches. Disabling the private workflow or changing it to ignore history would hide the finding rather than remediate it. No merge should bypass the failing check.

## Proposed migration, requiring repository-owner approval

1. Export protected branch names, tags, release commit IDs, open PRs, and deployment refs. Make an immutable backup of all Git refs in a private location. Record who needs to update clones and integrations. Rotate any credential if the private reviewer identifies credential exposure; a history rewrite is not credential rotation.
2. In a disposable mirror clone, replace the private matches in current files with neutral examples and rewrite historical blobs and author identities using an owner-approved mapping. Preserve source behavior and test coverage. Do not copy the private denylist or real applicant data into the repository.
3. Run syntax, browser/unit, strict OpenSpec, and the public privacy scanner on the rewritten clone. Run the trusted private scanner against the candidate history in a controlled workflow with access to the existing secret. Iterate on specific failures without publishing private match values in logs.
4. Present the exact old-to-new ref map, changed file summary, passing checks, and clone-update instructions to the owner. Only then force-update protected refs with a short maintenance window, preserving the backup. Recreate or retarget the PR, tags, and release references as needed, then rerun CI against the published refs.
5. Verify production still runs its pinned release, update the deployment source ref to the sanitized commit, and retain the prior executable release for rollback. Existing commit URLs and signatures cannot be preserved after rewriting those commits; collaborators must fetch the new history rather than merge old branches back.

## Decision needed

The branch-history replacement is an irreversible change for shared Git users and public links. The owner must authorize the specific ref migration after reviewing the prepared mapping and private scanner result. Until then, keep PR #3 unmerged and the deployed versioned release available for rollback.
