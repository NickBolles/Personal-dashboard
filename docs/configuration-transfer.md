# Configuration transfer (not a backup)

Admins can open **Settings → Configuration transfer** to move stored integration
configuration to another Jarvis instance. The destination must already be claimed;
this is not an instance-cloning or disaster-recovery feature.

## Scope and safe defaults

- Only registry-allowlisted, **stored integration fields** are exported (including
  Finance's connection settings, never its financial records).
- Stored integration secrets are **off by default**. Explicitly select the checkbox
  to include API keys, integration tokens and other registry-declared secrets.
  Encryption is mandatory whether or not secrets are included. Do not put secrets
  into ordinary URL/text/prompt fields; their classification follows Connections.
- Deployment environment values, the database encryption key, users, passcodes,
  sessions, device credentials, personal/household preferences, assistant backend
  settings, conversations, finance accounts/balances/transactions, approvals,
  caches and validation/readiness markers are **not exported**.
- Exports have no enabled-state field. Added/replaced integrations are always
  **disabled and unverified**. No upstream calls, tests, refreshes, notifications,
  or schedules are started by import. Already running work is not canceled.
- Environment-managed integrations count as existing even without a stored row.
  Environment overrides are never changed; the preview flags their presence.
- Existing entries are preserved by default. **Replace matching existing
  integrations** replaces the whole matching entry: omitted fields revert to
  defaults; omitted secrets are removed. Other integrations remain untouched.
  For replaced Finance connections the old Monarch-validation marker is cleared.

## Export and import

1. Use HTTPS. Choose a unique strong password of at least 12 characters (maximum
   1024 UTF-8 bytes); confirm it for export. Download the encrypted JSON file.
2. Store the password separately in a password manager. There is no password
   recovery. Anyone with both the file and password can recover included secrets.
3. On the destination, choose the encrypted file and enter its password. Preview
   shows integration names, field/secret **counts**, preserve/add/replace actions,
   and environment-override warnings. It never returns imported values, URLs,
   prompts or credentials.
4. If needed, explicitly choose replacement and preview again. Review before
   applying. A concurrent stored integration change invalidates the preview;
   re-preview rather than overwriting it silently.
5. Review Connections, supply any omitted secrets, test and deliberately enable
   each imported integration. Readiness is not carried across instances.

## File and API security contract

Version 1 uses AES-256-GCM with a fresh 96-bit nonce and 256-bit random salt per
export. scrypt derives a 256-bit key (`N=131072`, `r=8`, `p=1`, maximum memory
192 MiB). Format/version, cipher, KDF/cost, salt and nonce are authenticated as
canonical JSON additional data. The 128-bit GCM authentication tag is mandatory.
Version/cipher/KDF parameters must match these exact supported values; there is
no plaintext or weaker-parameter fallback. Wrong passwords and tampered/invalid
files receive the same safe error. Unknown fields/kinds/versions, duplicate
integrations, incorrectly classified fields and invalid field types are rejected.

Limits: 128 KiB file, 64 KiB decrypted payload, 192 KiB streamed HTTP request,
4000 characters per field, at most one entry per known integration. One bounded,
asynchronous KDF can run per process; overlapping attempts get HTTP 429 rather
than allocating an unbounded queue. This is not a distributed rate limiter.

All operations use `POST /api/settings/configuration`, authenticated with the
`admin` capability **and** the CSRF header/origin check (even for device-token
callers). Passwords never go in query strings. Responses are `no-store`.
The import is decrypted and validated again on apply; all replacements go
through the existing encrypted integration storage pathway inside one immediate
SQLite transaction. Errors roll back the whole import. No secret/file/password
content is audited or logged. Plaintext files are never written by this feature;
only encrypted exports are downloaded. Plaintext necessarily exists transiently
in process memory; JavaScript strings cannot be reliably zeroized. File/password
state is not put into browser storage and is cleared after successful operations.

For full restore, use the separate backup/restore process in
[operations.md](operations.md). A backup contains instance data and has different
key-preservation, encryption-at-rest and restore requirements. This feature does
not change or replace that process.
