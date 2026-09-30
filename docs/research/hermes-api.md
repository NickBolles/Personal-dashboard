# Hermes Agent HTTP API — research notes for a TypeScript client

**Sources examined (2026-09-30):**

- Docs: `hermes-agent.nousresearch.com/docs/`: `user-guide/features/api-server`, `developer-guide/programmatic-integration`, `user-guide/features/web-dashboard`, `user-guide/features/cron`, `user-guide/features/memory`, `user-guide/features/tools`, `reference/slash-commands`.
- Source: `github.com/NousResearch/hermes-agent` `main` @ **`ddd0cc6944908d2655db2095786ac089a7c3ba0c`** (committed 2026-09-29 23:25 -0500). The latest release tag at that time was **`v2026.9.24`**. `pyproject.toml` says `version = "0.0.0"`; the runtime version is reported by `GET /health` → `version`.
- Key files:
  - `gateway/platforms/api_server.py`: route table (`_http_route_table`), auth, capabilities, sessions, jobs.
  - `gateway/platforms/api_server_runs.py`: `/v1/runs*`.
  - `gateway/platforms/api_server_run_idempotency.py`
  - `gateway/platforms/api_server_openai_routes.py`: chat completions and responses.
  - `cron/jobs.py`: job record shape.
  - `hermes_cli/web_server.py` and `hermes_cli/web_routers/*.py`: the dashboard backend, which is a separate server.

**Legend:** **[SRC]** = verified in source code at the commit above. **[DOC]** = stated in the docs only. **[INF]** = inferred, not directly verified. **[UNKNOWN]** = not found.

> Main differences from what the caller expected:
> 1. **There is no `/archive` endpoint.** To archive, send `PATCH /api/sessions/{id}` with `{"archived": true}`. [SRC]
> 2. **Fork has no fork point.** `POST /api/sessions/{id}/fork` copies the *entire* transcript into a new child session. It also **ends the source session with `end_reason: "branched"`**. It takes no message id or index. [SRC] A rewind or truncate by message is available only on the TUI-gateway JSON-RPC protocol (`prompt.submit` with `truncate_before_row_id`), not over HTTP.
> 3. **`/v1/runs/{id}/events` frames have no `event:` line.** Each frame is `id: <seq>\ndata: {json}\n\n`. The event name is in `data.event`. The session chat stream (`/api/sessions/{id}/chat/stream`) *does* use `event: <name>` lines. [SRC]
> 4. The API server has **no memory endpoints**. `/v1/capabilities` reports `memory_write_api: false`. The dashboard backend (separate server, port 9119) exposes only memory *provider* status and reset. [SRC]

---

## 1. Transport, auth, ports

