# Application efficiency upgrade: implementation guide

The [OpenSpec change](../openspec/changes/single-lane-application-efficiency/proposal.md) records the design and acceptance criteria. This guide records the audit, implemented contracts, and remaining rollout evidence. The current follow-ups are tracked together in [the backlog](backlog.md). No production throughput improvement has been measured yet.

## Implementation status, 2026-09-22

The service and worker now use a per-step native-control inventory and a versioned in-memory answer plan resolved before filling, deterministic mapping with context checks, scoped approved answers, conditional-field re-inventory, full live-value readback, multi-step signatures, complete approval text, and a full-content fingerprint. Visible iframe forms are handled; unsupported custom ARIA/contenteditable controls stop for human review. Final-action selection is scoped to the active form and favors Next over an unrelated Submit. Receipt evidence no longer treats old success text plus an unrelated body change as success. The optional adaptive fallback can prepare supported values but cannot click final Submit.

The worker can send only unresolved eligible prose to a configured `WORKER_DRAFT_ENDPOINT` as one JSON batch per step. Its request contains a bounded listing/company/applicant evidence packet and no credentials. New drafts are stored for fresh-context replay and require exact owner approval. A `needs_research` response becomes durable `waiting_research`; the same coordinating agent verifies an official public page and attaches its URL/excerpt through the API before the worker retries. This is an explicit agent research step, not an unrestricted server crawler. Drafting is disabled by default until a scoped endpoint is configured.

The API and MCP now expose enabled source descriptors and bounded, idempotent multi-query plans. Configured Greenhouse/Ashby board fetches are coalesced within a plan; Lever provider filters and documented Himalayas filters can be pushed to their APIs. Ashby unlisted roles are excluded from autonomous discovery. Greenhouse question-detail requests are opt-in; the browser form is authoritative. The API also supports atomic approval of an exact set of application IDs and preview fingerprints. Both repository and local installed skills use one sequential application agent. Worker attempt status and durable receipt reconciliation fence timed-out attempts before retry.

The 2026-09-22 live pilot exposed a public-board handoff error: Himalayas and Jobicy links can point to board listing pages whose Apply action requires an account. Remote OK and Arbeitnow can also return their own listing URLs. Such results remain searchable, but automatic browser preparation now waits for an employer application URL. The query result reports `applicationBlockedBySource: "employer_application_url_required"`; the coordinator verifies the employer destination before calling `direct`. A board sign-up or challenge is not an employer form. This is a source-host guard, not proof that every external URL is an eligible employer form; the coordinator still checks the destination and posting status.

Stage timings are recorded for discovery fetch/scan and worker load, fill, draft, transition, and receipt stages. The authenticated `application-metrics` endpoint summarizes durable attempt timings per profile with sample counts and p50/p95 values. It keeps unavailable model and coordinator token usage as `null`. Older attempts without worker timings remain missing samples; an owner-wait duration is measured only for resolved confirmations. The repository tests and local privacy check pass. The later history cleanup also passed the trusted GitHub privacy gate; see [privacy history remediation](privacy-history-remediation.md). Repository defaults remain simulation with no enabled discovery sources. The personal server was upgraded on 2026-09-21; see the [production rollout record](production-rollout-2026-09-21.md). Real-application reliability and the owner's eight-hour baseline still require an owner-approved pilot. The draft provider remains disabled, and production requires final approval for each application.

On 2026-09-22 the production API and worker were upgraded together to record these metrics and recognize an explicit unavailable employer posting. An authenticated bounded retry of a known stale Ashby posting ended `skipped`, with no receipt or confirmation. The attempt reported 456 ms queued and 1,977 ms of worker activity. This is one stale-posting case, not a successful live-form pilot. The older twelve durable attempts lack stage samples, so their aggregate cannot support a before/after throughput comparison. The private gate initially found current and historical matches. Those were cleared before replacement PR #4 merged; GitHub-hosted old PR refs still require separate Support review.

