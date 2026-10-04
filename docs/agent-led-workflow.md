# Single-session Chrome workflow

The owner works with one chat. That session controls Chrome for discovery, navigation, filling, review and submission. It uses the server as a passive system of record.

Owner links and reviewed jobs enter a durable FIFO queue. Adding a link does not start a browser. The session claims one current application; later messages append more links without disturbing it. After a verified receipt, the session closes its owned application tab and takes the next job.

For CAPTCHA, missing applicant information, uncovered commitments or required tool permission, the session saves its checkpoint, keeps the live form visible, asks the owner and waits. It does not continue discovery or process replacements. Only owner help or an explicit skip resolves the hold. Unknown final outcomes stay held without another Submit.

Routine complete-form review and submission are delegated to the session during an owner-requested application or search. The server records the real reviewer and exact preview fingerprint, checks changed applicant facts and submission capacity, and consumes one durable final attempt. It records completion only with employer success evidence. New legal commitments and tool-specific permissions remain separate owner decisions.

Use the installed skill's commands reference for queue operations. Configured sources, profile-bound authentication, facts, recruiter records and historical logs remain unchanged. Automatic campaigns, parallel application agents and server browser execution are retired from this workflow. The runtime selects chrome_session. The old worker and campaign execution code is removed. Historical records remain readable.
# Inactive applications

Submitted applications with a dated, non-simulated receipt automatically receive the separate tracking status `auto_closed` after more than 21 days without meaningful follow-up. The server checks on startup, every minute, and before application reads. A receipt acknowledgement does not reset the clock. Explicit review updates reset it; interviews, assessments, offers and required owner actions are protected. Unsubmitted or unverified attempts are excluded.

The submission state, receipt and employer evidence remain intact. A subsequently recorded meaningful reply reopens the application automatically, including delayed mail received before the automatic closure. Closure and reopening are audited per applicant. The dashboard defaults to open applications and retains closed entries in its Closed and All views. This maintenance never submits applications or sends messages.
