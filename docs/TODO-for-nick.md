# Your setup checklist

Code readiness is not live acceptance. Automated tests cover the app and setup guards; deployment, credentials, phone installation, and real-provider checks below still require approval and verification. In-app onboarding walks through steps 3–8, but Save & test alone does not prove every end-to-end workflow.

## 1. Deploy on the home server (≈10 min)

- [ ] Approve deployment of `jarvis.nickbolles.com` and verify DNS/TLS. The read-only Unraid audit observed Traefik entrypoint `https`, resolver `letsencrypt`, and Docker `bridge`, not a user-defined `traefik` network. The production Compose file assumes an external user-defined network: agree on and preflight compatible networking before starting it; do not blindly use the VPS defaults or assume service-name DNS on the built-in bridge.
- [ ] Install/verify Docker Compose v2 on the deployment host (Docker CLI was present, Compose plugin was absent). No Jarvis deployment was running at the audit.
- [ ] `git clone … && cp .env.example .env`, then set `JARVIS_DOMAIN`, `TZ`, `JARVIS_VAPID_SUBJECT=mailto:<you>`, and optionally `JARVIS_SECRET_KEY`.
- [ ] `docker compose up -d --build`, then `docker compose logs jarvis | grep "Setup code"`.
- [ ] Keep `JARVIS_AUTH_MODE=local` unless authenticating middleware is configured and tested. Proxy mode trusts identity headers; `jarvis-headers` only sets security headers and is **not authentication**. See docs/security.md. Production Compose publishes no app host port; the explicit loopback-only local override must not be used for proxy mode.

Want to look around first? Run `docker compose -f docker-compose.demo.yml up --build` and use setup code `DEMO`.

## 2. The Jarvis Android app (S22)

Native app with widgets; details in docs/android.md.

- [ ] Create a signing key once (`keytool …` in docs/android.md) and keep it in your password manager.
- [ ] GitHub → Settings → Secrets → Actions: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
- [ ] Actions → **Android app** → Run workflow with **publish a GitHub release** ticked. Install the APK from the release on your phone.
- [ ] Jarvis on the web → **Settings → Phones → Show pairing code**, then **Scan pairing code** in the app.
- [ ] Notifications: create a free Firebase project, add an Android app `com.nickbolles.jarvis`, then paste **google-services.json** and a **service-account key** in Settings → Phones. In the app: Settings → **Send a test**.
- [ ] Add widgets (long-press home screen → Widgets → Jarvis): Next up, Home status, Ask Hermes, Daily Compass. Add the **Ask Hermes** Quick Settings tile.
- If Authelia/Authentik is in front (`JARVIS_AUTH_MODE=proxy`): let `/api/*` requests with an `Authorization: Bearer` header through to Jarvis.
- The browser install (Chrome ⋮ → Install app, web push in Settings → Notifications) still works if you'd rather not use the APK.

## 3. Hermes (required)

The read-only home audit found the Hermes API **already enabled**: `/health` returned 200, version `0.21.5`. Hermes is on Docker `bridge`, with 8642 published on all host interfaces and an existing Traefik API route. This is observed topology, not approval to expose it or proof of authenticated integration acceptance. Leave the existing service unchanged until networking/security changes are explicitly approved.

- [ ] Confirm an approved server-to-server path from Jarvis to the existing API and retrieve the existing API key securely. Do not re-enable, restart, rotate credentials, or alter port exposure merely to follow this checklist.
- [ ] Review the existing 8642 exposure separately. A user-defined shared network is an option, not the current topology; container-name DNS must be verified before using `http://<hermes-container>:8642`.
- [ ] Onboarding → Hermes: enter the URL and key, then **Save & test**.
- [ ] With explicit permission to create test conversations, verify **Restart with text** on real Hermes. It seeds `conversation_history` only after a complete oldest-first transcript under 500 messages is verified; tool/reasoning/non-text prefixes fail closed. It does not copy model/system settings. Verify the earlier text is actually available to the new run. **Fork latest state** uses the native endpoint, preserves full context, and marks the source as branched.
- [ ] Optional: set the operator dashboard URL for deep links.

## 4. Todos — decide the canonical list

Your only todo integration today is **Google Tasks**, used through the gtasks MCP on the VPS.

- [ ] In Google Cloud Console → APIs & Services, enable the **Google Tasks API**.
- [ ] Create an OAuth client of type **Web application**. Add the redirect URI `https://<domain>/api/integrations/todos/oauth/callback`. Add yourself as a test user on the OAuth consent screen.
- [ ] Onboarding → Todos: paste the client ID and secret, then **Connect Google** → consent → **Save & test**. Pick the task list it discovers.
- Alternatives: a Home Assistant to-do entity, or "Built into Jarvis".

## 5. Daily Compass (Hermes-owned)

Daily Compass lives in Hermes, so Jarvis asks Hermes for today's state instead of keeping its own copy. It sends a structured, JSON-only request and caches the validated answer (docs/integration-contracts.md → Structured Hermes requests).

- [ ] Onboarding → Daily Compass: keep **Hermes owns Daily Compass** (the default). Set your window and reminder. Defaults: 19:00–22:00, reminder at 20:00.
- [ ] Press **Save & test**. "Read today's state via Hermes" must pass. If Hermes answers `{"error": …}` or in prose, the check says so. Adjust the status request under _advanced_ so it names your Daily Compass tool/skill.
- [ ] Try **Mark complete** once. Jarvis only reports done when Hermes reads the state back as completed for today. If your Hermes asks for approval on that write, Jarvis stops and tells you. Then either allow that tool in Hermes or do it in chat.
- Alternatives remain: "Stored in Jarvis" or an external HTTP endpoint.

