# Operations

## Deploy (home server, Docker Compose + Traefik)

```bash
git clone https://github.com/NickBolles/Personal-dashboard jarvis && cd jarvis
cp .env.example .env        # set JARVIS_DOMAIN, TRAEFIK_*, JARVIS_VAPID_SUBJECT
docker network inspect <approved-proxy-network>    # substitute the actual user-defined proxy network
docker compose up -d --build
docker compose logs jarvis | grep "Setup code"
```

Open your configured HTTPS domain, enter the setup code, and follow onboarding. Confirm Traefik is attached to the same network and run `docker compose config --quiet` before starting. The Unraid audit found built-in `bridge` networking, not the assumed external user-defined network: deployment needs an approved compatible topology, not just these example commands.

Production Compose has **no app host port**. For deliberate local debugging only, add `-f docker-compose.local.yml` after `-f docker-compose.yml`; it publishes `127.0.0.1:${JARVIS_PORT:-3000}` and forces local passcode authentication. Do not expose that port to the LAN or use it with proxy auth. HTTPS remains necessary for normal secure-cookie browser acceptance.

Proxy mode requires a real authenticating middleware (see docs/security.md), not merely the default `jarvis-headers` security-header middleware.

Hermes must be reachable from the Jarvis container. Put both on a shared Docker network (e.g. add Hermes' compose service to the `jarvis_default` network, or Jarvis to Hermes' network) and use `http://<hermes-service>:8642`. Never publish the Hermes API port publicly.

## Demo / try it without real services

```bash
docker compose -f docker-compose.demo.yml up --build   # http://localhost:3000, setup code DEMO
# or locally:
npm ci && npm run dev:demo
```

Each onboarding step then offers **Use demo values**.

## Health

- `GET /api/health` — liveness (no dependencies)
- `GET /api/ready` — DB reachable and migrated, worker status
- Container `HEALTHCHECK` uses `/api/ready`.

## Backup & restore

```bash
docker compose exec jarvis node scripts/backup.mjs     # → /data/backups/<timestamp>/ (keeps 14)
docker compose cp jarvis:/data/backups ./jarvis-backups
```

Restore: `docker compose stop jarvis`, copy `jarvis.db` (and `secret.key` unless you set `JARVIS_SECRET_KEY`) into the volume, `docker compose start jarvis`. The CI "docker" job runs a restart-persistence + backup drill on every push.

## Upgrades & rollback

- Migrations run automatically at startup (Drizzle, forward-only). Take a backup before upgrading.
- Rollback: `git checkout <previous tag> && docker compose up -d --build`, then restore the pre-upgrade backup if the schema changed.

## Configuration reference (env)

See `.env.example`. Notable: `JARVIS_AUTH_MODE` (`local`|`proxy`), `JARVIS_AUTH_PROXY_HEADER`, `JARVIS_SECRET_KEY`, `JARVIS_PUBLIC_ORIGIN` (needed for Google OAuth redirect + Paperclip backlinks), `JARVIS_WORKER_INTERVAL_MS` (default 60 s), `JARVIS_MAX_STREAMS`, `JARVIS_TWA_ASSETLINKS`.

## Known limitations

- Hermes has no HTTP fork point. **Restart with text** seeds `conversation_history` only for a verified complete oldest-first transcript under 500 messages and a text-only prefix. Unsupported tool/reasoning/non-text context or unknown/truncated pagination is rejected before creating a child. Parent model/system settings are not copied; use **Fork latest state** for native full-context branching.
- Hermes memory contents are not exposed by the API server; Brain shows status, skills, toolsets and jobs.
- Skylight is read-only here, via Hermes by default. Chore completion is not enabled. Hermes sync sessions (`jarvis-sync:*`) are hidden and deleted after each answer. If you see leftovers in the Hermes dashboard, a sync was interrupted; they're safe to delete.
- Paperclip comments/status changes are implemented in the client but not surfaced in the UI yet (deep-link instead).
- Web Push on iOS requires installing the PWA first.
- Single household owner; no multi-user roles.
