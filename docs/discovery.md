# Discovery adapters

Discovery adapters normalize provider-specific listings into one opportunity model and fail independently, so one unavailable provider does not stop a scan.

The codebase includes adapter implementations for public feeds and configurable ATS boards. No adapter is enabled in the base defaults, and no employer board is preconfigured. An optional `config/discovery.example.json` enables four public feeds in simulation. `skills/job-application/references/public-sources.json` lists broad public browser sources and the seven server adapter types without applicant filters. Select employer boards and personal source priorities only in a private config file.

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

The installed skill's `references/sources.json` remains an empty private template. A fresh installation can use `references/public-sources.json` as a general starter. A deployment can maintain a private `sources.json` with its own browser sources, regions, screening rules, and priorities; the public starter never replaces that private copy.

Additional official ATS boards may be admitted from a profile's recent verified official role or real employer receipt. The owner may also put a reviewed official role URL in the private server configuration for that profile:

```json
{
  "discovery": {
    "sourceOptions": {
      "ashby": {
        "boards": [],
        "ownerCuratedBoards": [{
          "profileId": "PROFILE_ID",
          "officialRoleUrl": "https://jobs.ashbyhq.com/BOARD/ROLE_UUID/application",
          "company": "EMPLOYER",
          "reviewedAt": "2026-09-24T08:00:00Z"
        }],
        "disabledBoardKeys": ["ashby:BOARD_TO_ROLL_BACK"]
      }
    }
  }
}
```

This configuration is server owned and cannot be supplied by an agent's search request. The URL must identify one role on a recognized official Ashby, Greenhouse, or Lever host. Owner-curated reviews expire after seven days; other verified-role and receipt seeds expire after 30 days. Each profile gets at most five added boards per ATS source per completed search cycle. An added board receives at most two list requests in a rolling 24 hours, recorded in the durable audit log before fetch. Configured boards retain the ordinary source request budget. Every returned role still goes through current posting, geography, fit, destination, and handled-role checks. To roll back an added board immediately, set `enabled: false` on its curated seed or add its lowercase `source:board` key to `disabledBoardKeys`; remove the key after review. A 403 or 429 still triggers the existing six-hour board cooldown and stops queued requests to that origin for the scan.

The scan response includes `learnedBoardYield` with each added board's seed provenance, list requests, and count of distinct eligible, unhandled, verified-destination roles. Inspect this count and the actual roles in a read-only shadow before promoting a board. A board with zero eligible roles has zero measured application supply even if its feed returned many postings.

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
