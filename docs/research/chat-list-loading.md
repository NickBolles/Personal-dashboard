# Chat-list latency and bounded continuation

## Evidence and root cause

The approved live probes returned HTTP 200 but exceeded Jarvis's shared 8-second upstream budget:

- loopback `/api/sessions?limit=20&offset=0&include_children=true`: 7.101 s;
- loopback, limit 100: 9.419 s;
- configured HTTPS upstream, limit 100: 13.915 s, **100 `data` rows**, `has_more: true`.

These are single observations under shared-host load, not a benchmark distribution or an SLA. The body uses `data`, not `sessions`. No transcript or credentials were captured in this report.

Read-only inspection of the installed `/opt/hermes` source (no Git metadata available) found:

- `gateway/platforms/api_server.py:2905–2957`: DB acquisition followed by `list_sessions_rich(order_by_last_active=True, include_pinned=True)`, shaping the returned rows, then `data/limit/offset/has_more`.
- `hermes_state_sessions.py:1260–1376`: token-count flush; recursive compression-chain CTE and effective-last-active aggregation over admitted sessions **before LIMIT**; full session/system-prompt projection; correlated first-user-message preview selection; a separate pinned back-fill query; Python row/preview/unread shaping. `include_children=true` skips the later compression-tip projection, but **does not bypass the CTE/sort**.
- The API computes `has_more` by counting non-pinned returned rows. A pin inside a full SQL window can therefore under-report continuation. Pinned back-fill can make `data.length` exceed the requested limit.

Thus there are two demonstrated Jarvis defects: an insufficient list budget and an unconditional first-100 cutoff before ownership/hidden/sync/archive filtering. Sparse ownership could look empty despite later matching conversations. Source inspection explains why shrinking the limit cannot remove all latency; it does **not** establish which SQL/operator/lock dominates runtime. No live SQL, migrations, Hermes edits, restarts or deployments were performed.

## Changes

- Updated web/native clients request one 20-row **raw upstream window** per action. The server does not scan until a visible row appears or fetch all history. Empty filtered pages retain continuation. Offset advances by requested SQL limit, not owned rows or back-filled pins.
- Additive `nextOffset: number | null` response; unchanged `sessions` and `unavailable` fields. No-offset requests retain the prior 100-row window for already-installed native clients. Updating the Android app is necessary to browse subsequent pages there.
- Preserve capability checks and per-page ownership/shared-read-only, hidden, sync-source and archive filters. Local conversations are included on the initial page, not repeated on each continuation. Both clients deduplicate IDs.
- List-only timeout is 20 seconds: above the observed 13.915 seconds, below Android's existing 30-second read timeout. Other upstream timeouts remain unchanged. Client cancellation reaches the list request.
- Remove the web's 30-second polling and automatic focus/reconnect reloads. Manual refresh and chat mutation invalidation restart only the first window instead of replaying every loaded page. There are no automatic retry storms; failures have explicit same-offset retry.
- Web retains its in-memory query data on error and labels it stale/incomplete. It no longer reads/writes the unscoped, truncated `sessions:list` IndexedDB snapshot. Native retains a bounded 200-row offline preview with no resumable cursor, visibly labels stale data, and refreshes before continuation. Partial local-only success is visible, retryable and cannot silently replace an already-loaded remote list.

## Upstream limits / follow-up

This is incremental browsing, not a consistent snapshot. Hermes uses mutable offset ordering: concurrent inserts are deduplicated, but deletions/reordering can still move rows behind a consumed offset. Refresh starts over. Exact snapshot completeness requires an upstream stable cursor/snapshot API.

Conservatively continue when `has_more` is true **or** the raw page is full. This avoids a false terminal result caused by pinned rows, at the cost of a possible extra request. With at least a whole page of back-filled pins, Hermes cannot prove exhaustion from this API: continuation may remain offered even after all ordinary rows. Each click remains one bounded request; there is no automatic loop. The API offset ceiling is enforced with an error, never silently declared complete. An upstream `window_returned`/reliable `has_more` is the proper fix.

The inspected API does not forward `include_archived` into `list_sessions_rich`; unpinned upstream-archived rows can remain unavailable even when Jarvis's Show archived filter is enabled. This pre-existing upstream limitation is not repaired by widening timeouts or claiming complete archived coverage. Jarvis still filters correctly for all rows the API returns, including archived pins and local archives.

The 20-row window reduces transferred/shaped recency rows and Jarvis decoration work, and demand loading eliminates repeated background global sorts. It does not bound upstream pin back-fill or eliminate its global ordering/DB acquisition/flush costs. A future Hermes change should provide a lightweight stable cursor list, reliable window metadata, archive selection and separately bounded pins. Profile that upstream read path before promising a specific latency reduction.

## Validation

Focused regression suites cover >100 rows, five empty ownership-filtered pages before an owned row, overlapping pins, under-reported continuation, terminal pages, ownership/archive/sync filters, access denial, offset validation, cancelled requests, legacy/native envelope shape, stale fallback, same-offset retry, and first-window-only refresh. Android API tests cover >100 rows, pin deduplication, sparse pages and legacy response decoding. Clean-checkout CI provides the full TypeScript/build/browser and Android checks; shared-host local validation intentionally avoids full builds, Gradle and Playwright.
