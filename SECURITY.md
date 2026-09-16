# Security

Keep vulnerability reports private. Do not open a public issue containing credentials, applicant data, application URLs, receipts, screenshots, resumes, or exploit details. Contact the repository owner through a private GitHub channel and include only the minimum reproducible information.

## Supported configuration

- Bind the API to loopback or a trusted private network.
- Keep authentication enabled outside local simulation.
- Use unique profile-bound bearer tokens and rotate exposed credentials.
- Run the browser worker as an isolated account or container.
- Allow only reviewed HTTPS application domains and narrow document roots.
- Keep applicant profiles, state, documents, vaults, and personalized skill references outside Git.

If a credential may have entered Git history, rotate it immediately and treat history cleanup as a separate incident-response step.