### Narrow synthetic benchmark, 2026-09-22

`node scripts/benchmark-forms.js --strict` runs 30 isolated Chromium form preparations using synthetic contact data: six alias/case variants across a single page, two pages, an optional question, an unknown required question, and a referral-email trap. Every run stops before final submission. The same script can load the pre-upgrade worker module from release `9ab8a5d`; each version passed all 30 expected outcomes in two sequential runs on this machine. Durations include fresh browser contexts but exclude browser launch and agent calls.

| Worker | Correct / 30 | Median active preparation | 95th percentile | Sum of 30 |
| --- | ---: | ---: | ---: | ---: |
| Release `9ab8a5d`, runs 1 and 2 | 30, 30 | 325, 325 ms | 1,154, 1,153 ms | 14,625, 14,647 ms |
| Upgraded worker, runs 1 and 2 | 30, 30 | 346, 349 ms | 409, 413 ms | 10,722, 10,776 ms |

The two-page cases explain much of the lower tail: the old worker waited after transitions. These 30 fixtures are intentionally narrow, and small timing differences can reflect machine noise. They do not cover real ATS layouts, network latency, model tokens, source yield, human waits, or completed receipts. Broader fixtures and a comparable owner-approved live cohort remain required before claiming the provisional 30% speed or 40% model-token goals.

One read-only live-form preparation on a current employer-hosted Ashby role used a synthetic applicant, forced final approval, and sent no application. The worker inventoried 13 controls in one step, returned two required missing answers, and stopped in `before_final_action` after 2,831 ms. This checks a real form's inventory and safe pause, not actual applicant fit, multi-step replay, submission, or receipt reliability.

A second synthetic dry run reached the third screen of a public custom four-page form. Its JavaScript required a 50-word essay but omitted the native `required` attribute. The first run stopped with a generic step error. The worker now detects a field's inline error after a blocked Continue, returns `missing_answer` for the exact essay field with the 50-word message, and stays before final action. The same live dry run reproduced the corrected result; no application was sent. The optional drafting endpoint is still disabled in production, so this question would require owner or coordinating-agent drafting and exact approval on a real application.

The same form's fourth screen exposed a second review bug: an unfilled file control was incorrectly compared to a nonexistent previous upload. The worker now checks file changes only for files it actually filled and treats visible inline upload errors as missing answers before final approval. With synthetic 55-word text and a synthetic PDF, the four-step run produced one complete preview with five filled and five unfilled controls, a preview fingerprint, and `before_final_action`; it never clicked Submit. This is real-site preparation evidence with synthetic data, not a verified employer submission.

The corrected worker and API run from the same `/opt/job-application-system-20260922-review` release. All 146 tests passed on the production host before cutover; both services were active with zero restarts immediately afterward. The previous versioned releases and systemd override layers remain available for rollback. The authenticated API still reports the historical attempts and the one stale-posting outcome.

The next owner-profile live pilot reached a Teamtailor page with two Apply controls, one disabled. The worker initially stopped on an ambiguous action. Filtering disabled controls let a synthetic staging run open the form safely. After that fix was deployed, the owner-profile retry lost its worker response when an HTTPS proxy tunnel emitted an unhandled `EPIPE`. The server recorded `submission_unverified` with no receipt. The application remains fenced; it must not be retried or marked submitted until employer-side outcome evidence is checked. A Gmail search for a related confirmation after the attempt found none, which is not proof of non-submission.

The proxy now handles close and error events on both sides of CONNECT tunnels and HTTP response streams. A regression reproduces the broken-socket event without crashing the proxy. All 148 tests passed locally and on the production host, and a proxy-backed synthetic Teamtailor run reached `before_final_action` without submission. The API and worker now run from `/opt/job-application-system-20260922-proxyfix`; both were active with zero restarts immediately after cutover. This verifies the crash fix on that path, while the owner-profile attempt remains unresolved.

