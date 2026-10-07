# Two search agents and one application session

The owner works with one chat. That session controls the internal browser for navigation, filling, review and submission. It spawns exactly two search-only agents using the client collaboration tools. The server provides durable exclusive source leases; it never spawns agents or browsers. It uses the server as a passive system of record.

Owner links and reviewed jobs enter a durable FIFO queue. Adding a link does not start a browser. The session claims one current application; later messages append more links without disturbing it. After a verified receipt, the session closes its owned application tab and takes the next job.

For CAPTCHA, missing applicant information, uncovered commitments or required tool permission, the session saves its checkpoint, keeps the live form visible, asks the owner and waits. It does not process replacement applications. The two search agents can continue passive discovery and queueing during the hold. Only owner help or an explicit skip resolves the hold. Unknown final outcomes stay held without another Submit.

Routine complete-form review and submission are delegated to the session during an owner-requested application or search. The server records the real reviewer and exact preview fingerprint, checks changed applicant facts and submission capacity, and consumes one durable final attempt. It records completion only with employer success evidence. New legal commitments and tool-specific permissions remain separate owner decisions.

Use the installed skill's commands reference for queue operations. Configured sources, profile-bound authentication, facts, recruiter records and historical logs remain unchanged. Automatic campaigns, parallel application agents and server browser execution are retired from this workflow. The runtime selects chrome_session. The old worker and campaign execution code is removed. Historical records remain readable.
# Inactive applications

Submitted applications with a dated, non-simulated receipt automatically receive the separate tracking status `auto_closed` after more than 21 days without meaningful follow-up. The server checks on startup, every minute, and before application reads. A receipt acknowledgement does not reset the clock. Explicit review updates reset it; interviews, assessments, offers and required owner actions are protected. Unsubmitted or unverified attempts are excluded.

The submission state, receipt and employer evidence remain intact. A subsequently recorded meaningful reply reopens the application automatically, including delayed mail received before the automatic closure. Closure and reopening are audited per applicant. The dashboard defaults to open applications and retains closed entries in its Closed and All views. This maintenance never submits applications or sends messages.

# Source coordination

The main session supplies an ordered source plan from the private catalog and starts two named search slots. Atomic claims choose the highest-ranked available source. Heartbeats renew 20-minute leases; stale workers cannot enqueue after release, stop or expiry. Productive sources retain their assignment. Two focused poor pages allow rotation; blocked or completed passes also release their source. Europe/Sofia midnight reopens priority and clears daily cursors on the next operation, without clearing application history or duplicating still-live leases. The coordinator persists in SQLite runtime metadata within the existing state transaction; no destructive schema migration is needed.

Search enqueue reviews discovery with apply:false, then appends an opportunity through the passive queue with a final lease check in the queue transaction. It does not claim a form, consume submission capacity or create an attempt. The main chat owns every application and rechecks the official posting and complete live form.