## 6. Home Assistant

- [ ] Create a long-lived token: HA → Profile → Security. An **admin** user's token also lets Jarvis count integrations that failed to load. Otherwise that count shows "unknown".
- [ ] Onboarding → Home Assistant: enter URL `http://192.168.1.249:8123` and the token. Watched entities are pre-filled from your config: alarm, front lock, both garage doors, front and back doors.
- [ ] Review the **allowed controls**. Per the assessment's rules on sensitive domains, the defaults are the **safe direction only**: lock the front door, close each garage. Add `, unlock` or `, open_cover` to a line only if you want that from your phone. Jarvis should never be the only way to unlock a door.
- [ ] Calendars: `calendar.family_calendar` is pre-filled for the household glance.
- [ ] Glance at Home → **Home Assistant health**: counts of unavailable/unknown entities, pending updates, and failing integrations. Anything unreadable is "unknown", never 0.
- Ask about your home: **Ask Hermes about my home** on the Home page starts a conversation with a snapshot of exceptions, controllable entities and health (docs/security.md → Home Assistant and Hermes).
- ⚠️ Separate from Jarvis, from the assessment: `hass-config/automations.yaml` (~line 568) has a webhook token committed in plain text. Rotate it and move it to `secrets.yaml`. Also leave the HA MCP server as a _future_ read-only channel for Hermes. Jarvis doesn't need it.

## 7. Skylight (Hermes-owned, read-only)

- [ ] Onboarding → Skylight: keep **Via Hermes** (the default), then **Save & test**. "Read Skylight via Hermes" should report this week's events and today's open chores.
- [ ] If the check fails, open _advanced_ and edit the request so it names your Skylight tool. Keep it read-only. Placeholders: `{from}`, `{to}`, `{timezone}`.
- [ ] Sync interval defaults to 30 minutes. Each sync is one short hidden Hermes run, deleted afterwards.
- Direct mode (unofficial API with a rotating refresh token, via **Sign in to Skylight** or `skycli auth login`) is still there as a fallback.

## 8. Paperclip (optional)

The read-only home audit found **Paperclip-HTTPS already deployed**, on Docker `bridge`, port 3100. Jarvis connectivity, authentication and company selection remain unverified.

- [ ] After approval, provision a dedicated board token against the existing deployment: `npx paperclipai token board create --name jarvis`. The key expires after 30 days by default; use `--ttl-days` or `expiresAt: null` for longer.
- [ ] Onboarding → Paperclip: enter the URL and key, then pick the company. Set **Browser URL** if you open Paperclip at a different address.

## 9. People: your wife, the kids, the home tablet

- [ ] Settings → **People → Add someone**. Pick a role: **Adult** (own private conversations and alerts, home, finances), **Kid** (household calendar and Skylight, no Hermes) or **Household tablet** (calendar, Skylight, home status, lights and the safe door controls; signs in with a 4+ digit PIN).
- [ ] Hand them the one-time **invite link**, or set their passcode yourself. They sign in with their name and passcode.
- [ ] Fine-tune per person: **Edit** shows each module's capabilities (for example, turn off cameras or finances for someone).
- Conversations are private. Open one and use **Share with the household** to let others read it.

## 10. Claude as a faster chat backend (optional)

- [ ] Settings → **Assistant**: paste an Anthropic API key (or set `ANTHROPIC_API_KEY`). Pick the default (Hermes or Claude) and the effort. **Low** is the default, for speed.
- Every new conversation can go to either; Ask shows a Hermes / Claude choice. Claude answers directly with the Jarvis context you attach. It has no Hermes tools, memory or approvals, and it never gets your finances. If Claude declines a request, the API's server-side fallback retries it once with another model before Jarvis reports "declined".

## 11. Finance (docs/finance.md)

- [ ] Settings → Connections → **Finance**: start with **Manual entry and CSV import**.
- [ ] Finance → **Accounts**: add checking, savings and cards, then enter balances (or import a CSV).
- [ ] Finance → **Funds & reserve**: set the checking cushion, then add your funds (and mark any protected).
- [ ] Run your first month-end **check-in** and close it.
- [ ] **Monarch (release blocker until done):** switch the source to Monarch and paste the session token (`monarch login`, or your browser session). Map each account, then **Refresh balances**. The code validation marker requires a completed, non-mock refresh, every mapped balance imported with a valid provider timestamp, and successful transaction import/run finalization. Legacy markers without run provenance do not qualify. This marker is not proof of balance-sign correctness or complete live acceptance.
- [ ] While you're there, check that one credit card's balance owed shows as **negative** in Jarvis. Compare both an ordinary amount owed and any credit/overpayment with Monarch before changing normalization. Preserve the existing sign conversion until that evidence is available; do not apply `abs()` blindly.
- [ ] Notifications → **Finance** is off by default. Turn it on if you want "check-in ready / needs attention" pushes. They never include amounts or account names.

## 12. Lights and cameras

- [ ] Settings → Connections → Home Assistant → **Light switching**: all lights (the default), only allowlisted ones, or none.
- [ ] Home controls now lists every door, lock, light and camera. Camera stills load on tap and are never cached.

## 13. Visual baselines in CI (one click, if needed)

- [ ] The "Update visual baselines" workflow runs automatically on the first push and commits `e2e/__screenshots__/ci`. If it didn't, run it from the Actions tab (workflow_dispatch). After that, CI compares screenshots.

## 14. Optional later

- [ ] Schedule backups: `docker compose exec jarvis node scripts/backup.mjs` in cron (keeps 14).
