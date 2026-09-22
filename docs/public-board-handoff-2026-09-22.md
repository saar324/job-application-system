# Public-board application handoff — 2026-09-22

## Finding and change

A production source query returned Himalayas `applicationLink` values that pointed to
Himalayas listing pages. The board's Apply action opened an account sign-up, and the
browser worker stopped on a human challenge before finding an employer form. The
source had incorrectly treated each listing URL as a ready application destination.

A later Jobicy pilot found the same failure: a qualifying listing was queued using
its Jobicy URL and the worker stopped at a board account prompt. Jobicy, Remote OK,
and Arbeitnow now use the same source-host guard. Their source descriptors expose
the employer-URL handoff, and board-hosted links are recorded as opportunities
without queuing application preparation. The Jobicy pilot also showed a listing
whose employer deadline had passed; the coordinator must verify posting status
at the employer destination before a real application.

After PR #6 passed both GitHub checks and merged, the API release was staged
and its 153 tests passed on the production host. A live bounded Jobicy query
returned 90 listings and one qualifying role. The qualifying board URL was
reported as `employer_application_url_required`; it queued no application.
The profile's application count stayed at 1,727. The API service was active
with zero restarts immediately after cutover; the worker code was unchanged.

The Himalayas adapter now marks board-hosted application links as needing employer
URL resolution. Discovery still scores and records the role, but it does not queue
automatic browser preparation for those links. The source descriptor and query
result tell the coordinator to verify the employer's application URL, retain the
Himalayas link for attribution, and use `direct` only after that verification.
External application links returned by the source remain eligible for preparation.

## Verification

- Regression test covers a board-hosted link and an external employer link in the
  same source response. The board link creates no application; the external link
  queues one.
- Local syntax, 137 tests, and the local repository privacy check passed.
- The staged release passed 137 tests on the production host. Its privacy check
  could not run there because deployment artifacts do not contain Git history.
- Production switched to the 2026-09-22 versioned release with the previous
  release and stopped-state database preserved for rollback. API and worker are
  active with zero restarts at the health check.
- A live bounded Himalayas query returned six qualifying board-hosted listings,
  each with `employer_application_url_required`. It created zero applications;
  the application count remained 1,722 before and after the query.
- A separate employer-form pilot using an indexed Ashby role reached an official
  `Job not found` page. The worker observed zero fields and stopped for review
  without submitting. Browser inspection confirmed the posting was unavailable;
  the test application was closed in the tracker. This did not exercise form fill.

The follow-up worker change recognizes this exact zero-field Ashby error page as
an unavailable posting. It marks the application skipped and records a typed
attempt outcome, with no final click or manual form-review confirmation.

## Measurement and stale-posting follow-up

The 2026-09-22 metrics release added an authenticated, profile-bound
`application-metrics` endpoint. It aggregates durable queue, execution,
owner-wait, and worker-stage times with sample counts, median, and p95. Missing
token and historic worker-timing data are reported as unavailable rather than
zero. Both server and worker run this release with zero restarts at the check;
the staged host and local repository each passed 143 tests. The prior release
and a stopped-state SQLite snapshot are retained for rollback.

A live retry of the known unavailable Ashby posting finished as `skipped`, with
`posting_unavailable` recorded on its attempt. It created no confirmation or
submission receipt. The measured queue time was 456 ms and worker active time
was about 1.98 seconds for this one blocked case. These are one-case observations,
not evidence of a general throughput improvement.

No real form was submitted in this check. A live form pilot still requires a
current, eligible employer destination and the owner's approval of the exact
completed preview. The later privacy cleanup and merged replacement PR are
recorded in [privacy history remediation](privacy-history-remediation.md).
