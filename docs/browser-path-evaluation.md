# Final browser path evaluation (controlled fixture)

The worker now waits for delayed form saves and reads every visible current-step value again before requesting a final
permit or using an exact approval. Local fixtures reproduce a LinkedIn field that clears after blur and a radio choice
that clears after a delayed change; both hold before Submit. Existing tests cover file name and size, conditional controls,
inline validation, challenge handoff, changed previews, and uncertain final actions. Added regressions cover Next beside
Submit, a newly revealed required field, access restrictions, a false success-shaped URL, and lost worker responses.
The 650 ms settle window adds about 65 seconds to 100 forms before any site-specific network wait. It is a provisional
correctness cost; a live cohort trace must show whether an event-based save acknowledgment can safely replace it.
After an automatic final decision, the worker compares the live form again immediately before committing the permit.
A server permit already consumed cannot be replaced by a new permit, even if the worker crashed before writing its
local `final_action_started` marker. Such a role stays on hold until the employer outcome is reconciled.
The worker checks each reachable step before moving forward and binds the accumulated answers to the final preview.
It cannot generically prove that an employer backend retained a field from an earlier hidden page without a supported
site-specific acknowledgment or reopening that page. A cohort pilot must audit that persistence before claiming the
multi-page path is fully verified.

`node scripts/compare-browser-paths.js` runs a **local data-URL fixture only**. Each path used the same five safe
fixture submissions with no applicant data, employer requests, CAPTCHA interaction, or real application action.

| Host and path | Fixture receipts | p50 | p95 |
| --- | ---: | ---: | ---: |
| macOS headless Chromium | 5/5 | 717 ms | 743 ms |
| macOS headed Chromium | 5/5 | 764 ms | 1,359 ms |
| macOS headed separate profile | 5/5 | 720 ms | 779 ms |
| staging host headless Chromium | 5/5 | 737 ms | 847 ms |
| staging host headed Chromium on Xvfb | 5/5 | 797 ms | 898 ms |
| staging host headed separate profile on Xvfb | 5/5 | 772 ms | 828 ms |

The fixture ran five repeats per path, so these are smoke-test timings, not statistically reliable ATS performance.
All modes used the same browser operations and zero model calls. The fixture has no challenge or spam classifier;
challenge rate, employer acceptance, and real token cost are unknown. Existing pilot records describe Ashby headless
rejections and success in regular Chrome, but we did not repeat an employer final action. The comparison therefore does
not justify switching Ashby to headed mode automatically.

The default remains headless. `WORKER_HEADED_ENABLED=true` plus comma-separated exact hostnames in
`WORKER_HEADED_ORIGINS` enables the staged headed Chromium path for those hosts only. It uses a fresh isolated context
per application and all existing form, policy, URL, and receipt gates. Clearing `WORKER_HEADED_ENABLED` rolls it back.
The container and systemd launch paths start Xvfb only when a headed path is requested and no display exists; startup
fails explicitly if Xvfb is unavailable. A systemd host needs the updated worker unit and split worker environment
before the flag can be enabled. Persistent browser
profiles were evaluated only on the fixture; they are not enabled in the worker because applicant session isolation
and employer acceptance have not been established.

Before enabling any origin in staging, compare a consented, small live cohort with equal job mix using verified
receipt rate, challenge/403/429/spam-block rate, active time, and resource use. A 403, 429, challenge, or spam response
stops that role for human review. The worker never solves or evades a challenge. A final click with no employer receipt
stays fenced until employer outcome is reconciled.
