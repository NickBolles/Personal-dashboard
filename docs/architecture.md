# Architecture

```
Phone / desktop browser (installable PWA)
        │ HTTPS (Traefik)
        ▼
Jarvis (Next.js 16 standalone, one container)
 ├─ UI (App Router, React 19, TanStack Query, Tailwind tokens)
 ├─ BFF route handlers  /api/*   ← auth + CSRF + validation (server/http/api.ts)
 ├─ Hermes SSE relay            ← /api/hermes/runs/:id/events
 ├─ Ranking service             ← server/ranking (deterministic, unit tested)
 ├─ Source aggregator           ← server/sources.ts (bounded parallel, timeouts, snapshots)
 ├─ Background worker           ← server/worker (instrumentation.ts): reconcile runs,
 │                                 refresh sources, derive alerts, push outbox
 └─ Integration adapters        ← integrations/<source>/ (upstream DTOs stay inside)
        │ internal Docker network / LAN
        ▼
 Hermes API Server · Paperclip · Home Assistant · Google Tasks · Skylight · (Daily Compass)
 Anthropic API (optional chat backend) · Monarch (optional balances)
```

## Ownership

| System                 | Owns                                                                                                                         | Jarvis keeps                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Hermes                 | sessions, messages, runs, approvals, memory, cron                                                                            | run tracking rows (until terminal), lineage for "fork from here", drafts (browser) |
| Paperclip              | initiatives, issues, status, blockers, assignments                                                                           | `entity_links` (conversation ↔ issue) only                                         |
| Google Tasks / HA todo | todo records                                                                                                                 | nothing (optional _built-in_ list when "Jarvis" is the canonical provider)         |
| Home Assistant         | device state                                                                                                                 | exception snapshots, health counts, audit of controls (never shared with Hermes)   |
| Skylight (via Hermes)  | calendar, chores                                                                                                             | validated structured-answer snapshots (`hermes_snapshot:skylight`)                 |
| Daily Compass (Hermes) | check-in state                                                                                                               | validated structured-answer snapshots; check-in conversation id                    |
| Jarvis                 | alerts inbox, push subscriptions, preferences, links, audit, people, finance check-ins and plan, Claude-direct conversations | all of it in SQLite                                                                |

## Key flows

**Phone app** (`android/`, Kotlin + Compose): a native client of the same API. It pairs with a one-time code (Settings → Phones), then sends `Authorization: Bearer jdv_…`. It caches last responses for instant open, and gets widgets from `/api/widget/summary` and notifications through FCM, which the server sends alongside web push. "Ask about …" attaches server-built source snapshots (`server/context.ts`, `contextSources` on runs) so web and phone attach the same thing. `contracts/api` holds the recorded responses both sides test against.

**Hermes-owned sources** (Skylight, Daily Compass): a structured request in a hidden throwaway Hermes session. It returns JSON only, is zod-validated and fails closed. The answer is cached and refreshed in the background, so Home never waits on a model (docs/integration-contracts.md).

**Hermes turn**: `POST /api/hermes/sessions/:id/runs` (idempotency key from the browser, retried with the same key) → Hermes `POST /v1/runs` → browser opens `EventSource /api/hermes/runs/:runId/events` → BFF relays `/v1/runs/:id/events`, normalizing events (`lib/hermes.ts`). If the stream closes without a terminal event the relay emits `stream.closed`; the client reconciles with `GET /api/hermes/runs/:id` and reconnects with `lastSeq`. Completion is only shown after a terminal event _and_ a status reconcile. Stop shows "Stopping…" until Hermes confirms.

**Fork**: "Fork latest state" uses Hermes' native `POST /api/sessions/:id/fork` (copies the full transcript; Hermes marks the source `end_reason=branched` but its messages are unchanged). The pinned Hermes has no HTTP fork point. **Restart with text** creates a child and seeds its first run with `conversation_history` through the selected message only after verifying oldest-first pagination (offset 0, fewer than 500 rows, returned count matches) including compacted rows. Tool, reasoning, hidden, system and non-text prefix context is rejected, never filtered out. Parent model/system configuration is not copied. Lineage is stored in `session_meta`; live context persistence still needs acceptance testing.

**Home**: `GET /api/home?cached=1` returns last-known snapshots instantly; `GET /api/home` fans out to sources (max 4 in parallel, 6s timeout each). A failing source falls back to its snapshot and is labelled `error`/`unauthorized`/`stale` — never rendered as empty. Ranking order: critical → awaiting_user → overdue → due_soon(≤4h) → checkin_window → today → upcoming; ties: pinned → due → recently changed → id.

**Alerts**: `notify()` writes the canonical inbox row (dedupe by key, escalation resurfaces). The worker's outbox sends Web Push for categories with push enabled, holding non-critical pushes during quiet hours. Read / dismissed / acted are independent timestamps.

**Home controls**: allowlist only → live state token shown in a confirmation dialog → server re-reads state and refuses if it changed → calls the service → success only after readback. Offline: disabled, never queued.

**People and capabilities** (`lib/modules.ts`, `server/access.ts`): each module declares capabilities (e.g. `finance.view`, `home_assistant.control_lights`). Roles (admin, adult, kid, household tablet) give defaults; Settings → People overrides them per person (`user_capabilities`). Every route checks with `api({ cap })`, every page with `requirePage()`, and navigation hides what a person can't use (`useAccess` on the web, `LocalAccess` on the phone). Hermes conversations are private to their owner; an owner can share one read-only with the household. Alerts go to the people holding the source's capability (`notifyHolders`), with per-person push and quiet-hours preferences.

**Search** (`server/search.ts`): Ctrl K or `/` on the web and Search on the phone. Each module registers a provider; results are filtered by capability, and a slow provider is reported as partial and never blocks the others.

**Assistant backends** (`server/assistant/`): Hermes or Claude direct (Anthropic API, `server/assistant/local.ts`) for chat, picked per conversation. Claude conversation and run ids start with `loc_`/`lrn_`, so every chat route dispatches by id and streams the same RunEvents. Claude runs use adaptive thinking, low effort by default for speed, and the API's server-side fallback on refusals. Its conversations live in `ai_sessions`/`ai_messages`. Hermes-owned features (Skylight, Daily Compass, Brain) stay on Hermes.

**Finance** (docs/finance.md): a pure engine in `lib/finance/`, storage in `fin_*` tables, balances from manual entry, CSV or Monarch. It feeds Home a status card with no amounts (`integrations/finance/adapter.ts`).

**Lights, doors and cameras** (`integrations/home-assistant/devices.ts`): everyone with `home_assistant.view` sees every door, lock, light and camera. Lights switch directly (all, allowlisted or none), always with readback. Doors and locks stay behind the confirmed allowlist. Camera stills are proxied with `no-store`, so the HA token never reaches a browser or phone.

## Why process-wide singletons?

Next compiles route handlers and `instrumentation.ts` into separate bundles, so module state is not shared. Token caches and rotation locks (Skylight refresh tokens rotate on every use) live on `globalThis` via `server/singleton.ts`.
