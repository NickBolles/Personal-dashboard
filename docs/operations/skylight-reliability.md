# Skylight sync reliability: operator handoff

## Scope and evidence

This change is **not deployed by opening/merging a PR alone**: the reader must be installed in the Hermes profile serving Jarvis before deploying Jarvis's new prompt. No live credentials or calendar data are used by tests. No Hermes runtime/checkpoint configuration change is included. No production changes were made while developing this patch.

Observed incident: Jarvis's 120-second request deadline issued stop, then deleted its session while a `write_file` call was still unwinding. The local write stall is confirmed; checkpoints are a hypothesis, not proven causality. The reusable reader removes per-sync script creation/auth implementation from the intended path, not all possible model latency.

Inspected Hermes implementation: `gateway/platforms/api_server_runs.py`, `_handle_stop_run` sets `stopping`, requests a hard interrupt, and returns without awaiting executor exit. `_execute_run`'s worker-result path publishes completed/failed after awaiting the worker, but its `CancelledError` path can publish cancelled while the executor thread continues (`_submit_api_worker` documents this explicitly). Therefore:

- Do **not** treat stop's HTTP response as a stop guarantee.
- Poll status for a bounded interval after requesting stop.
- Delete only confirmed `completed` / `failed` sessions (or a session for which start was never attempted).
- Retain `stopping`, unknown/missing status, ambiguous start outcomes, **and cancelled/interrupted sessions**. The API does not expose sufficient per-run worker-exit proof for the latter. This trades orphan retention for avoiding destructive races.
- A normal success/failure uses the existing delete endpoint; a delete response without `deleted:true` is unconfirmed.

**Start-rejection disposition:** Hermes's concurrency limiter rejects before allocating a run (the inspected `_handle_runs` calls `_concurrency_limited_response` before creating `run_id`). That origin-side guarantee is not represented by Jarvis's current transport error contract: `server/http/fetch.ts` collapses 429/503 bodies to a status and truncated untrusted message. A proxy-generated 503 after origin acceptance is indistinguishable at the cleanup boundary. Therefore HTTP status alone does not authorize deletion. The real-client regressions in `test/structured-start-rejection.test.ts` cover both statuses and require retention plus sanitized diagnostics. This intentionally accepts orphan accumulation during capacity/maintenance incidents; investigate retained IDs as below. Automatic cleanup after definitive rejection is deferred until a separately reviewed, validated Hermes admission result (or authoritative session/run reconciliation) can distinguish non-admission from lost acceptance. Do not parse message text or use an elapsed-time threshold as proof.

Jarvis still budgets **120 seconds total**: 110 seconds for create/hide/start/poll, up to 8 seconds for stop + terminal polling, and the remaining budget for safe deletion. Transport aborts and local promise deadlines bound waiting; none prove remote execution stopped. Smaller caller budgets reserve proportionately less time. No blind deadline increase.

Latest bounded failure metadata is stored in `hermes_sync_failure:skylight` (and `:daily_compass` for that existing structured consumer): timestamp, duration, controlled error code/status/cleanup, bounded safe session/run identifiers. One record replaces the previous record. No prompts, output, provider errors, schema values, cookies, credentials, or tokens. Existing validated snapshot data remains separately governed by its ordinary cache. Retained Hermes sessions still contain their normal transcript; do not confuse metadata minimization with deletion of those sessions.

## Install first (approved operator action only)

Requirements: Node >=22 in Hermes's terminal environment; the existing Hermes-owned Skylight credentials; the intended calendar's numeric frame ID configured once as `SKYLIGHT_FRAME_ID`. Select/verify that frame during operator setup, never during each sync. Jarvis requires no Skylight credentials when using Hermes mode.

Use the **serving profile's** actual `HERMES_HOME`, not another profile and not Jarvis's application container. From a reviewed checkout on the Hermes host:

```sh
# Set explicitly to the existing profile directory serving the Jarvis API.
: "${HERMES_HOME:?Set the serving Hermes profile directory first}"
install -d -m 700 "$HERMES_HOME/skills/jarvis-skylight-read/scripts"
install -m 600 hermes/skills/jarvis-skylight-read/SKILL.md "$HERMES_HOME/skills/jarvis-skylight-read/SKILL.md"
install -m 600 hermes/skills/jarvis-skylight-read/scripts/read.mjs "$HERMES_HOME/skills/jarvis-skylight-read/scripts/read.mjs"
node --check "$HERMES_HOME/skills/jarvis-skylight-read/scripts/read.mjs"
```

Keep credentials in that profile's existing protected environment/secret mechanism. Do not put them in Jarvis, CLI arguments, committed env files, PRs, logs, or this runbook. Make any env changes through the normal protected operator workflow and restart only the serving process if required for its environment. Hermes skills/tool availability is session-scoped; verify the installed skill from a fresh session in that profile. Authoritative skill/profile docs: <https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/> and <https://hermes-agent.nousresearch.com/docs/user-guide/profiles>.

