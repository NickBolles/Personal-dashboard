# Queued Hermes runs

Jarvis now preserves an upstream `queued` acceptance in its run ledger and chat
state rather than labeling every accepted request `running`. The normal SSE and
AG-UI paths both carry `run.queued`. The chat shows an explicit waiting message,
keeps Stop available, and retains the submitted text in the same browser's local
KV store for refresh/navigation recovery. A retry of the existing run ID/key
reuses the run; a key belonging to a different user/session is rejected.

This UI does not implement a client-side retry loop and cannot make an unmodified
Hermes server queue work. Deploying the companion Hermes server implementation
is a separate prerequisite, not something this PR performs.

## Server contract and boundaries

The companion implementation ([review PR](https://github.com/NickBolles/hermes-agent/pull/1),
commit `66d86ec976d0ed819a687c2290fa4afb8a97b415`) targets current NousResearch/hermes-agent source at
base `6b21d0564de0492e2ebd0d8f63fca86c03b5c892`. It retains the default 10 concurrent
runs and admits at most 100 waiting requests per API adapter/process. FIFO runs
start as slots become free. Queued cancellation prevents agent construction and
canonical session admission; navigation/SSE disconnect does not cancel work.
Idempotent replays retain the original run ID even under saturation. A full queue
rejects with 429 without accepting the message.

The waiting FIFO/payload is process-local. It does **not** automatically resume
after a gateway restart. With Hermes' durable idempotency store, dead-owner runs
surface as interrupted rather than being silently replayed. Existing Jarvis
missing-run reconciliation also treats unknown active runs as interrupted, not
completed. Browser-local retained text is not cross-device durable storage; the
server retains only the existing bounded input preview in Jarvis' run ledger.

The concurrency budget is per adapter/process, not cluster-wide. Other processes
or external CLI/Desktop work are outside this budget. There is no queue timeout:
a hung worker can keep a slot until it finishes or is interrupted.

## Verification and release gates

- Focused BFF/reducer/normalization/AG-UI tests exercise queued acceptance,
  persisted/replayed status, cross-session key rejection, queued→running,
  reconnect, terminal/cancellation stickiness and the wire round trip.
- `e2e/chat.spec.ts` adds a queued acceptance/reload/message-retention/cancellation
  scenario with a screenshot artifact. This is a UI fixture test, not a live
  provider load test.
- Local Next dev, TypeScript, ESLint and Prettier commands were blocked by the
  host lifecycle scanner (scan budget/large dependency file), so browser/visual,
  typecheck, lint and formatting proof must come from clean-checkout CI. The
  reused sibling node_modules tree supports focused tests only.
- No live endpoint was load-tested, cap changed, service restarted, merge or
  deployment performed. Confirm the serving Hermes revision before rollout;
  `/opt/hermes` is runtime code and was not edited.
