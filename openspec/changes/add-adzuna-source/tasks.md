## 1. Shared keyed-source foundation (skip any item already delivered by a sibling source change)

- [x] 1.1 Add `src/discovery/source-credentials.js` with an environment-name map, `sourceCredentials(sourceId, env)` and `redactSecrets(text, credentials)`
- [x] 1.2 Add `src/discovery/source-quota.js`: a durable per-source, per-window request ledger with atomic `reserve()`, persisted through the existing store
- [x] 1.3 Pass `credentials` into `source.search()` from `DiscoveryService.scan`, and redact every recorded source error
- [x] 1.4 Return `source_not_configured` for keyed sources with no credentials, without calling `fetchImpl`

## 2. Adzuna adapter

- [x] 2.1 Create `src/discovery/sources/adzuna.js` with URL building, per-country fan-out, `results_per_page ≤ 50` and profile-derived `what` terms
- [x] 2.2 Normalize results: `{country}:{id}` external ID, snippet uncertainty, `compensationEstimate` for predicted salary, contract fields, and pending destination
- [x] 2.3 Register `adzuna` in `SOURCES` and add its provider filter descriptor and `applicationFlow` to `describeSources`
- [x] 2.4 Validate `sourceOptions.adzuna.countries` against the supported list, and quota overrides as never above the provider defaults, in `src/config.js`

## 3. Tests

- [x] 3.1 Add fixture-based normalization tests (fictional data, `example.test` domains)
- [x] 3.2 Test that missing credentials produce `source_not_configured` and no fetch
- [x] 3.3 Test that the key and ID never appear in scan output, errors or audit when the provider fails
- [x] 3.4 Test quota exhaustion and persistence across a simulated restart; test that a 429 triggers the cooldown
- [x] 3.5 Test that a predicted salary does not trigger the compensation gate, and that a pending destination blocks application creation
- [x] 3.6 Test that an unconfigured country or unlisted filter is rejected

## 4. Docs and config

- [x] 4.1 Add commented `ADZUNA_APP_ID=` / `ADZUNA_APP_KEY=` placeholders to `.env.example`
- [x] 4.2 Document signup, quota, the `sourceOptions.adzuna` shape and attribution rules in `docs/discovery.md` and `docs/deployment.md`
- [x] 4.3 Run `npm run check`, including `privacy:check`
