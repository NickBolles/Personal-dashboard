# Your setup checklist

Everything that needs your accounts, browser, or home network. The app, tests, CI, Docker, and docs are done. Each step says where it plugs in. In-app onboarding walks through steps 3–9 and tests each connection live.

## 1. Deploy on the home server (≈10 min)

- [ ] Pick a hostname, e.g. `jarvis.nickbolles.com`, and point DNS at the server running Traefik. No Traefik config for the Unraid box exists in any repo; the VPS one uses certresolver `mytlschallenge` on network `traefik`. Adjust `TRAEFIK_*` in `.env` to match the home server.
- [ ] `git clone … && cp .env.example .env`, then set `JARVIS_DOMAIN`, `TZ`, `JARVIS_VAPID_SUBJECT=mailto:<you>`, and optionally `JARVIS_SECRET_KEY`.
- [ ] `docker compose up -d --build`, then `docker compose logs jarvis | grep "Setup code"`.
- [ ] Optional: put Jarvis behind Authelia/Authentik and set `JARVIS_AUTH_MODE=proxy`. The default is passcode login.

Want to look around first? Run `docker compose -f docker-compose.demo.yml up --build` and use setup code `DEMO`.

## 2. Install on your Android (S22)

- [ ] Open `https://<domain>` in Chrome, then use ⋮ → **Install app**. HTTPS is required.
- [ ] In Settings → Notifications, turn on **Enable push on this device**, then **Send a test alert**.

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

## 5. Daily Compass — decide what it is

I couldn't find "Daily Compass" anywhere. The closest thing is `life-progress`, a daily check-in coach on Vercel with Clerk auth, and it has no external API. For now Jarvis runs it **natively**: a check-in window, a reminder push, and a one-tap Hermes conversation, with completion stored in Jarvis.

- [ ] Set your window and reminder time in Onboarding → Daily Compass. Defaults: 19:00–22:00, reminder at 20:00. life-progress uses 20:00.
- [ ] If it should live in life-progress or elsewhere, expose `GET /today` and `POST /today/complete` (bearer token) and switch the mode to **External HTTP endpoint**. See docs/integration-contracts.md.

## 6. Home Assistant

- [ ] Create a long-lived token: HA → Profile → Security.
- [ ] Onboarding → Home Assistant: enter URL `http://192.168.1.249:8123` and the token. Watched entities are pre-filled from your config: alarm, front lock, both garage doors, front and back doors.
- [ ] Review the **allowed controls**. Pre-filled: lock/unlock front door and open/close both garages. Remove any you don't want controllable from your phone.
- [ ] Calendars: `calendar.family_calendar` is pre-filled for the household glance.
- ⚠️ Separate from Jarvis: `hass-config/automations.yaml` (~line 568) has a webhook token committed in plain text. Rotate it and move it to `secrets.yaml`.

## 7. Skylight (optional, read-only)

Skylight retired password login for API clients.

- [ ] Try **Sign in to Skylight** in onboarding. Your password is used once and not stored.
- [ ] If 2FA or device verification blocks it, run `skycli auth login` (github.com/jwmoss/skycli) and paste the refresh token. Jarvis rotates it automatically after that.

## 8. Paperclip (optional)

No Paperclip deployment was found in your repos.

- [ ] Once it's running: `npx paperclipai token board create --name jarvis`. The key expires after 30 days by default; use `--ttl-days` or `expiresAt: null` for longer.
- [ ] Onboarding → Paperclip: enter the URL and key, then pick the company. Set **Browser URL** if you open Paperclip at a different address.

## 9. Visual baselines in CI (one click, if needed)

- [ ] The "Update visual baselines" workflow runs automatically on the first push and commits `e2e/__screenshots__/ci`. If it didn't, run it from the Actions tab (workflow_dispatch). After that, CI compares screenshots.

## 10. Optional later

- [ ] Wrap Jarvis as an APK with PWABuilder and set `JARVIS_TWA_ASSETLINKS` (docs/android.md).
- [ ] Schedule backups: `docker compose exec jarvis node scripts/backup.mjs` in cron (keeps 14).
