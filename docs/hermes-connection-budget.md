# Hermes connection budget

Production reaches Hermes through Traefik (`hermes-api.ai.nickbolles.com`). Its router has an
`inFlightReq` middleware with no `sourceCriterion`, so the limit is shared by every client: it was
**10 requests in flight** until 2026-11-08, now **64**. Its `rateLimit` is per client IP (every LAN
client arrives as the router's hairpin address): 10 req/s (burst 20) until 2026-11-08, now 50 req/s
(burst 200). Above either limit Traefik answers `429 max connections reached: N` (or `Too Many
Requests`) before Hermes sees the request.

Two things used to break chat sends (Nov 2026):

- **Fan-out bursts.** The conversation-index warmer (every ~4 min) asked for the default session
  list, up to 30 routed sessions one GET each, and one list per routed profile, all at once: ~35
  requests in the same second. 8–13 of them got 429 each time, and a person creating a chat in
  that second got "Hermes returned 429: max connections reached: 10".
- **Streams hold a slot for the whole run.** Every open chat, rail or tray watching a run kept its
  own upstream SSE connection, even in hidden tabs, and Jarvis allowed 16 of them.

## What Jarvis does

`server/http/hermes-budget.ts` is a per-process budget every Hermes request goes through
(`integrations/hermes/client.ts` `call()`):

| Setting                                 | Default | Meaning                                                          |
| --------------------------------------- | ------- | ---------------------------------------------------------------- |
| `JARVIS_HERMES_MAX_CONNECTIONS`         | 24      | Requests in flight to Hermes at once (well below the proxy's 64) |
| `JARVIS_MAX_STREAMS`                    | 12      | Of those, run event streams (max / 2 when max is overridden)     |
| `JARVIS_HERMES_RESERVED_INTERACTIVE`    | 2       | Slots background work never takes, so a send always finds room   |
| `JARVIS_HERMES_RATE_PER_SEC` / `_BURST` | 20 / 40 | Token bucket under the proxy's rate limit (50/s, burst 200)      |

The defaults are constants in `server/http/hermes-budget.ts` (prod sets none of these). Streams are
always clamped below the connection limit (at least `max(1, reserve)` slots stay free of them), so
Stop, approvals and status calls get through even when `JARVIS_MAX_STREAMS` is set too high. Blank
values count as unset.

- **Lanes.** `interactive` (default: anything a person triggers) is served first, then `stream`,
  then `background`. Dispatcher ticks (index warmer, scheduled jobs, reminders), Hermes-backed
  syncs (Daily Compass, Skylight) and the routed-session fan-out run in the background lane via
  `withHermesLane("background", …)`.
- **429 retry.** A 429 means "not admitted", so `call()` retries with backoff (~0.3 s, 0.7 s,
  1.5 s, 3 s; 4 retries for people, 2 for background). Run starts keep their Idempotency-Key, so
  a retried start never runs twice. Out of retries the request fails as `upstream_busy` (HTTP 503,
  `Retry-After: 5`) with a plain message: "Hermes is busy right now …". The composer keeps the
  typed text.
- **Shared streams.** `relayRunEvents` opens ONE upstream event stream per run and fans it out to
  every browser stream watching it (chat page, coordinator rail, phone tray, other tabs and
  devices). A late joiner is replayed from the relay's buffer; the upstream closes when the last
  watcher leaves.
- **Queued, not failed.** When the stream budget is full the relay waits for a slot and sends
  `run.queued` with `reason: "connections"`; the chat shows "Queued — your message was sent.
  Jarvis is waiting for a free Hermes connection …" until events flow.
- **Hidden tabs let go.** A tab hidden for 30 s closes its run stream and resumes from the last
  event when it is visible again (`components/chat/useRunStream.ts`).

The budget is per Jarvis process. Other clients of the same Traefik host (anything on the LAN using
`hermes-api.ai.nickbolles.com`) share the proxy's 10 slots and are outside it.

## Owner levers (not applied by Jarvis)

- Raise or scope the Traefik limit (`/mnt/user/appdata/traefik-v3/fileConfig.yml`,
  `http.middlewares.hermes-api-inflight.inFlightReq`), e.g. `amount: 32` plus
  `sourceCriterion.ipStrategy` so one client can't starve the others.
- Or point Jarvis's Hermes base URL at the LAN address (`http://192.168.1.250:8642`), which skips
  Traefik's limits entirely; Hermes' own `gateway.api_server.max_concurrent_runs` (default 10)
  still caps concurrent agent runs.
