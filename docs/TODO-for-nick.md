# Your setup checklist

Everything that needs your accounts, browser, or home network. The app, tests, CI, Docker, and docs are done. Each step says where it plugs in. In-app onboarding walks through steps 3–8 and tests each connection live.

## 1. Deploy on the home server (≈10 min)

- [ ] Pick a hostname, e.g. `jarvis.nickbolles.com`, and point DNS at the server running Traefik. No Traefik config for the Unraid box exists in any repo; the VPS one uses certresolver `mytlschallenge` on network `traefik`. Adjust `TRAEFIK_*` in `.env` to match the home server.
- [ ] `git clone … && cp .env.example .env`, then set `JARVIS_DOMAIN`, `TZ`, `JARVIS_VAPID_SUBJECT=mailto:<you>`, and optionally `JARVIS_SECRET_KEY`.
- [ ] `docker compose up -d --build`, then `docker compose logs jarvis | grep "Setup code"`.
- [ ] Optional: put Jarvis behind Authelia/Authentik and set `JARVIS_AUTH_MODE=proxy`. The default is passcode login.

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

Your `hermes-agent-docker-aio` compose only exposes the dashboard on :18789. The API server isn't enabled yet.

- [ ] In `$HERMES_HOME/.env` (`/opt/data/.env` in the container), set `API_SERVER_ENABLED=true`, `API_SERVER_HOST=0.0.0.0`, `API_SERVER_PORT=8642`, and `API_SERVER_KEY=<32+ random chars>`. The key must be at least 16 characters.
- [ ] Make sure the gateway runs (`hermes gateway`) alongside the dashboard, then restart.
- [ ] Put Hermes and Jarvis on a shared Docker network. **Don't publish 8642 publicly.** Use `http://<hermes-container>:8642` as the URL in Jarvis.
- [ ] Onboarding → Hermes: enter the URL and key, then **Save & test**.
- [ ] Verify "Fork from here" on the real Hermes. It uses `conversation_history`; check that the fork's transcript contains the earlier context. Fork latest state uses the native endpoint.
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

No Paperclip deployment was found in your repos.

- [ ] Once it's running: `npx paperclipai token board create --name jarvis`. The key expires after 30 days by default; use `--ttl-days` or `expiresAt: null` for longer.
- [ ] Onboarding → Paperclip: enter the URL and key, then pick the company. Set **Browser URL** if you open Paperclip at a different address.

## 9. Visual baselines in CI (one click, if needed)

- [ ] The "Update visual baselines" workflow runs automatically on the first push and commits `e2e/__screenshots__/ci`. If it didn't, run it from the Actions tab (workflow_dispatch). After that, CI compares screenshots.

## 10. Optional later

- [ ] Schedule backups: `docker compose exec jarvis node scripts/backup.mjs` in cron (keeps 14).
