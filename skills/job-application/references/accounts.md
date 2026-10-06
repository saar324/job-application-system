# Job-site accounts

Read this when the current official application requires login or registration.
Check the encrypted vault before asking the owner for credentials. Prior talent-network
registration is evidence of registration, not proof that a usable password exists.
The API owns encrypted storage; only this chat operates the internal browser.

## Existing login

1. Observe the live sign-in form and its HTTPS origin. Verify the destination belongs
   to the current application. Use `account-status APPLICATION_ID` with
   `{ "sessionId": "CURRENT_CHAT_ID", "origin": "https://employer.example" }`.
   `configured:false` is a system setup problem. `available:false` means no credential
   exists for this exact origin; do not claim the owner has no account.
2. When a matching credential exists and routine sign-in is authorized, call
   `account-download APPLICATION_ID` with the same input. It prints only an absolute
   private handoff path, origin and expiry. It never prints the password. The handoff
   expires after two minutes. Do not display, copy to an artifact, checkpoint or log,
   read through shell output, or place its contents in a tool-call argument.
3. Inside `cua_repl`, import `scripts/account-file.js` and use
   `consumeAccountFile(path, await tab.url())`. It validates the actual browser origin,
   private file permissions and expiry, then removes the file. Use the returned values
   directly in the observed username/password locators. Clear the local binding in a
   `finally` block. Never return, write, emit, screenshot or snapshot the password.
   Fill existing credentials only; do not create, change or reset passwords.
4. Click the observed Sign In control once. Observe a safe post-login view or explicit
   failure. Successful login does not submit an application or resolve a CAPTCHA,
   legal decision or unknown final outcome. Resume an account-access checkpoint only
   after login success is actually observed. If rejected, stop rather than repeatedly
   retrying or registering a duplicate. Do not mark this application submitted.

Credential access requires the same authenticated applicant, current claimed application,
session and actor. It is limited to the exact official application origin, including
port. A different authentication origin is a blocker, not permission to retrieve an
unrelated account. Account status does not release the queue hold.

## Registration and saving

When no matching login exists, review the actual registration form before proceeding.
Complete authorized non-binding ordinary fields. The owner must create or reset a
password. Stop at CAPTCHA, new Terms or permissions needing action-time approval.
Never claim registration is complete from generating a password or saving a record.
Use matching authorized email verification only for this same application.

After the owner completes password creation, an existing credential may be saved when
the owner explicitly authorized encrypted storage for this service. Capture only the
existing credential into a private regular JSON file (mode 0600) with `username` and
`password`; do not ask for a password in public output or include it in tool arguments.
Use `account-store APPLICATION_ID` with `{ "sessionId": "CURRENT_CHAT_ID",
"origin": "https://employer.example", "credentialFile": "/absolute/private/login.json",
"storageAuthorization": "Reference to the actual owner storage authorization" }`.
The client consumes the file after a successful save. It prints only safe metadata.
Saving an identical record is idempotent. A different existing password cannot be
overwritten by this operation; password updates require the owner. Do not save cookies,
OTP codes, OAuth grants or authentication tokens as passwords.

## Deployment and recovery

The vault reads original version-1 AES-256-GCM records with the original profile ID as
authenticated data. Preserve original keys and encrypted records together. Never rotate
keys, initialize an empty replacement over an old vault, or put credentials in applicant
answers. Configure `JOB_SERVER_CREDENTIAL_VAULTS` and either a private
`JOB_SERVER_VAULT_KEYS_FILE` or systemd `LoadCredential=job-vault-keys:...`.
Missing or damaged keys must fail closed and be reported as a system problem.
