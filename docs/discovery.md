# Discovery adapters

Discovery adapters normalize provider-specific listings into one opportunity model and fail independently, so one unavailable provider does not stop a scan.

The codebase includes adapter implementations for public feeds and configurable ATS boards. No adapter is enabled in the repository defaults, and no employer board is preconfigured. Select source IDs and employer boards only in a private config file.

## Private configuration

Mode-level `sources` chooses enabled adapter IDs. ATS board selections live under `discovery.sourceOptions`:

```json
{
  "discovery": {
    "sourceOptions": {
      "ashby": { "boards": [{ "slug": "REPLACE_ME", "company": "REPLACE_ME" }] },
      "greenhouse": { "boards": [{ "token": "REPLACE_ME", "company": "REPLACE_ME" }] },
      "lever": { "sites": [{ "slug": "REPLACE_ME", "company": "REPLACE_ME" }] }
    }
  },
  "modes": {
    "full_time": { "sources": ["REPLACE_WITH_SOURCE_IDS"] }
  }
}
```

The installed skill's `references/sources.json` is intentionally empty. A deployment can maintain a private copy with its own browser sources, regions, screening rules, and priorities.

## Normalized records

Every adapter returns a provider ID, external ID, role title, company, listing URL, application URL, description, location, work type, and posting time when available. These stable fields support deduplication and attribution.

## Scoring

Scoring is explainable and uses applicant-owned configuration:

- skill overlap
- preferred-title overlap
- location eligibility
- recency
- compensation fit

Unknown compensation is never invented. Hard exclusions and thresholds come from the private profile and config.

## Adding an adapter

Create a module in `src/discovery/sources/` that exports an object with an `id` and async `search` function. Return normalized opportunities containing at least `title`, `company`, and `applyUrl`, register the adapter in `src/discovery/service.js`, and add isolated regression tests. Follow the provider's current terms and preserve source links.