The skill declares `SKYLIGHT_USERNAME`, `SKYLIGHT_PASSWORD`, and `SKYLIGHT_FRAME_ID`; the task explicitly loads it before invoking the terminal. Use `SKYLIGHT_USERNAME` in the serving profile (the standalone reader's email alias does not replace the skill prerequisite). Source inspection confirmed `skill_view` registers available declared variables with the session-scoped passthrough registry. An isolated local runtime probe confirmed all three names are accepted; it read/printed no credential values. This is not proof of a deployed profile's secret hydration: verify availability as booleans only in its fresh terminal session after loading the skill. Do not enable blanket `inherit_credentials`, approval bypass, or global environment passthrough. If local approval policy blocks the exact reviewed command, obtain a narrowly scoped operator approval through the normal approval system or leave the integration unavailable; do not auto-approve arbitrary Node commands.

After approval, run a bounded read for explicit current dates in the **serving Hermes environment**, privately inspect the JSON and compare with the same calendar/timezone. Do not save stdout in a public log. Example syntax (dates illustrative):

```sh
node "$HERMES_HOME/skills/jarvis-skylight-read/scripts/read.mjs" 2026-10-10 2026-10-17 America/Chicago
```

Only then deploy Jarvis. The prompt points directly at that installed path; missing helper fails closed without creating files or falling back to authentication discovery. Custom prompt text remains supported but cannot change the helper's bounded parameters or authorize writes.

## Validation gates

1. **Offline fixtures**: `npx vitest run test/skylight-helper.test.ts test/structured-lifecycle.test.ts --maxWorkers=1`; fixture transport only, never real Skylight credentials. Covers date/timezone/schema/card normalization, auth-only POSTs/data-only GETs, redirect boundaries, terminal success/failure, nonterminal stop, ambiguous start and sanitized diagnostics.
2. **Existing integration regression**: `npx vitest run test/integration.test.ts --maxWorkers=1 -t 'Hermes'` exercises Jarvis mock-backed source cards/cache and connection tests. Tests are not a live Skylight check.
3. **Static/CI**: focused ESLint and format check for changed code, `git diff --check`, clean-checkout CI typecheck/test/build/secret scan. Shared-host development intentionally avoids installs, broad suites and builds; the final PR reports exact actual local and CI results separately.
4. **Approved deployment smoke**: privately verify direct helper output, then Jarvis “Test connection” + explicit sync under 120 seconds. Verify event/chores counts and timezone against live read-only source, source freshness, helper command in the run (no write_file/auth discovery), and successful session cleanup. For failure/cancellation, inspect only bounded metadata by default and prove the session is retained while stop is unconfirmed. No live cancellation experiment is part of this PR's offline tests.
5. **Operational retention**: investigate retained IDs through Hermes's authenticated operator tools. Before manual deletion, prove the worker has exited from process/runtime evidence; terminal cancelled alone is insufficient. Do not add a time-only deletion job. A gateway restart/drain may provide that evidence, but must be separately approved. A failed start without run ID requires session-based investigation; never blindly retry destructive cleanup.

## Constraints and rollback

The provider API is unofficial. OAuth PKCE authenticates in memory on each invocation; it uses provider-required `everything` scope, so this is not an upstream read-only permission grant. Fixed endpoints/methods enforce this helper's no-calendar/task-write scope. Broad Hermes tools remain broad; prompt rules alone are not a security sandbox. The helper only emits normalized data, limits responses/rows/redirects/network time, and returns a fixed failure code. Auth/page/schema changes require review and new fixtures, not generated fallback scripts.

Token trade-off: repeated password/PKCE login may create provider-side access/refresh tokens, trigger login notifications, or hit account limits. Tokens are never persisted locally, but dropping them does not revoke them server-side. The existing verified flow does not establish a supported revocation endpoint or expiry policy, so this PR does **not** invent revocation calls, alter sync frequency, or claim revocation. Operator approval of that trade-off plus account-side observation is a rollout gate. If login churn is unacceptable, keep syncing disabled until a separately reviewed Hermes-owned refresh/revocation lifecycle exists. Neither automated tests nor this PR exercised real authentication.

Normalization deliberately accepts null/blank titles as `(untitled)` and omits explicitly undated chores, which do not belong to today's dated-card contract. Missing/malformed dates, oversized text, unsupported timestamps, malformed rows, and pagination/truncation still fail closed; no generic bad-row skipping hides an incomplete calendar. Claims that alternate timestamp precision/offset forms or a device-fingerprint mismatch occur on the live provider remain unverified; do not loosen schema or change the known API version based only on those hypotheses.

Events use from-inclusive/to-exclusive boundaries (max 14 days); chores are exactly the first day, excluding overdue/skipped rows. All-day dates and local timed strings preserve their calendar meaning. No pagination/truncation is silently accepted. A window returning more than the existing contract permits fails rather than silently dropping rows.

Rollback the Jarvis release if needed; keep the reviewed helper installed (it does nothing unless called). Reverting cleanup protection reintroduces the session-delete race, so prefer disabling the Skylight integration temporarily over reverting that protection. Retained sessions require deliberate operator reconciliation; no new auto-pruner is shipped.