| Item | Value | Status |
|---|---|---|
| Default bind | `127.0.0.1:8642` (`API_SERVER_HOST`, `API_SERVER_PORT`) | [DOC] |
| Enable | `API_SERVER_ENABLED=true` in `~/.hermes/.env` (or `gateway.api_server.enabled`) and then run `hermes gateway` | [DOC] |
| Auth header | `Authorization: Bearer <API_SERVER_KEY>`. The server checks for a literal `"Bearer "` prefix, which is case-sensitive, then does a constant-time compare. | [SRC] |
| Key requirement | The server **refuses to start** if `API_SERVER_KEY` is missing, a placeholder, or shorter than 16 characters. | [SRC] |
| 401 body | `{"error":{"message":"Invalid gateway API key (API_SERVER_KEY)","type":"gateway_auth_error","code":"gateway_auth_failed"}}` | [SRC] |
| Unauthenticated routes | `GET /health`, `GET /v1/health` | [SRC] |
| Multi-profile | Every route is also mounted at `/p/{profile}/...`. That prefix needs the *profile's own* `API_SERVER_KEY`. Another profile's run id returns 404. | [SRC]/[DOC] |
| Max body | 10 MB (`MAX_REQUEST_BYTES = 10_000_000`) | [SRC] |
| SSE keepalive | A `: keepalive\n\n` comment is sent after 10 s of idle time on every SSE stream. `/v1/runs/{id}/events` also sends `: open\n\n` first and `: stream closed\n\n` at the end. | [SRC] |
| CORS | Off by default. `API_SERVER_CORS_ORIGINS=a,b`. Allowed methods are `GET, POST, DELETE, OPTIONS`, **so PATCH is missing**. Allowed headers are `Authorization, Content-Type, Idempotency-Key, X-Hermes-Session-Id`, **so `X-Hermes-Session-Key` and `Last-Event-ID` are missing**. Conclusion: call the API server-to-server rather than from a browser. | [SRC] |
| Security headers | `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, CSP, and others | [SRC] |

### Optional request headers

| Header | Endpoints | Meaning |
|---|---|---|
| `X-Hermes-Session-Id` | `/v1/chat/completions`, `/v1/responses` | Continues an existing session, loading its history from state.db. The value is echoed back in the response header. Maximum 256 characters. Must not contain `\r`, `\n` or `\0`, and must not be path-unsafe. [SRC] |
| `X-Hermes-Session-Key` | `/v1/chat/completions`, `/v1/responses`, `/v1/runs`, `/api/sessions/{id}/chat[/stream]` | A stable long-term-memory scope (Honcho), separate from the transcript. Maximum 256 characters and no control characters. Echoed back. [SRC]/[DOC] |
| `Idempotency-Key` | `POST /v1/runs` (durable, 24 h). Chat completions and responses also accept it (in-process cache, about 5 min per the docs). | Must be 1–255 visible ASCII characters (0x21–0x7E), otherwise `400 invalid_idempotency_key`. [SRC] |
| `Last-Event-ID` (or `?last_seq=N`) | `GET /v1/runs/{id}/events` | Replays events with a seq greater than N from a backlog of up to 1000 events. [SRC] |

### Error envelope (OpenAI-style) [SRC]

```json
{"error": {"message": "Run not found: run_abc", "type": "invalid_request_error", "param": null, "code": "run_not_found"}}
```

Common errors:

| Status | Code | Condition |
|---|---|---|
| 429 | `rate_limit_exceeded` | Concurrent-run cap reached. `type` is `rate_limit_error`, with `Retry-After: 1` and the message `Too many concurrent runs (max N)`. |
| 503 | `gateway_draining` | Gateway is draining. Sent with `Retry-After: 1`. |
| 503 | `session_db_unavailable` | Session database unavailable. |
| 404 | `session_not_found` | Session does not exist. |

**Exception:** the `/api/jobs*` routes use a **bare** envelope, `{"error": "Job not found"}`, where `error` is a string. [SRC]

---

## 2. `GET /v1/capabilities` [SRC]

Handler: `_handle_capabilities`. Requires auth. Verbatim structure:

```json
{
  "object": "hermes.api_server.capabilities",
  "platform": "hermes-agent",
  "model": "hermes-agent",
  "auth": {"type": "bearer", "required": true},
  "runtime": {
    "mode": "server_agent",
    "tool_execution": "server",
    "split_runtime": false,
    "description": "The API server creates a server-side Hermes AIAgent; tools execute on the API-server host unless a future explicit split-runtime mode is enabled."
  },
  "features": {
    "chat_completions": true,
    "chat_completions_streaming": true,
    "responses_api": true,
    "responses_streaming": true,
    "run_submission": true,
    "runs_idempotency": {"supported": true, "durable": true, "retention_seconds": 86400},
    "run_status": true,
    "run_events_sse": true,
    "run_stop": true,
    "run_steer": true,
    "run_approval_response": true,
    "tool_progress_events": true,
    "approval_events": true,
    "session_resources": true,
    "model_options": true,
    "session_chat": true,
    "session_chat_streaming": true,
    "session_fork": true,
    "session_model_lock": true,
    "reasoning_streaming": true,
    "admin_config_rw": false,
    "jobs_admin": false,
    "memory_write_api": false,
    "skills_api": true,
    "audio_api": false,
    "realtime_voice": false,
    "session_continuity_header": "X-Hermes-Session-Id",
    "session_key_header": "X-Hermes-Session-Key",
    "cors": false,
    "browser_extension_control": {
      "enabled": false,
      "protocol_version": 1,
      "capabilities": ["browser_back", "browser_click", "..."],
      "artifact_capabilities": ["..."],
      "developer_capabilities": ["..."],
      "developer_mode": false,
      "artifact_transport": {
        "upload": {"method": "POST", "path": "/v1/artifacts/upload"},
        "download": {"method": "GET", "path": "/v1/artifacts/download/{artifact_id}"},
        "max_bytes": 0, "ttl_seconds": 0, "allowed_mime_types": ["..."]
      },
      "real_browser_actions": true,
      "transports": {"local_vps": "websocket-subprotocol-ticket", "cloud": "authenticated-gateway-rpc"}
    }
  },
  "endpoints": {
    "health": {"method": "GET", "path": "/health"},
    "health_detailed": {"method": "GET", "path": "/health/detailed"},
    "models": {"method": "GET", "path": "/v1/models"},
    "model_options": {"method": "GET", "path": "/api/model/options"},
    "chat_completions": {"method": "POST", "path": "/v1/chat/completions"},
    "responses": {"method": "POST", "path": "/v1/responses"},
    "runs": {"method": "POST", "path": "/v1/runs"},
    "run_status": {"method": "GET", "path": "/v1/runs/{run_id}"},
    "run_events": {"method": "GET", "path": "/v1/runs/{run_id}/events"},
    "run_approval": {"method": "POST", "path": "/v1/runs/{run_id}/approval"},
    "run_steer": {"method": "POST", "path": "/v1/runs/{run_id}/steer"},
    "run_stop": {"method": "POST", "path": "/v1/runs/{run_id}/stop"},
    "skills": {"method": "GET", "path": "/v1/skills"},
    "toolsets": {"method": "GET", "path": "/v1/toolsets"},
    "sessions": {"method": "GET", "path": "/api/sessions"},
    "session_create": {"method": "POST", "path": "/api/sessions"},
    "session": {"method": "GET", "path": "/api/sessions/{session_id}"},
    "session_update": {"method": "PATCH", "path": "/api/sessions/{session_id}"},
    "session_delete": {"method": "DELETE", "path": "/api/sessions/{session_id}"},
    "session_messages": {"method": "GET", "path": "/api/sessions/{session_id}/messages"},
    "session_fork": {"method": "POST", "path": "/api/sessions/{session_id}/fork"},
    "session_chat": {"method": "POST", "path": "/api/sessions/{session_id}/chat"},
    "session_chat_stream": {"method": "POST", "path": "/api/sessions/{session_id}/chat/stream"},
    "session_model_lock": {"method": "POST", "path": "/api/sessions/{session_id}/model"},
    "browser_control_register": {"method": "POST", "path": "/v1/browser-control/register"},
    "browser_control_ws": {"method": "GET", "path": "/v1/browser-control/ws"},
    "artifact_upload": {"method": "POST", "path": "/v1/artifacts/upload"},
    "artifact_download": {"method": "GET", "path": "/v1/artifacts/download/{artifact_id}"}
  }
}
```

Notes:

- `protocol_version`, `max_bytes`, `ttl_seconds` and the capability lists come from constants that were not expanded here. The values above are placeholders. [INF]
- `jobs_admin: false` is advertised **even though `/api/jobs*` routes exist**. The jobs routes are also **not** listed under `endpoints`. Feature-detect jobs by probing rather than relying on the flag. [SRC]
- The docs show a shorter example with only 7 flags. The source is authoritative.

---

## 3. Health and models

### `GET /health` (no auth) [SRC]

```json
{"status": "ok", "platform": "hermes-agent", "version": "<hermes version string>"}
```

### `GET /health/detailed` (auth) [SRC]

Top-level keys:

- `status`, `readiness` (contains `checks`), `platform`, `version`, `gateway_state`
- `platforms` (object keyed by platform name; `api_server.metrics` included)
- `api_server`, `metrics_today`, `last_heartbeat`
- `active_agents`, `gateway_busy`, `gateway_drainable`
- `exit_reason`, `updated_at` (RFC3339 or null), `pid`

A degraded state still returns HTTP 200.

### `GET /v1/models` (auth) [SRC]

```json
{"object": "list", "data": [
  {"id": "hermes-agent", "object": "model", "created": 1759200000, "owned_by": "hermes", "permission": [], "root": "hermes-agent", "parent": null}
]}
```

Configured `model_routes` aliases are appended with `parent` set to the primary id. The primary id is the profile name, or `hermes-agent` for the default profile.

### `GET /api/model/options[?refresh=1]` (auth) [SRC, partial]

Top level: `{"providers": [ ...provider rows... ], "model": "<current model>", "provider": "<current provider>"}`.

The provider row fields (curated models, pricing, capability hints) were **not fully enumerated** [UNKNOWN]. The payload is the same one the dashboard Models page uses.

---

## 4. Sessions API (`/api/sessions*`) [SRC]

All session routes need Bearer auth.

### Session object: `_session_response`

Only these keys are ever returned, and only when present on the row:

- `id`, `source`, `user_id`, `model`, `title`, `started_at` (unix float), `ended_at`, `end_reason`
- `message_count`, `tool_call_count`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`
- `estimated_cost_usd`, `actual_cost_usd`, `api_call_count`
- `parent_session_id`, `last_active`, `preview`, `_lineage_root_id`
- `pinned`, `archived`, `hidden` (bool)
- `has_system_prompt` and `has_model_config` (bool, always present)