The saved owner's full-time and freelance submission settings were also corrected to `always`; new applications now require an exact final preview approval. A safe explicit retry of an older automatic application now adopts the current `always` policy before requeueing. A further worker change durably writes `before_final_action` when an attempt begins and `final_action_started` immediately before a final click. After a crash, attempt-status can distinguish these phases and refuses to replay an application whose final action may have begun. The Equitable Earth attempt has no such marker because it ran before this change; its outcome still needs employer-side verification. The later replacement PR passed both checks and merged; see [privacy history remediation](privacy-history-remediation.md) for the remaining GitHub-hosted references.

### Draft endpoint contract

Set `WORKER_DRAFT_ENABLED=true`, `WORKER_DRAFT_ENDPOINT`, and optionally `WORKER_DRAFT_TOKEN` and `WORKER_DRAFT_TIMEOUT_MS` in the worker environment. The endpoint accepts `POST` JSON with `task`, `questions` (`fieldId`, `question`, `maxLength`), and `evidence` (`version`, `company`, `title`, `listing`, `listingUrl`, `research`, and `applicant` skills/public links). It returns `{"drafts":[{"fieldId":"motivation","text":"...","evidenceIds":["listing"]}]}`. An entry may instead set `insufficientEvidence: true`. Supported evidence IDs are `listing`, `applicant:skills`, and `research:0` through `research:3`. The worker validates IDs and length, then pauses for complete owner review of any new prose. The endpoint is optional; with no endpoint, unresolved prose becomes an ordinary owner question.

## Baseline audit before this implementation

| Area | Observed implementation | Likely cost or gap | Confidence |
| --- | --- | --- | --- |
| Form fill | `worker/automation.js` maps common aliases from profile data and fills live controls sequentially | Repeated per-control browser round trips; no separated inventory/plan/readback | High for mechanism, unknown for total time |
| Multi-step flow | Same file detects Next/Continue and loops up to 16 transitions | Fixed sleeps; final-submit pattern is checked before Next and is not scoped to the active form; unknown required field ends preparation before later pages | High |
| Final review | A cumulative preview of intended field summaries is fingerprinted | Field values are clipped to 240 characters and the approval presentation to 3,500 characters; repeated key/label pairs across steps overwrite earlier entries; earlier page values are not verified from live readback | High |
| Resume | `worker/execution.js` creates and closes a browser context for every attempt | A paused form cannot resume from the same page; it must be reconstructed safely in a fresh context | High |
| Worker contract | `src/adapters/webhook.js` handles submitted, needs-input, and needs-human outcomes with a 180-second request deadline | A research-only pause needs a new durable internal state and bounded replay; in-attempt drafting needs a smaller time budget | High |
| Crash recovery | `src/service.js` sets `submitting` before calling the worker and treats any interrupted attempt in that state as uncertain; the worker does not stop when the server's HTTP wait times out | A drafting or inventory crash can trigger manual submission review, while the original browser attempt may still finish after a lost response; retry needs attempt reconciliation | High |
| Pause checkpoint | Worker responses and adapter errors currently carry requirements but no structured progress checkpoint | A future resumable plan needs a versioned checkpoint propagated into server storage at each returned pause boundary | High |
| Receipt | Success detection accepts a new confirmation URL or success text when the page body changes | Generic pre-existing success words plus an unrelated DOM change can produce a false positive | Reproduced with a controlled page stub; site incidence unknown |
| Adaptive fallback | `worker/adaptive.js` asks a provider for one action after each broad observation | Many model round trips on unsupported forms; no role/company research packet | High when enabled; deployment use unknown |
| Discovery | `src/discovery/service.js` scans source IDs and a limit; ATS adapters fetch configured boards; Himalayas already issues several keyword searches | No agent-selectable source query contract; filter support differs across providers; Greenhouse detail questions are fetched before final shortlisting | High |
| Semantic enrichment | Top 20 non-excluded candidates can be enriched sequentially with an in-memory cache | Repeated model calls and profile embedding after restart | High when enabled; deployment use unknown |
| Orchestration | The installed skill asks for one new sub-agent per application, while the newer repository skill describes bounded recurring cycles | Operational versions differ; repeated startup/context cost has no measured share of the eight-hour report | High for mismatch, unknown for cost |

