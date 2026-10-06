# Jarvis — personal command center

A mobile-first, self-hosted PWA whose primary interface is **Hermes** and whose home screen answers one question: _what needs my attention, and what should I do next?_

- **Home** — up to three ranked next actions (deterministic, with source + freshness), quick capture, Later groups, household glance.
- **Hermes** — conversations with live streaming, tool activity, inline approvals, steering, stop, reconnect-safe runs, drafts, fork (latest or from a message) with lineage, rename/archive/pin, model override, context attachments, "Track in Paperclip".
- **Alerts** — canonical inbox (dedupe, read/dismissed/acted), Web Push with quiet hours and per-category settings, deep links.
- **More** — Initiatives (Paperclip), Todos (Google Tasks / HA / built-in), Skylight, Daily Compass, Home controls (every door, lock, light and camera; lights switch with readback; door controls allowlisted and confirmed), Brain (Hermes status, skills, toolsets, cron jobs), Settings.
- **Finance** — monthly household check-in (card payments, checking reserve, funds, daily liquidity check), funds and a long-term plan. Manual, CSV or Monarch balances. Never moves money; no amounts in notifications. See [docs/finance.md](docs/finance.md).
- **People** — you, your partner, kids and a shared home tablet, each with their own sign-in, private conversations, alerts and per-module capabilities.
- **Search** — Ctrl K / `/` across conversations, todos, devices, calendar, finance and pages, scoped to what each person can see.
- **Swappable AI** — Hermes, or Claude directly through the Anthropic API when Hermes is slow, chosen per conversation.
- **Onboarding** — claim with a one-time setup code, connect + live-test every integration (or use the bundled demo server), enable push, install the app, verify everything.
- **Native Android app** (`android/`, Kotlin + Compose): Home, Chat with approvals, Alerts, Home controls, Skylight, Todos, Daily Compass, "Ask Hermes about …" any source, home-screen widgets, a Quick Settings tile, share-to-Jarvis and FCM notifications. Pairs with a QR code. Screenshot-tested with Roborazzi. See [docs/android.md](docs/android.md).
- **Installable PWA** too: manifest, maskable icons, service worker, offline shell, share target, shortcuts.

## Quick start

```bash
npm ci
npm run dev:demo          # mock upstreams + next dev → http://localhost:3000, setup code DEMO
```

Production (home server, Traefik): see [docs/operations.md](docs/operations.md).

```bash
cp .env.example .env && docker compose up -d --build
docker compose logs jarvis | grep "Setup code"
```

## Validation

| Command                                                       | What it checks                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck` / `npm run lint` / `npm run format:check` | TS strict, ESLint (Next + React compiler rules), Prettier                                                                                                                                                                                                                                                 |
| `npm test`                                                    | Vitest: ranking (every reason + tie-breaker), SSE parser, Hermes contract fixtures, run-state reducer, time/DST, crypto/auth/CSRF, notifications dedupe, HA rules + controls, adapter integration against the mock server, worker alerts, backup drill                                                    |
| `npm run test:e2e`                                            | Playwright against the production build + mock upstreams: full onboarding, Home ranking/failure states, chat (approvals, stop, dropped stream, fork, drafts, keyboard), alerts, home controls, initiatives, share target, CSRF, axe a11y + 320px/200% reflow, visual snapshots (mobile 320, 412, desktop) |
| `npm run secrets:scan`                                        | No secrets in client bundles or tracked files                                                                                                                                                                                                                                                             |
| `npm run verify`                                              | All of the above                                                                                                                                                                                                                                                                                          |

CI (`.github/workflows/ci.yml`) runs everything plus a Docker build, restart-persistence and backup drill.

## Docs

- [Architecture](docs/architecture.md) · [Security](docs/security.md) · [Integration contracts](docs/integration-contracts.md) · [Operations](docs/operations.md) · [Android](docs/android.md) · [Finance](docs/finance.md)
- [Your setup checklist](docs/TODO-for-nick.md) — the steps that need your browser/accounts
- Upstream API research: [Hermes](docs/research/hermes-api.md), [Paperclip / Skylight / HA / Web Push](docs/research/integrations-api.md)

## Layout

```
app/            routes: (shell)/home, chat, alerts, more, todos, skylight, daily-compass, home-control, finance, brain, initiatives, settings (+ people); onboarding, login, join, share; api/*
components/     UI (navigation, chat, actions, integrations, onboarding)
integrations/   hermes, paperclip, todos (google/ha/jarvis), daily-compass, home-assistant, skylight, finance, monarch — upstream DTOs stay here
server/         auth, access, people, search, assistant (Hermes | Claude), finance, db (Drizzle/SQLite), ranking, notifications (+push), audit, sources, worker, http
lib/            shared contracts, SSE parser, time, client helpers (api, IndexedDB, push)
mock-upstreams/ faithful mock servers for demo + tests
contracts/      sanitized upstream fixtures for contract tests
e2e/            Playwright specs
```