```json
{
  "id": "api_1759200000_a1b2c3d4",
  "source": "api_server",
  "model": null,
  "title": "Dashboard chat",
  "started_at": 1759200000.123,
  "ended_at": null,
  "end_reason": null,
  "message_count": 4,
  "tool_call_count": 1,
  "input_tokens": 1200,
  "output_tokens": 340,
  "cache_read_tokens": 0,
  "cache_write_tokens": 0,
  "reasoning_tokens": 0,
  "estimated_cost_usd": 0.0021,
  "actual_cost_usd": null,
  "api_call_count": 2,
  "parent_session_id": null,
  "last_active": 1759200100.5,
  "preview": "What files changed…",
  "pinned": false,
  "archived": false,
  "hidden": false,
  "has_system_prompt": false,
  "has_model_config": false
}
```

The exact set of keys depends on the SQL row. `list_sessions_rich` adds `last_active` and `preview`, while `get_session` may not. [INF]

### `GET /api/sessions`

Query parameters:

- `limit`: default 50, maximum 200.
- `offset`: default 0.
- `source`: filter by source.
- `include_children`: bool, default false.
- `title`: exact title match.
- `include_hidden`: honored only together with `title`.

Results are ordered by last activity. Pinned sessions are back-filled past the limit.

```json
{"object": "list", "data": [ /* session objects */ ], "limit": 50, "offset": 0, "has_more": false}
```

### `POST /api/sessions` → **201**

Request body (all fields optional):

```json
{"id": "my-session-1", "title": "Dashboard chat", "system_prompt": "You are terse.", "source": "api_server",
 "model": "claude-sonnet-4", "provider": "anthropic", "model_options": {"reasoning_effort": "high"}, "require_model_lock": false}
```

- `id` may also be sent as `session_id`. If omitted, the server generates `api_<unix>_<8hex>`.
- `source` must be one of `api_server`, `hermes_browser`, `browser`, `cli`, `telegram`, `discord`, `slack`, `desktop`, `dashboard`. Any other value is coerced to `api_server`.
- `model` may be `provider:model` prefixed. `model_id` and `provider_id` are accepted as aliases.

Response:

```json
{"object": "hermes.session", "session": { /* session object */ }}
```

Errors:

| Status | Code | Condition |
|---|---|---|
| 409 | `session_exists` | A session with that id already exists. |
| 400 | `invalid_session_id` | Bad or too-long id. |
| 400 | `invalid_title` | The title is already used by another session. |
| 400 | `invalid_system_prompt` | `system_prompt` is not a string. |
| 400 | `missing_model` | `require_model_lock` was set without a model or provider. |

### `GET /api/sessions/{id}`

Returns `{"object": "hermes.session", "session": {...}}`, or 404 `session_not_found`.

### `PATCH /api/sessions/{id}`: rename, archive, pin, and so on

Allowed keys are **only** `title`, `end_reason`, `pinned`, `archived`, `hidden`, `unread`. Any other key returns 400 `unsupported_session_field`. The flags must be JSON booleans, otherwise 400 `invalid_session_field`.

```json
{"title": "Renamed chat"}
{"archived": true}
{"pinned": true, "unread": false}
{"end_reason": "user_closed"}
```

- `title: null` clears the title.
- A duplicate title returns 400 `invalid_title`.
- Setting `pinned` clears `hidden`.
- A truthy `end_reason` ends the session.

Response: `{"object": "hermes.session", "session": {...}}`.

### `DELETE /api/sessions/{id}`

```json
{"object": "hermes.session.deleted", "id": "my-session-1", "deleted": true}
```

Returns 409 `session_active_turn` while a turn holds the write lease.

### `GET /api/sessions/{id}/messages`

Query parameters:

- `limit`: maximum 500. Without it, you get the latest 500.
- `offset`
- `order`: `oldest` or `latest`. Any other value returns 400 `invalid_pagination`.
- `include_compacted`: bool.
- `inline_images`: documented in [DOC] but not seen in the handler at this commit [UNKNOWN].

