# Security

## Threat model (single household, self-hosted)

| Threat                                     | Mitigation                                                                                                                                                                                                                                         |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Someone on the LAN claims a fresh instance | One-time setup code printed in the server log (or `JARVIS_SETUP_CODE`) is required to claim.                                                                                                                                                       |
| Passcode guessing                          | scrypt hashes; exponential lockout after 5 failures per client. Prefer `JARVIS_AUTH_MODE=proxy` behind Authelia/Authentik/oauth2-proxy for remote access.                                                                                          |
| CSRF                                       | Every mutation needs `x-jarvis-csrf: 1` (forces CORS preflight, which Jarvis never approves) **and** a same-origin `Origin`. Cookies are `HttpOnly; SameSite=Lax; Secure` in production.                                                           |
| Credential leakage to the browser          | Upstream credentials stay server-side, AES-256-GCM encrypted at rest (`JARVIS_SECRET_KEY` or `/data/secret.key`). Public integration views only say whether a secret is set. `npm run secrets:scan` checks client bundles and tracked files in CI. |
| Credentials in Hermes tool output          | Hermes redacts previews; Jarvis scrubs again (`scrub()` in `integrations/hermes/normalize.ts`).                                                                                                                                                    |
| Arbitrary session/run IDs                  | Session IDs validated by pattern; run IDs must belong to the user in the `runs` table before stop/approve/steer/stream.                                                                                                                            |
| Physical-world actions                     | HA allowlist (default: lock and close only; unlock/open are explicit opt-ins), explicit confirmation, live state token check, readback verification, audit log, disabled offline. Jarvis is never the only way to unlock a door.                   |
| Home data reaching the AI layer            | Home Assistant actions/alerts can't be attached as Hermes context: hidden in the UI (`lib/privacy.ts`) and rejected server-side (`server/privacy.ts`). See below.                                                                                  |
| Hermes-owned sources misreporting          | Structured requests (Skylight, Daily Compass) fail closed on prose, `{"error"}` or schema mismatch, stop on any approval request, and only count a completion that Hermes read back.                                                               |
| Duplicate side effects                     | Idempotency keys for Hermes runs (browser-generated, reused on retry) and Paperclip creates (deterministic from title + parent).                                                                                                                   |
| Resource exhaustion                        | Request body limit (256 KB), max concurrent SSE relays (`JARVIS_MAX_STREAMS`, default 8), per-source timeouts.                                                                                                                                     |
| Clickjacking / injection                   | CSP, `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `nosniff`.                                                                                                                                                                                 |
| Caching sensitive data offline             | The service worker never caches `/api/*`. IndexedDB holds only drafts and bounded snapshots (≤10 sessions). "Clear local cache" in Settings wipes it.                                                                                              |

## What never reaches Hermes

Following the home automation assessment, these never go to the AI layer, in any form: camera data, presence/occupancy, person and device-tracker state, precise location, lock/alarm/garage/cover **state**, entity IDs, device names, credentials, webhook IDs, and calendar content from Home Assistant.

In Jarvis this means:

- Home Assistant is read and controlled **directly** by the Jarvis server. None of it is sent to Hermes, and Jarvis's own Hermes requests (chat, structured syncs) never include it.
- "Ask Hermes about this" is not offered on Home Assistant cards, and the context picker excludes Home Assistant actions and alerts. `POST /api/hermes/sessions/:id/runs` rejects context that references `home_assistant:*` or a Home Assistant alert (`400 private_context`).
- The Home Assistant health panel is counts only (no entity IDs). Anything unreadable shows "unknown", never 0.

What you type into chat yourself is yours to send; Jarvis doesn't scan free text.

## Secret map

| Secret                                                                                                               | Where it lives                                                                          |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Jarvis encryption key                                                                                                | `JARVIS_SECRET_KEY` env, else `/data/secret.key` (0600)                                 |
| Owner passcode                                                                                                       | scrypt hash in SQLite                                                                   |
| Hermes `API_SERVER_KEY`, HA token, Paperclip board key, Google client secret + refresh token, Skylight refresh token | encrypted in `integrations.secrets`, or env overrides (`HERMES_API_KEY`, `HA_TOKEN`, …) |
| VAPID private key                                                                                                    | encrypted in `settings` (or `JARVIS_VAPID_*` env)                                       |
| Session cookies                                                                                                      | sha256 of the token stored in `auth_sessions`                                           |

Backups (`scripts/backup.mjs`) contain the encrypted DB **and** the key file: store them privately.

## Audit

`audit_log` records actor, action, source record, result (`ok`/`error`/`rejected`/`pending`) and correlation ID for: Hermes starts/stops/approvals/steers/renames/forks, HA controls, todo mutations, Paperclip track/unlink, integration changes, passcode change. Values that look like credentials are redacted before storage. View it at Settings → Activity log.