The newer repository defaults to simulation, no enabled sources, and one active execution chain per profile. The local installed CLI could not reach `127.0.0.1:4310` on 2026-09-21. Audit the actual deployed service and skill before changing operational behavior. The owner's eight-hour estimate for 100 applications is 4.8 minutes per application across discovery and preparation; it does not isolate a code bottleneck. The private source catalog records stronger historical submission yield from the configured ATS feeds than from many browser-only sources, so source work should begin with those feeds and one high-yield browser pilot.

The existing automation and adaptive tests passed 21/21 on 2026-09-21. Simple synthetic form attempts took roughly one to three seconds; a deliberately unconfirmed submission took about 11 seconds while waiting for evidence. These are test-fixture timings, not production measurements. The fixed 750 ms post-click wait can add up to about 12 seconds over the worker's maximum 16 transitions, so removing it alone is unlikely to explain an average of 288 seconds per application. Real page loads, repeated attempts, agent reasoning, and discovery remain unmeasured.

A controlled call to `waitForSubmissionEvidence` also returned success when a page already contained generic “Thank you” text and only a missing-email error was appended after the click. This proves the current predicate can mistake a validation change for a receipt; it does not establish that a real employer site has triggered it. The rollout plan treats receipt hardening as a correctness prerequisite.

## Original priority order

1. **Confirm the deployed path and measure it.** The installed skill and newer repository differ. Instrument a representative batch so time spent in search, form work, owner waits, and model calls is visible.
2. **Fix review and final-action correctness.** Deliver every field and full non-secret answer for approval, hash the complete observed form, scope Next/Submit to the active form, and require reliable new submission evidence. These are prerequisites for optimizing execution.
3. **Plan and verify form values in batches.** Inventory each current step, map common fields deterministically, fill, read back, and inspect validation errors. Resume by reconstructing the form in a fresh browser context.
4. **Use the model only for eligible open prose.** Batch questions per step with a compact evidence packet. Unknown applicant facts and attestations go to the owner. One agent remains active across the batch with bounded per-job prompts.
5. **Offer typed source queries.** Start with documented Lever and Himalayas filters and local filtering of configured Greenhouse/Ashby boards. Pilot browser search only where measured yield justifies its maintenance cost.
6. **Replace fixed waits and evaluate recipes/compact fallback.** These are worthwhile after traces show their share of active time. Keep recipe replay behind exact form fingerprints and policy review.

Same-profile concurrency from the earlier throughput proposal is deferred to respect the owner's one-agent-at-a-time preference. A faster browser runtime is also a hypothesis to test; the existing Playwright worker may already be the least expensive production path.

Reusable prior answers require more care than contact fields. The current flat `applicationAnswers` map does not encode jurisdiction or employer scope. The upgrade uses approved-answer records with provenance, scope, and review date, and treats unscoped legacy answers as needing review for sensitive questions such as work authorization. Existing employer exclusions and explicit human-authorship instructions remain gates before any model drafting.

## Design examples (not the current wire format)

The examples show structure, not real profile data. IDs are attempt-local except durable application/answer IDs.

```json
{
  "schemaVersion": 1,
  "applicationId": "application-id",
  "step": { "index": 2, "signature": "sha256:step-structure", "origin": "https://ats.example" },
  "fields": [
    {
      "id": "step2:email:1", "label": "Email address", "type": "email",
      "required": true, "constraints": { "maxLength": 254 },
      "decision": "deterministic", "valueKey": "contact.email",
      "source": { "kind": "profile", "key": "contact.email" },
      "validation": "ready"
    },
    {
      "id": "step2:motivation:1", "label": "Why this company?", "type": "textarea",
      "required": true, "decision": "draft", "validation": "needs_evidence"
    }
  ]
}
```