Behavior:

- The session id is resolved to its live compression tip, and messages span the whole lineage from root to tip.
- Messages are always returned in chronological order.

Message keys (only these):

- `id` (int SQLite row id), `session_id`, `role`, `content`
- `tool_call_id`, `tool_calls`, `tool_name`
- `timestamp` (unix float), `token_count`, `finish_reason`
- `reasoning`, `reasoning_content`, `display_kind`

```json
{
  "object": "list",
  "session_id": "my-session-1",
  "data": [
    {"id": 101, "session_id": "my-session-1", "role": "user", "content": "list files", "timestamp": 1759200001.0},
    {"id": 102, "session_id": "my-session-1", "role": "assistant", "content": "", "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "terminal", "arguments": "{\"command\":\"ls\"}"}}], "timestamp": 1759200002.0, "finish_reason": "tool_calls"},
    {"id": 103, "session_id": "my-session-1", "role": "tool", "content": "README.md\nsrc", "tool_call_id": "call_1", "tool_name": "terminal", "timestamp": 1759200003.0},
    {"id": 104, "session_id": "my-session-1", "role": "assistant", "content": "Two entries.", "timestamp": 1759200004.0, "finish_reason": "stop"}
  ],
  "pagination": {"limit": 500, "offset": 0, "order": "latest", "returned": 4}
}
```

- The `tool_calls` element shape is the stored OpenAI format [INF].
- Compaction handoff rows come back as `display_kind: "hidden"` with `content: ""`.

### `POST /api/sessions/{id}/fork` → **201**

Request body: `{"title": "explore alt path", "id": "optional-new-id"}`. Both fields are optional. The body **must be a JSON object**, so send `{}` at minimum.

Semantics, which match CLI `/branch`:

1. A child session is created with `parent_session_id` set to the source, `model_config._branched_from` set to the source, and the source's model and system prompt copied.
2. **The source session is ended with `end_reason="branched"`.**
3. **All** of the source's messages are copied into the child.
4. The title defaults to the next lineage title (for example "X #2"), or `"<title> fork"`.

**There is no fork-point parameter**, neither message id nor index. [SRC] To fork at a point, the client would have to fork and then… there is no HTTP truncate either [UNKNOWN / not supported over HTTP].

Response: `{"object": "hermes.session", "session": {...child...}}`. A child id that already exists returns 409 `session_exists`.

### `POST /api/sessions/{id}/chat` (synchronous turn)

Request body:

- `message` (or `input`): a string or multimodal content parts (required).
- `system_message` (or `instructions`)
- `model`, `provider`, `model_options`, `require_model_lock`
- `author` (object, memory label only)

```json
{"message": "what files changed in the last hour?", "model": "claude-sonnet-4", "provider": "anthropic"}
```

Response (sets the `X-Hermes-Session-Id` header):

```json
{"object": "hermes.session.chat.completion", "session_id": "my-session-1",
 "message": {"role": "assistant", "content": "Three files changed…"},
 "usage": {"input_tokens": 50, "output_tokens": 200, "total_tokens": 250},
 "runtime": {"provider": "anthropic", "model": "claude-sonnet-4", "route_source": "raw_request", "requested": {"provider": "anthropic", "model": "claude-sonnet-4"}}}
```

- The exact keys of `usage` come from `_run_agent` [INF].
- 400 `missing_message` if there is no visible content.

### `POST /api/sessions/{id}/chat/stream` (SSE; named events)

The request body is the same as for `/chat`. Each frame has this form:

```
event: <name>
data: {json}
```

Every payload is stamped with `session_id`, `run_id` (`run_<32hex>`), `seq` (int, starting at 1) and `ts` (unix float). The event sequence is:

