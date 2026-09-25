# Design

`scan({reviewOnly:true})` uses existing source adapters, request budgets, and known-role indexes, then returns bounded raw candidates before numeric screening or employer destination requests. Browser sources use `filter({items})` for the same profile-bound duplicate check. Clear remote/on-site/hybrid, employment-type, and excluded-title preferences can filter candidates locally. Neither endpoint opens a form.

The agent reviews public job evidence against verified applicant facts and sends a `consider` verdict. `irrelevant` records a skipped opportunity key; `uncertain` records no application; `relevant` triggers one fresh official ATS fetch after any bounded board redirect. If title or company changes, the official listing returns for a new verdict. The accepted verdict is bound to a fingerprint of title, company, description, and apply URL. It bypasses the old numeric score and inferred skill gates while that fingerprint still matches. Simple explicit preferences, owner submission policy, final permit, and receipt requirements still apply.

The old campaign path remains readable and callable for in-flight work. The skill routes new batches to the agent-led path. Once ten new receipts are measured and audited, the legacy path can be retired in a separate migration.