The implementation uses a versioned in-memory answer plan and a pause checkpoint, rather than the exact JSON field IDs shown above. The API stages a bounded evidence packet containing the listing, verified research excerpts, applicant skills, and public profile links. The worker sends eligible question IDs and constraints to a configured draft endpoint, which returns `{"drafts":[{"fieldId":"motivation","text":"...","evidenceIds":["listing"]}]}` or `insufficientEvidence`. It never supplies new applicant facts. A company question lacking evidence produces `needs_research`; the durable `waiting_research` state lets the coordinator attach an official excerpt and retry in a fresh context. A received typed pre-final error is safe to inspect. A lost response remains uncertain: the API checks the worker's attempt status and durable receipt and blocks a retry while the previous attempt is active. Evidence IDs alone cannot prove every natural-language claim, so all new prose needs exact owner review. The final preview carries **full observed live values** with credentials redacted, and its fingerprint covers all observed steps, role identity, form origin, and private secret/file fingerprints. The complete preview is returned through the private API; clients must display all of it before asking for approval.

Source discovery has two operations:

```json
{
  "describeSources": { "mode": "full_time" },
  "descriptorExample": {
    "source": "lever", "version": 1, "method": "official_feed",
    "filters": { "location": { "type": "string[]", "execution": "provider" }, "team": { "type": "string[]", "execution": "provider" }, "commitment": { "type": "string[]", "execution": "provider" } },
    "freeTextSearch": false, "maxResults": 100
  },
  "searchPlanExample": {
    "source": "lever", "mode": "full_time",
    "queries": [{ "filters": { "team": ["Engineering"] }, "limit": 50 }],
    "scanCycleId": "cycle-id", "idempotencyKey": "cycle-id:lever:engineering"
  }
}
```

The descriptor comes from the adapter's real capabilities, not a shared invented filter set. Server validation rejects unsupported filters and unconfigured boards before network access. It reports whether a filter is sent to the provider or applied locally. A bounded multi-query plan can share one board-wide fetch; a new scan cycle can refresh it. Lever category filters are case-sensitive, so the descriptor must provide exact observed or configured values. The result gives compact normalized roles, canonical IDs, listing URLs, timestamps, source version, and error diagnostics. Role eligibility is rechecked against the employer's current posting before preparing a form. Ashby's public feed includes `isListed`; autonomous discovery must exclude unlisted roles, while direct owner links remain reviewable.

## Benchmark protocol

Use at least 30 synthetic or anonymized fixtures: Greenhouse, Lever, Ashby, Workday/custom forms, one to four pages, conditional fields, file uploads, validation errors, account/OTP handoffs, and ambiguous success screens. Use synthetic profiles only. Screen alternative browser tools on a small common subset, then run viable finalists on the full set with the same machine, role packets, network constraints, approval simulation, and model/provider budget. Repeat enough to report p50 and p95, not one illustrative run. Synthetic receipts verify the parser; real site compatibility needs a separate owner-approved live pilot.

For each application, record stage durations, page count, control count, model calls/input/output tokens, browser/tool calls, unresolved owner questions, incorrect values, challenges, manual reviews, and verified receipt. Report active processing time for all started applications and separately for submitted, blocked, and failed outcomes; also report elapsed time including human waits, source yield per request and hour, and total model spend per successful outcome. A fixture with a fast but wrong answer fails. Record 429/challenge rates per source during any live discovery pilot and stop an adapter that triggers access restrictions.

Rollout gates: zero policy violations, zero false submitted states, zero duplicate final clicks, no increase in wrong-field fills or unsupported claims, and no drop in verified receipt rate. After a measured baseline, set comparable-cohort speed and token targets; provisional aims are at least 30% lower median active time and 40% fewer model input tokens among applications that use a model. A deterministic application with zero baseline model tokens cannot show a percentage token reduction. Record absolute counts as well as percentages.