| event | payload fields (besides the stamp) |
|---|---|
| `run.started` | `user_message: {role:"user", content}`, `runtime` |
| `message.started` | `message: {id: "msg_<hex>", role: "assistant"}` |
| `assistant.delta` | `message_id`, `delta` |
| `assistant.commentary` | `message_id`, `text`, `already_streamed` |
| `tool.progress` | `message_id`, `tool_name` (`"_thinking"` for reasoning), `delta` (reasoning text) |
| `tool.started` | `message_id`, `tool_name`, `preview`, `args` |
| `tool.completed` / `tool.failed` | `message_id`, `tool_name`, `preview`, `args` |
| `approval.request` | See §5.6. Resolve via `POST /v1/runs/{run_id}/approval` using this stream's `run_id`. |
| `assistant.completed` | `message_id`, `content` (final text), `completed`, `partial`, `interrupted`, [`turn_exit_reason`], [`pending_steer`], `runtime` |
| `run.completed` / `run.failed` / `run.cancelled` | `message_id`, the same flags, `messages` (this turn's transcript messages), `usage`, `runtime` |
| `error` | `message` (for an exception) |
| `done` | `{}`. Always the last event. |

Other behavior:

- The `run_id` is also pollable at `GET /v1/runs/{run_id}` and can be stopped or steered through `/v1/runs/{run_id}/stop|steer`, because the handler registers run status and ownership. [SRC]
- A client disconnect **interrupts** the turn.

Example transcript (a fixture):

```
event: run.started
data: {"user_message": {"role": "user", "content": "hi"}, "runtime": {"provider": "", "model": "", "route_source": "global"}, "session_id": "s1", "run_id": "run_0f…", "seq": 1, "ts": 1759200000.1}

event: message.started
data: {"message": {"id": "msg_9a…", "role": "assistant"}, "session_id": "s1", "run_id": "run_0f…", "seq": 2, "ts": 1759200000.2}

event: assistant.delta
data: {"message_id": "msg_9a…", "delta": "Hel", "session_id": "s1", "run_id": "run_0f…", "seq": 3, "ts": 1759200000.3}

event: assistant.completed
data: {"session_id": "s1", "message_id": "msg_9a…", "content": "Hello!", "completed": true, "partial": false, "interrupted": false, "runtime": {"provider": "openai", "model": "gpt-5", "route_source": "global"}, "run_id": "run_0f…", "seq": 4, "ts": 1759200001.0}

event: run.completed
data: {"session_id": "s1", "message_id": "msg_9a…", "completed": true, "partial": false, "interrupted": false, "messages": [], "usage": {"input_tokens": 10, "output_tokens": 3, "total_tokens": 13}, "runtime": {"provider": "openai", "model": "gpt-5", "route_source": "global"}, "run_id": "run_0f…", "seq": 5, "ts": 1759200001.0}

event: done
data: {"session_id": "s1", "run_id": "run_0f…", "seq": 6, "ts": 1759200001.0}
```

### `POST /api/sessions/{id}/model` (persist a "browser model lock")

Request body: `{"model": "gpt-5", "provider": "openai", "model_options": {}}`.

Response:

```json
{"object": "hermes.session.model_lock", "session_id": "s1", "runtime": {"provider": "openai", "model": "gpt-5", "route_source": "raw_request", "requested": {"provider": "openai", "model": "gpt-5"}, "model_lock": "accepted"}}
```

---

## 5. Runs API (`/v1/runs*`) [SRC unless noted]

### 5.1 `POST /v1/runs` → **202**

Request body:

| field | type | notes |
|---|---|---|
| `input` | string, or an array of `{role, content}` | **Required.** For an array, the last element's `content` is the user message and earlier elements become history, unless other history is supplied. |
| `session_id` | string | Loads that session's transcript, unless `conversation_history` or `previous_response_id` is given. An id from before compression is resolved to its live tip. When omitted, `session_id` = `run_id`. |
| `instructions` | string | Ephemeral system prompt. |
| `conversation_history` | `[{role, content}]` | Explicit history. Takes precedence over `previous_response_id`. |
| `previous_response_id` | string | Chains from the `/v1/responses` store. |
| `model` | string | Always honored on this endpoint. `hermes-agent`, the virtual name, means the default. Can be a `model_routes` alias. |
| `provider` | string | Conflicting with a route alias returns 400. |
| `model_options` | object | For example `{"reasoning_effort": "high", "service_tier": "priority"}`. Reasoning efforts: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`. |
| `author` | object | Memory attribution label only. |

Headers: `Idempotency-Key` (optional) and `X-Hermes-Session-Key` (optional).

```json
{"input": "Summarize today's cron failures", "session_id": "my-session-1", "model": "claude-sonnet-4", "provider": "anthropic", "model_options": {"reasoning_effort": "medium"}}
```

Response **202**. The docs example omits `replayed`.

```json
{"run_id": "run_3f2a9c0e1b7d4a6f8e5c2b1a0d9f8e7c", "status": "started", "replayed": false}
```

- `run_id` format: `run_` followed by 32 hex characters.
- An idempotent replay returns 202 with header `Idempotency-Replayed: true` and a body like `{"run_id": "<original>", "status": "<current status>", "replayed": true}`.
- The same key with a different payload returns **409** `idempotency_key_conflict`.
- Other errors:
  - 400 `Missing 'input' field` or `No user message found in input` (no `code`).
  - 429 when the concurrency cap is reached.
  - 503 while the gateway is draining.

### 5.2 `GET /v1/runs/{run_id}` (poll)

```json
{
  "object": "hermes.run",
  "run_id": "run_3f2a…",
  "status": "completed",
  "created_at": 1759200000.0,
  "updated_at": 1759200012.3,
  "session_id": "my-session-1",
  "model": "claude-sonnet-4",
  "last_event": "run.completed",
  "completed": true,
  "partial": false,
  "interrupted": false,
  "output": "Done.",
  "usage": {"input_tokens": 50, "output_tokens": 200, "total_tokens": 250, "cache_read_tokens": 40, "cache_write_tokens": 0},
  "runtime": {"provider": "anthropic", "model": "claude-sonnet-4", "route_source": "raw_request", "requested": {"provider": "anthropic", "model": "claude-sonnet-4"}}
}
```

**Statuses:** `queued` → `running` ⇄ `waiting_for_approval` → `stopping` → terminal. The terminal states are `completed`, `failed`, `cancelled` and `interrupted`.

Other fields that may appear:

- `error` (failed or interrupted)
- `turn_exit_reason`
- `pending_steer`
- `approval`: the pending approval event, present only while `waiting_for_approval`
- `shutdown_requested_at`: unix seconds, set while the gateway drains
- `delivery_id`

Terminal status records are kept for 1 h in memory, and for 24 h in the durable idempotency store when the run was created with an `Idempotency-Key`. Unknown or foreign runs return 404 `run_not_found`.

### 5.3 `GET /v1/runs/{run_id}/events` (SSE)

Wire format:

```
: open

id: 0
data: {"event":"message.delta","run_id":"run_3f2a…","timestamp":1759200001.2,"delta":"Hel","seq":0}

id: 1
data: {"event":"tool.started","run_id":"run_3f2a…","timestamp":1759200001.9,"tool":"terminal","preview":"ls -la","seq":1}

: keepalive

: stream closed
```

- **No `event:` line.** Dispatch on `data.event`. `seq` starts at **0** and equals the SSE `id`.
- Every payload has `event`, `run_id`, `timestamp` and `seq`.
- If you subscribe within about 1 s of creation and the stream is not registered yet, the server polls 20 × 50 ms before returning 404.
- Resume with `Last-Event-ID: <seq>` or `?last_seq=<seq>`.
- If the backlog (1000 events) was truncated, the server first sends `{"event":"replay.truncated","run_id":…,"timestamp":…,"oldest_retained_seq":N,"requested_seq":M}`. This frame has **no `id` and no `seq`**.
- A slow subscriber whose queue exceeds 256 events plus the replay is disconnected.
- Unconsumed buffers expire after 300 s.

Event catalog:

| `event` | extra fields | notes |
|---|---|---|
| `message.delta` | `delta` | Token text. |
| `message.interim` | `text`, `already_streamed` | Mid-turn commentary. Skip it if `already_streamed` is true and you render deltas. |
| `reasoning.available` | `text` | Reasoning text. |
| `tool.started` | `tool`, `preview` | `preview` is an argument preview. |
| `tool.completed` | `tool`, `duration` (seconds, 3 decimal places), `error` (bool), `preview` | `preview` is the result, secret-redacted, at most 500 characters. A denied approval shows a `BLOCKED: …` preview. |
| `subagent.start` / `subagent.complete` | Any of `goal`, `task_count`, `task_index`, `subagent_id`, `child_session_id`, `delegation_id`, `parent_id`, `depth`, `model`, `tool_count`, `status`, `summary`, `duration_seconds`, `input_tokens`, `output_tokens`, `reasoning_tokens`, `api_calls`, `cost_usd`, `files_read`, `files_written`, `output_tail`, plus optional `preview` | Only non-null keys are sent. |
| `approval.request` | See §5.6 | The run status becomes `waiting_for_approval`. |
| `approval.responded` | `choice`, [`request_id`], `resolved` (int count) | Emitted after `POST …/approval`. |
| `run.steered` | `accepted: true` | Emitted after `POST …/steer`. It means the text was queued, not yet consumed. |
| `run.completed` | `completed:true`, `partial:false`, `interrupted:false`, [`pending_steer`], `output`, `usage`, `runtime` | Final answer. It is **only** in `output` here, not repeated as a delta. |
| `run.failed` | `completed:false`, `partial`, `interrupted:false`, [`turn_exit_reason`], [`pending_steer`], `error` | Or just `error` for exceptions. |
| `run.cancelled` | `completed:false`, `partial`, `interrupted:true`, [`turn_exit_reason`], [`pending_steer`] | May have no fields at all when the task was cancelled before a result. |
| `run.interrupted` | `error: "Gateway shutdown interrupted the run."` | Sent when the gateway shuts down. |

- There is **no `run.started` event** on this stream at this commit. [SRC] The status moves to `running` silently.
- `subagent.tool`, subagent progress and `_thinking` tool events are intentionally dropped.
- For `turn_exit_reason`, the docs give these examples: `interrupted_by_user`, `interrupted_by_system(<issuer>)`, `interrupted_during_api_call(<issuer>)`, `max_iterations_reached(60/60)`. [DOC]

### 5.4 `POST /v1/runs/{run_id}/stop`

Request body: none.

- **200** `{"run_id": "run_…", "status": "stopping"}`.
- If the run is already terminal, the server returns **200** with the full status object instead.
- 409 `run_not_active` means the run is not active in this process.
- 404 `run_not_found`.

The run settles as `cancelled`, with the event `run.cancelled`.

### 5.5 `POST /v1/runs/{run_id}/steer`

Request body: `{"input": "focus on the auth module"}`. The text may also be sent as `message` or `text`.

- **200** `{"object": "hermes.run.steer", "run_id": "run_…", "accepted": true}`.
- Accepted **only while `status == "running"`**. Otherwise the server returns **409** `run_not_accepting_steer`; this includes `waiting_for_approval`.
- Other errors:
  - 400 `invalid_steer_input` (empty text).
  - 409 `steer_not_accepted`.
  - 500 `steer_failed`.
- Steer text that was never delivered comes back as `pending_steer` on the terminal event and status.

### 5.6 Approvals

Example `approval.request` payload. It is the same on the runs SSE stream, the session chat stream (with an added `message_id`), and chat completions (as `event: approval.request`).

```json
{
  "event": "approval.request",
  "run_id": "run_3f2a…",
  "timestamp": 1759200003.4,
  "command": "rm -rf build",
  "pattern_key": "rm_recursive",
  "pattern_keys": ["rm_recursive"],
  "description": "Recursive delete",
  "allow_permanent": true,
  "allow_session": true,
  "request_id": "4b7e0c1d2a3f4e5d6c7b8a9f0e1d2c3b",
  "choices": ["once", "session", "always", "deny"],
  "seq": 7
}
```

- `choices` is `["once","deny"]` when the request was smart-denied (`smart_denied: true` is present) or when `allow_session` is false. It is `["once","session","deny"]` when `allow_permanent` is false.
- `command` and `description` are redacted.
- `request_id` is a uuid4 hex. [SRC: `tools/approval_gateway_wait.py`]
- `pattern_key` values are illustrative. [INF]

**`POST /v1/runs/{run_id}/approval`** request body:

```json
{"choice": "once", "request_id": "4b7e0c1d2a3f4e5d6c7b8a9f0e1d2c3b"}
```

- `choice` must be one of `once`, `session`, `always`, `deny`. The aliases `approve`, `approved` and `allow` map to `once`.
- `request_id` is optional; without it the oldest pending request (FIFO) is resolved.
- `"all": true` (or `resolve_all`) resolves every pending request.

Response **200**:

```json
{"object": "hermes.run.approval_response", "run_id": "run_3f2a…", "choice": "once", "request_id": "4b7e…", "resolved": 1}
```

Errors:

| Status | Code | Condition |
|---|---|---|
| 400 | `invalid_approval_choice` | `choice` is not one of the allowed values. |
| 400 | `invalid_approval_request` | Bad `request_id` (empty or longer than 256 characters). |
| 409 | `approval_not_active` | The run has no approval session. |
| 409 | `approval_not_pending` | Nothing is waiting. |

---

## 6. Skills and toolsets [SRC]

### `GET /v1/skills`

This is a list wrapper, **not a bare array as the docs example shows**.

```json
{"object": "list", "data": [
  {"name": "github-pr-workflow", "description": "Open and iterate on PRs", "category": "github"}
]}
```

Items are sorted by `(category, name)`. `category` can be null.

### `GET /v1/toolsets`

```json
{"object": "list", "platform": "api_server", "data": [
  {"name": "web", "label": "Web Search", "description": "…", "enabled": true, "configured": true, "tools": ["web_extract", "web_search"]}
]}
```

---

## 7. Jobs / cron (`/api/jobs*`) [SRC]

All jobs routes need Bearer auth. If the cron module is missing, they return 501 `{"error":"Cron module not available"}`. `job_id` must match `^[a-f0-9]{12}$`, otherwise 400 `{"error":"Invalid job ID format"}`.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/jobs?include_disabled=true` | – | `{"jobs": [job…]}` (each has `latest_execution`) |
| POST | `/api/jobs` | `{name*, schedule*, prompt, deliver="local", skills?, repeat?, paused?, paused_reason?}` | `{"job": job}` (**200**, not 201). Validation errors return 400 `{"error": "…"}`. Scheduler registration failure returns 424. |
| GET | `/api/jobs/{id}` | – | `{"job": job}`, or 404 `{"error":"Job not found"}` |
| PATCH | `/api/jobs/{id}` | Only `name`, `schedule`, `prompt`, `deliver`, `skills`, `skill`, `repeat`, `enabled` | `{"job": job}`, or 400 `No valid fields to update` |
| DELETE | `/api/jobs/{id}` | – | `{"ok": true}` |
| POST | `/api/jobs/{id}/pause` | – | `{"job": job}` |
| POST | `/api/jobs/{id}/resume` | – | `{"job": job}` |
| POST | `/api/jobs/{id}/run` | optional `{"prompt": "extra context"}` | `{"job": job}` (triggered) |

Field limits: `name` at most 200 characters, `prompt` at most 5000 characters and scanned for injection, `repeat` a positive integer.

`schedule` accepts these forms:

- `"30m"` or `"every 30m"`, parsed as an interval.
- `"every monday 9am"` or `"0 9 * * *"`, parsed as cron.
- An ISO timestamp or `"in 2h"`-style duration, parsed as one-shot.

Job record, from `cron/jobs.py::create_job`:

```json
{
  "id": "a1b2c3d4e5f6",
  "name": "Morning brief",
  "prompt": "Summarize my inbox",
  "skills": [],
  "skill": null,
  "model": null,
  "provider": null,
  "base_url": null,
  "script": null,
  "no_agent": false,
  "monitor_script": null,
  "monitor_url": null,
  "monitor_state": null,
  "context_from": null,
  "schedule": {"kind": "cron", "expr": "0 9 * * *", "display": "0 9 * * *"},
  "schedule_display": "0 9 * * *",
  "repeat": {"times": null, "completed": 0},
  "enabled": true,
  "state": "scheduled",
  "paused_at": null,
  "paused_reason": null,
  "created_at": "2026-09-30T09:00:00-05:00",
  "next_run_at": "2026-10-01T09:00:00-05:00",
  "last_run_at": null,
  "last_status": null,
  "last_error": null,
  "last_delivery_error": null,
  "last_delivery_unverified": null,
  "failure_streak": 0,
  "deliver": "local",
  "origin": null,
  "enabled_toolsets": null,
  "workdir": null
}
```

Notes on the job record:

- The other `schedule.kind` shapes are `{"kind":"interval","minutes":30,"display":"every 30m"}` and `{"kind":"once","run_at":"<iso>","display":"once at …"}`.
- These optional keys appear only when set: `attach_to_session`, `reasoning_effort`, `failure_deliver`, `interpreter`.
- `list_jobs` adds `latest_execution`, whose shape is [UNKNOWN].
- The value types of `origin` and `enabled_toolsets` are [INF].

The dashboard backend has a parallel `/api/cron/jobs*` family (see §9) with slightly different verbs: `trigger` instead of `run`, and `PUT` for edits.

---

## 8. Memory

- **API server (8642): no memory endpoints.** `memory_write_api: false`. [SRC]
- Built-in memory is two files: `~/.hermes/memories/MEMORY.md` (2,200 character limit) and `USER.md` (1,375 character limit). The agent edits them through the `memory` tool. [DOC]
- Long-term memory scoping for external providers such as Honcho works through the `X-Hermes-Session-Key` header. [DOC]/[SRC]
- Dashboard backend (9119) [SRC, `hermes_cli/web_routers/ops.py`]:

| Route | Returns / body |
|---|---|
| `GET /api/memory` | `{"active": "<provider or ''>", "providers": [...], "builtin_files": {"memory": <bytes>, "user": <bytes>}}`. File **sizes only, not contents**. |
| `PUT /api/memory/provider` | Body `{"provider": "honcho"}`. Returns `{"ok": true, "active": "honcho"}`. |
| `POST /api/memory/reset` | Body `{"target": "all" \| "memory" \| "user"}`. Returns `{"ok": true, "deleted": ["MEMORY.md"]}`. |
| `GET /api/memory/providers/{name}/config`, `POST …/setup`, `PUT …/config` | Provider configuration. |

- There is no HTTP endpoint that reads memory *contents*. [UNKNOWN / not found]

---

## 9. Dashboard backend (separate server): brief

- Started with `hermes dashboard`. Default `http://127.0.0.1:9119`. FastAPI. [DOC]/[SRC]
- Auth on loopback: header `X-Hermes-Session-Token: <token>`, or legacy `Authorization: Bearer <token>`.
  - The token is `HERMES_DASHBOARD_SESSION_TOKEN` if that env var is set.
  - Otherwise it is random for each server start and injected into the SPA HTML.
  - To use it from another app, set `HERMES_DASHBOARD_SESSION_TOKEN` yourself. [SRC `hermes_cli/web_server.py`]
- Auth on a non-loopback bind: a cookie-based auth gate (username/password, Nous OAuth, or OIDC).
- `GET /api/status` is public.
- Documented route families [DOC]:
  - `/api/sessions` (+ `/search?q=`, `/stats`, `/{id}/export`, `PATCH /{id}` for rename or archive, `/prune`)
  - `/api/config`, `/api/env`, `/api/logs`, `/api/analytics/usage?days=30`
  - `/api/cron/jobs` (`POST`, `PUT /{id}`, `/{id}/pause|resume|trigger`, `DELETE`)
  - `/api/skills` (+ `PUT /api/skills/toggle` `{name, enabled}`), `/api/tools/toolsets`
  - `/api/model/options`, `/api/mcp/*`, `/api/memory*`, `/api/pty` (WebSocket), `/api/ws`
- Most routes accept `?profile=<name>`.
- Response shapes for the dashboard routes were **not verified** in this pass [UNKNOWN], except the memory routes above. Prefer the API server (8642) for the client.

---

## 10. OpenAI-compatible fallback

### `POST /v1/chat/completions` [DOC + SRC]

Request:

```json
{"model": "hermes-agent", "messages": [{"role": "system", "content": "Be terse."}, {"role": "user", "content": "Hello!"}], "stream": false}
```

Response:

```json
{"id": "chatcmpl-abc123", "object": "chat.completion", "created": 1710000000, "model": "hermes-agent",
 "choices": [{"index": 0, "message": {"role": "assistant", "content": "Hi!", "reasoning_content": null}, "finish_reason": "stop"}],
 "usage": {"prompt_tokens": 50, "completion_tokens": 200, "total_tokens": 250}}
```

- `reasoning_content` is present only when the model reasoned [DOC]. The response also carries a `runtime` object [DOC].
- The call is stateless unless you send `X-Hermes-Session-Id`. The response header echoes that id, or the one the server generated.
- A bare `model` without `provider` is **ignored** unless `gateway.platforms.api_server.direct_model_requests: true`.
- Images: send `image_url` parts, as http(s) or `data:image/...` URLs. Files are rejected with 400 `unsupported_content_type`.

Streaming (`"stream": true`):

- Standard unnamed `chat.completion.chunk` frames, plus `delta.reasoning_content` chunks.
- Named events:
  - `event: hermes.tool.progress` with data `{"tool": "terminal", "emoji": "💻", "label": "ls -la", "toolCallId": "call_1", "status": "running"}`. It can be disabled with `tool_progress_events: false`.
  - `event: hermes.status`, whose shape is [UNKNOWN].
  - `event: approval.request`, shaped as in §5.6.
- The stream ends with `data: [DONE]` [INF, standard OpenAI].

### `POST /v1/responses` [DOC]

Request body fields: `input` (string or items), `instructions`, `store`, `previous_response_id`, `conversation` (a named chain), `stream`, `model`, `provider`, `model_options`.

Output items are `function_call`, `function_call_output` and `message`. Tools have *already run* on the server (`status: "completed"`).

SSE uses the OpenAI Responses event names:

- `response.created`
- `response.output_item.added` / `.done`
- `response.output_text.delta`
- `response.reasoning_summary_*`
- `response.completed`

Also: `GET /v1/responses/{id}`, `DELETE /v1/responses/{id}`. Up to 100 stored responses are kept, with LRU eviction, in SQLite.

```json
{"id": "resp_abc123", "object": "response", "status": "completed", "model": "hermes-agent",
 "output": [
   {"type": "function_call", "status": "completed", "name": "terminal", "arguments": "{\"command\": \"ls\"}", "call_id": "call_1"},
   {"type": "function_call_output", "status": "completed", "call_id": "call_1", "output": "README.md src/ tests/"},
   {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Your project has…"}]}],
 "usage": {"input_tokens": 50, "output_tokens": 200, "total_tokens": 250}}
```

---

## 11. Other routes present (not needed for the dashboard) [SRC]

| Route | Auth |
|---|---|
| `POST /v1/browser-control/register` | – |
| `GET /v1/browser-control/ws` | WebSocket subprotocol ticket |
| `POST /v1/artifacts/upload`, `GET /v1/artifacts/download/{artifact_id}` | – |
| `POST /api/platforms/{platform}/events` | Platform verifier, not the API key |
| `/v1/room-members/{invitations,capabilities,grants/refresh,grants/revoke}` | `Authorization: HermesRoom <grant>` scheme |
| `POST /api/cron/fire` | Chronos JWT |

---

## 12. Recommendations for the TS client

1. Detect features from `GET /v1/capabilities` (`features.*`, `endpoints.*`), but probe `/api/jobs`, because `jobs_admin` reads `false` even though the jobs routes exist.
2. Preferred chat flow: `POST /api/sessions` → `POST /v1/runs {session_id, input}` with an `Idempotency-Key` → `GET /v1/runs/{id}/events`, parsing `data.event` and tracking `seq` for `Last-Event-ID` reconnects → reconcile with `GET /v1/runs/{id}` and `GET /api/sessions/{id}/messages`.
   - The alternative is `POST /api/sessions/{id}/chat/stream`, which has named events and a `run_id` usable with `/v1/runs/{id}/stop|steer|approval`. Closing the connection interrupts the turn.
3. The SSE parser must ignore comment lines (`:`) and must handle frames both with and without an `event:` line.
4. Treat `run.completed` / `run.failed` / `run.cancelled` / `run.interrupted` as terminal. Show `pending_steer` if present.
5. Archive with `PATCH {archived:true}`. Fork always copies the full session and ends the source, so warn users about this.
6. Call the API server from the Next.js server, not the browser: CORS lacks PATCH and `X-Hermes-Session-Key`, and the key must stay secret.
