# Privacy history remediation — 2026-09-22

## Completed

The repository owner authorized the history replacement. A private mirror backup of the former refs and release metadata was saved outside the public repository before changing published refs. The old public branch and tags were replaced with a clean-root baseline; two releases pointing to the old commits were removed. PR #3 was closed and superseded by PR #4, which merged as `ba3a1e3`. The trusted private privacy check and the standard test check passed on the replacement PR, and the post-merge `main` check passed. Branch protection was restored with force pushes disabled. The only advertised GitHub head is `main`; there are no advertised tags or forks.

The trusted diagnostic reported matches in four current tracked paths and older author/blob history. The current examples and changelog links were revised, and the published branch was rebuilt from a clean baseline so the older matches are not reachable from `main`. The private denylist itself was never copied into repository files or public logs. Production still runs a pinned versioned release with its prior rollback copies; this repository rewrite did not deploy or modify production state.

## Remaining GitHub-hosted references

GitHub's read-only `refs/pull/1/head`, `refs/pull/2/head`, and `refs/pull/3/head` still point to old history. Old commit URLs or cached PR views may therefore remain accessible. GitHub documents that repository owners must [contact GitHub Support](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository#fully-removing-the-data-from-github) for eligible removal of affected pull-request refs and cached views. Support decides whether these findings meet its sensitivity criteria. Full historical removal cannot be claimed until Support completes that process. Do not republish the locally retained backup or merge a branch based on the old history.

The repository owner filed GitHub Support ticket **#4780911** on 2026-09-22,
requesting review of those three PR refs, the old root commit, and any cached
views. A later private gate caught author metadata in GitHub's PR #6 squash
commit. `main` was replaced with an identical-tree commit using the neutral
service identity, and force-push protection was restored. The ticket was
updated to include PR #6 and the superseded squash commit. It remains open;
GitHub-hosted old refs and cached views have not yet been removed or verified.

The replacement PR and current `main` are verified clean by the trusted gate. Local clones with the old refs need to fetch the new `main` and reset or rebase their work; merging the old branch history would reintroduce it.
