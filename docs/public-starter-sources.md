# Public starter sources

The repository includes a reusable source catalog at
`skills/job-application/references/public-sources.json` and an opt-in server
configuration at `config/discovery.example.json`. Both are independent of any
applicant. The base `config/default.json` still enables no sources.

The starter lists four public server feeds: Remote OK, Arbeitnow, Jobicy, and
Himalayas. It also names Ashby, Greenhouse, Lever, and Workable as supported
adapter types; they return no roles until an operator adds employer boards
privately. Workable roles are never applied to automatically.
The browser catalog has six broad sources: Jobgether, Remotive, We Work
Remotely, Working Nomads, Wellfound, and Y Combinator. It uses general listing
pages without occupation, country, compensation, or seniority filters.

To try discovery without live submissions:

```bash
cp config/discovery.example.json config/local.json
# Set JOB_SERVER_CONFIG=./config/local.json in your ignored .env file.
# Fill your ignored applicant profile, including search titles and location.
AUTH_DISABLED=true npm start
```

From another shell, run `node bin/jobctl.js sources` and a bounded scan. The
all-source campaign runner uses the public catalog when `--catalog` is omitted.
It derives browser search terms from the private profile; an explicit
`--query` is also possible. The sample config keeps the execution adapter in
simulation and automatic application disabled.

Keep applicant-specific source choices, ATS board IDs, role-listing paths,
region restrictions, screening rules, priorities, credentials, and writing
style in ignored or external private files. To use a private catalog, pass
`--catalog /private/path/sources.json` to the campaign runner. The skill's
`references/sources.json` remains an empty private template and is preserved
on skill refresh. Public source pages can change or restrict automation; the
browser runner keeps its request budget and stops on rate limits and challenges.