## Browser and feed options

### Discovery source choices

| Source | Documented query path | Application caveat | First improvement |
| --- | --- | --- | --- |
| Greenhouse | Public board/job GET; job detail can return questions | Hosted form remains authoritative; application POST needs employer credentials | Cache one board fetch per scan cycle and request question details only for shortlisted roles |
| Lever | Public per-company postings with location, team, department, commitment, and level filters | No full-text search or custom-question list in the public feed; application POST needs employer key | Expose exact case-sensitive filter values and use the hosted form |
| Ashby | Public board-wide listing feed | `isListed: false` roles are direct-link only; feed does not replace the live form | Filter locally after one board fetch and exclude unlisted roles from autonomous discovery |
| Himalayas | Public search endpoint with keyword, country, company, seniority, employment type, timezone, sort, and page | Rate limits and required source attribution; application redirects to the employer | Let the agent select bounded query combinations and reuse results within one scan cycle |
| Browser-only boards | Site-specific visible search controls | Layout changes, access restrictions, and challenges require maintenance | Pilot one high-yield source after feed work is measured |

Documented public feeds usually remove more clicking than changing the browser library, but they do not remove provider rate limits or application-form verification. Keep the search plan's request budget and backoff per source.

| Option | Best role in this system | Evaluation note |
| --- | --- | --- |
| Existing Playwright library | Production worker and deterministic form execution | Already integrated with isolation, uploads, receipts, and policy; benchmark first. Playwright locators auto-wait and retry. |
| Playwright CLI | Agent development and compact fixture exploration | Official docs describe a token-efficient coding-agent interface; compare its output and overhead with direct library calls. |
| Playwright MCP | Accessibility-led exploration of unfamiliar forms | Rich snapshots help inspect controls but can add tool/context traffic. Keep out of the privileged production agent until policy wrappers are proven. |
| Codex Chrome/in-app browser | Owner-visible takeover and debugging | Good for human handoff; browser state alone is not the durable queue or receipt store. |
| Stagehand v3 | Optional adaptive extraction/action pilot | Supports local browsers and Playwright integration, but AI methods still call a model. Evaluate privacy settings, cache behavior, latency, and policy enforcement. |
| Browser Use | Optional independent adaptive pilot | General browser agent; evaluate on the same fixtures and preserve the server's answer, approval, and receipt boundaries. |
| Official ATS listing feeds | Primary structured discovery for configured employer boards | Greenhouse, Lever, and Ashby expose public listing interfaces; form submission access and custom-question coverage differ. |

Lever's documented Postings API supports per-site filters but no full-text search and does not expose custom application questions. Its application POST needs an employer API key, so this design uses the hosted application form. Greenhouse documents public Job Board GET methods, optional job questions, and an authenticated application POST. Ashby's lightweight feed returns board-wide postings, `isListed`, and hosted application links. Himalayas documents keyword, country, seniority, employment type, company, timezone, sort, and page filters plus rate limits and source attribution. These details should be rechecked when implementing each adapter.

## Source references checked 2026-09-21

- [Playwright locators and actionability](https://playwright.dev/docs/locators), [auto-waiting](https://playwright.dev/docs/actionability), [frames](https://playwright.dev/docs/api/class-framelocator), [CLI for coding agents](https://playwright.dev/docs/getting-started-cli), and [Playwright MCP](https://github.com/microsoft/playwright-mcp)
- [Lever Postings API](https://github.com/lever/postings-api)
- [Greenhouse Job Board API](https://docs.greenhouse.io/job-board.html)
- [Ashby public Job Postings API](https://developers.ashbyhq.com/docs/public-job-posting-api)
- [Himalayas Remote Jobs API](https://himalayas.app/api)
- [Stagehand v3 API and local browser options](https://github.com/browserbase/stagehand/blob/main/packages/docs/v3/references/stagehand.mdx)
- [Browser Use open-source project](https://github.com/browser-use/browser-use)
