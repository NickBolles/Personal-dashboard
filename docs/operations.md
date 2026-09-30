# Operations

## Deploy (home server, Docker Compose + Traefik)

```bash
git clone https://github.com/NickBolles/Personal-dashboard jarvis && cd jarvis
cp .env.example .env        # set JARVIS_DOMAIN, TRAEFIK_*, JARVIS_VAPID_SUBJECT
docker network create traefik 2>/dev/null || true   # skip if your Traefik network exists
docker compose up -d --build
docker compose logs jarvis | grep "Setup code"
```

Open `https://$JARVIS_DOMAIN`, enter the setup code, and follow onboarding.

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

- Hermes has no HTTP fork point; "Fork from here" is a Jarvis approximation using `conversation_history`.
- Hermes memory contents are not exposed by the API server; Brain shows status, skills, toolsets and jobs.
- Skylight has no official API and is read-only here; chore completion is not enabled.
- Paperclip comments/status changes are implemented in the client but not surfaced in the UI yet (deep-link instead).
- Web Push on iOS requires installing the PWA first.
- Single household owner; no multi-user roles.
