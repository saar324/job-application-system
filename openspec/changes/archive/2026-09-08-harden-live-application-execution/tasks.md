## 1. Secure Document Boundary

- [x] 1.1 Add API-side document validation and staging with containment, file type, size, and extension checks; verify traversal, symlink, invalid-file, and valid-file unit tests pass
- [x] 1.2 Add worker-side staged-document validation and fixed document-role handling; verify forged and out-of-root paths are rejected by unit tests

## 2. Durable Application Orchestration

- [x] 2.1 Make opportunity deduplication and application admission atomic inside the JSON store mutation lock; verify concurrent request tests create at most one record and respect caps
- [x] 2.2 Add the persistent queued runner, atomic claims, startup recovery, and test idle hook; verify queued work resumes and uncertain submitting work moves to manual review without resubmission
- [x] 2.3 Return accepted applications immediately and make client timeouts compatible with background execution; verify service and discovery tests observe queued then terminal state
- [x] 2.4 Add worker receipt idempotency and in-flight request serialization; verify identical retries reuse a receipt and changed payloads are rejected

## 3. Eligibility Enforcement

- [x] 3.1 Add normalized location, employment-type, compensation-period, and currency eligibility evaluation; verify explicit conflicts hard-exclude or require confirmation while unknown pay remains neutral
- [x] 3.2 Propagate eligibility conflicts through discovery and policy evaluation, including RemoteOK USD metadata; verify unsuitable jobs cannot be auto-applied
- [x] 3.3 Add centralized per-mode eligibility preferences for both production profiles and verify the profile API reports complete configurations

## 4. Safer Browser Automation

- [x] 4.1 Support hidden native resume inputs while preserving visibility checks for other fields; verify the browser fixture uploads a hidden file input
- [x] 4.2 Require newly observed submission evidence or URL transition and tighten field matching; verify pre-existing success text cannot produce a false submitted result

## 5. Production Isolation and Deployment

- [x] 5.1 Add a repeatable deployment script that creates a dedicated worker account, shared staging group, root-owned runtime, restrictive state directories, and Chromium installation; verify ownership and modes after deployment
- [x] 5.2 Harden the API and worker systemd units and run the worker as the dedicated account with no home access; verify systemd security analysis and browser launch under the unit
- [x] 5.3 Deploy the migration, restart worker then API, and verify health, authentication, profile binding, and no regression to centralized the host system configuration

## 6. Verification and Delivery

- [x] 6.1 Run the complete test, syntax, OpenSpec strict validation, and dependency-audit suites with all checks passing
- [x] 6.2 Archive the completed OpenSpec change into canonical specs, commit the implementation, and push the private GitHub repository; verify the remote branch contains the final commit
