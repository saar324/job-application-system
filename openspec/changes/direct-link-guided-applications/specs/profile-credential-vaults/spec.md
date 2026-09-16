## Purpose

Allows standard job-site accounts to be used without mixing credentials between profiles or exposing stored passwords to chat, state, logs, or the browser worker beyond the current domain.

## ADDED Requirements

### Requirement: Credential vaults are profile-isolated and encrypted
The API SHALL encrypt each profile’s credential vault with a distinct key, store credentials by normalized HTTPS origin, and never return password values through profile, application, confirmation, or audit APIs.

#### Scenario: Two applicants use the same site
- **WHEN** both profiles have an account for the same job site
- **THEN** each profile can retrieve only its independently encrypted credential

#### Scenario: Runtime files are inspected
- **WHEN** application state, confirmations, audit events, or vault files are read directly
- **THEN** no plaintext site password appears

### Requirement: Generated accounts use managed credentials
The API SHALL generate a cryptographically random password for supported new-account flows, store it directly in the active profile’s vault, and provide it only to the worker for the bound origin.

#### Scenario: Owner selects create account
- **WHEN** an authentication confirmation offers supported account creation and the owner selects it
- **THEN** the API generates and stores the credential without placing the password in Telegram or application state

### Requirement: Credentials are disclosed minimally to the worker
The API SHALL send at most one active profile credential per worker request, and the worker SHALL fill it only while the page hostname matches its bound origin.

#### Scenario: Cross-domain redirect
- **WHEN** a page redirects from the credential’s site to another hostname
- **THEN** the worker does not fill the username or password on the new hostname

### Requirement: Unsupported authentication pauses safely
The worker SHALL stop for owner action when authentication requires unknown existing credentials, MFA, email verification, CAPTCHA, passkeys, social login, or an unsupported account flow.

#### Scenario: MFA challenge
- **WHEN** the site asks for an OTP or second factor
- **THEN** the application becomes confirmation-required and no value is guessed

### Requirement: Worker configuration excludes vault authority
The production worker SHALL not receive API tokens, profile-store paths, vault keys, or access to encrypted profile vault files.

#### Scenario: Worker environment is inspected
- **WHEN** the deployed worker process environment and filesystem permissions are audited
- **THEN** only worker-specific execution secrets and directories are available
