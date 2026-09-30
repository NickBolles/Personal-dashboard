# Integration contracts

Pinned upstream versions and verified endpoints. Full research notes with fixtures: [`docs/research/hermes-api.md`](research/hermes-api.md), [`docs/research/integrations-api.md`](research/integrations-api.md). Sanitized fixtures used by contract tests live in `contracts/fixtures/`.

| Adapter operation                                         | Upstream endpoint                                                                                       | Status                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **Hermes** (hermes-agent `main@ddd0cc69`, tag v2026.9.24) |                                                                                                         |                                                             |
| health / capabilities                                     | `GET /health`, `GET /v1/capabilities`                                                                   | verified (source)                                           |
| list/get/create/rename/archive/pin session                | `GET/POST /api/sessions`, `GET/PATCH /api/sessions/:id`                                                 | verified                                                    |
| transcript                                                | `GET /api/sessions/:id/messages?order=latest&limit=500`                                                 | verified                                                    |
| fork latest                                               | `POST /api/sessions/:id/fork` `{title}`                                                                 | verified — no fork point; source gets `end_reason=branched` |
| fork from message                                         | new session + `POST /v1/runs` with `conversation_history`                                               | Jarvis approximation — **verify on your Hermes**            |
| start run                                                 | `POST /v1/runs` + `Idempotency-Key`                                                                     | verified                                                    |
| events                                                    | `GET /v1/runs/:id/events` (`data.event`, `Last-Event-ID`)                                               | verified                                                    |
| status / stop / approval / steer                          | `GET /v1/runs/:id`, `POST …/stop`, `…/approval`, `…/steer`                                              | verified                                                    |
| skills / toolsets / models                                | `GET /v1/skills`, `/v1/toolsets`, `/api/model/options`                                                  | verified                                                    |
| jobs                                                      | `GET /api/jobs`, `POST /api/jobs/:id/pause                                                              | resume                                                      | run` | verified (capability flag reads false; probed) |
| memory contents                                           | —                                                                                                       | not exposed by API server → deep link to dashboard          |
| **Paperclip** (`paperclipai/paperclip@f38b5693`)          |                                                                                                         |                                                             |
| companies / issues / issue detail                         | `GET /api/companies?scope=accessible`, `/api/companies/:id/issues`, `/api/issues/:idOrIdentifier`       | verified (source)                                           |
| create (idempotent)                                       | `POST /api/companies/:id/issues` `{idempotencyKey}`                                                     | verified (7-day replay → 200 `deduplicated`)                |
| deep links                                                | `{ui}/{issuePrefix}/issues/{identifier}`                                                                | verified                                                    |
| comments / status changes                                 | `POST /api/issues/:id/comments`                                                                         | client implemented, not surfaced in UI yet                  |
| **Home Assistant** (2026.10)                              |                                                                                                         |                                                             |
| states, service calls, calendars                          | `GET /api/states`, `POST /api/services/:d/:s`, `GET /api/calendars/:e?start&end`                        | verified (docs+source)                                      |
| todo list                                                 | `POST /api/services/todo/get_items?return_response`                                                     | verified                                                    |
| **Google Tasks**                                          | `GET /tasks/v1/lists/:list/tasks`, `PATCH …/tasks/:id`, OAuth refresh                                   | public API                                                  |
| **Skylight** (unofficial)                                 | OAuth refresh (`client_id=skylight-mobile`, rotating), `GET /api/frames`, `/calendar_events`, `/chores` | community clients — **read-only**, verify with your account |
| **Daily Compass**                                         | Jarvis-native (SQLite + Hermes conversation) or HTTP `GET {url}/today`, `POST {url}/today/complete`     | canonical store undecided — see TODO                        |

## Freshness & mutation guarantees

| Source         | Stale after | Mutations                                         | Success means                                              |
| -------------- | ----------- | ------------------------------------------------- | ---------------------------------------------------------- |
| Hermes         | 2 min       | runs, approvals, stop, steer, rename/archive/fork | upstream 2xx; run completion only after terminal status    |
| Todos          | 5 min       | complete, snooze (tomorrow)                       | readback shows new status/due                              |
| Home Assistant | 5 min       | allowlisted services                              | readback shows expected state (else "sent, not confirmed") |
| Daily Compass  | 10 min      | complete                                          | Jarvis row written / HTTP endpoint confirms                |
| Paperclip      | 10 min      | create/link (Jarvis link record)                  | 201 or 200 `deduplicated`                                  |
| Skylight       | 15 min      | none (read-only)                                  | —                                                          |
