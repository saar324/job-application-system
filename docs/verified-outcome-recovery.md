# Verified application outcome recovery

When a submission returns an error, the queue correctly holds the attempt for investigation.
Previously, a later authenticated employer status of **Not Submitted** could not release
that hold. Account storage was then blocked too, and an existing saved password had no
explicit update operation after an owner-completed reset.

This change adds two separate, audited operations:

- `queue-not-submitted` archives the exact failed attempt only after a fresh authenticated
  employer status, exact role URL, screenshot hash and observation time establish that
  the application was not submitted. It preserves history, retry limits and FIFO, and
  requires a new complete review before another final action.
- `account-update` replaces only an existing credential for the same applicant, official
  origin and username, after explicit owner authorization and a fresh verified login.
  A revision check prevents overwriting another update. Secrets stay encrypted and
  never enter application state or audit records.

Ordinary uncertain outcomes, missing confirmation mail, other requisitions, legacy holds,
old evidence and unverified resets remain blocked. These operations do not operate a
browser, reset an employer password or send an application.

Validation uses synthetic applicants and private temporary stores only. Regression tests
cover both persistence formats, wrong identities and roles, stale evidence, queue ordering,
new review requirements, encrypted updates, concurrent revision conflicts, authenticated
HTTP routes and private CLI transport. Syntax and repository privacy checks also pass.

Status: locally verified. Production and the installed client have not been changed.
The selected change requires explicit approval to install on the live server. After
installation, recheck the actual employer status and login, record fresh evidence, recover
the held attempt, update the saved credential and review the live application before Submit.
