# Areas (Work hub)

> **Phase 4 renamed Work to Areas** and merged chat into it: one tree for work _and_ conversations. `/work` URLs redirect to `/areas` (the API stays at `/api/work/*`). See [Areas (phase 4)](#areas-phase-4) below; the rest of this page still applies to every node in the tree.

A private place to organize AI-assisted work: where a conversation belongs, what was handed off, which PR implements it, and whether the outcome was actually achieved. Background: the conversation-platform PRD (P0 tree/lifecycle/handoff/validation, P1 timeline and dashboard, P2 map). Single owner per row, no AI calls, GitHub read-only. Phase 1 was the vertical slice; phase 2 added conversation filing, handoff into a new conversation, automatic PR/issue refresh, drag-and-drop, undo, timeline editing and dependencies, validation templates, the map, Home cards and dashboard upgrades. Phase 3 applied the owner's decisions: `/work` opens on **Today**, an **Inbox** in the left rail, **no automatic settlement**, a per-area validation default, GitHub connections (one read-only token per owner) with a scheduled poll and read-only webhooks, the Command Center look and the **command dock**.

Access: capability `work.use` (adults by default; admins have everything). Pages call `requirePage("work.use")`, every route passes `cap: "work.use"`, and every query is scoped to the signed-in person: other people's rows are "not found". Anything that touches conversations also needs `hermes.chat` (checked in the server, hidden in the UI).

## Model (`server/db/schema.ts`)

| Table                             | What                                                                                                                                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `work_items`                      | Tree node. `parent_id` null = top-level **Area**; kinds `area · project · thread · investigation · note`. Title, summary, next action, status, order, planned start/target, settlement fields, archived. (0008)                       |
| `work_links`                      | `chat_session` (Hermes or Claude-direct id, opens `/chat/<id>`), `github_pr`, `github_issue`, `url`; role `source · implementation · evidence · reference`; `external_state` `open · merged · closed`. (0008)                         |
|                                   | + `lineage` (`handoff_from` for conversations started from a handoff) and `packet_id` (0009); `checked_at` / `check_error` of the last GitHub readback (0010).                                                                        |
| `work_lineage`                    | Append-only `forked_from · split_from · moved_from · handoff_from` edges (moves record from/to parent).                                                                                                                               |
| `work_packets`                    | Immutable, versioned handoff snapshots (objective, scope, acceptance criteria, decisions, open questions, context, validation required or a reason it isn't).                                                                         |
| `work_validations`                | Metric, comparator (`<= >= < > =`), threshold, unit, baseline, observed, evidence link/notes, status `pending · pass · fail · waived`, waiver reason, due date.                                                                       |
| `work_events`                     | Append-only activity: status transitions (from → to, reason, actor, time), merges, links, packets, validations, date changes, dependencies, undo. `source` (0010) is `github` for changes read from GitHub, `manual` for marked ones. |
| `work_ops`                        | Undoable structural operations (move, reorder, archive/unarchive, split, fork) with what undo needs; `undone_at`. (0011)                                                                                                              |
| `work_dependencies`               | "item depends on item" (blocked-by), unique per pair, cascade-deleted with either item. (0012)                                                                                                                                        |
| `work_validation_templates`       | Per-person reusable validation contracts: name, metric, comparator, threshold, unit, due offset days. Nothing is seeded. (0013)                                                                                                       |
| `dashboards`, `dashboard_widgets` | One dashboard per person; ordered widgets with kind, title, size (`sm · md · lg`) and JSON config.                                                                                                                                    |
|                                   | `work_items.validation_default` (0014): areas only, `required · optional`, null = by rule (below).                                                                                                                                    |
| `github_connections`              | One read-only GitHub token per owner (user/org): label, owner, AES-256-GCM token, last 4, repo allowlist, the Jarvis person whose inbox gets its assigned issues, login and last Test result. (0015)                                  |
| `work_inbox`                      | Assigned GitHub issues (deduped by issue node id), quick captures, and dismissed unfiled conversations (id only). Accepted/dismissed are remembered. (0015)                                                                           |
| `work_github_deliveries`          | `X-GitHub-Delivery` ids the webhook already handled (dedupe; pruned after 7 days). (0015)                                                                                                                                             |
| `github_apps`                     | The read-only GitHub App (at most one): App id, slug, owner, client id; client secret, private key and webhook secret AES-256-GCM encrypted, never returned. (0016)                                                                   |
| `github_app_installations`        | Its installations: account, type, repository selection, repos (as last read), suspended. Allowed/flagged is computed from the allowlist on read. (0016)                                                                               |
| `github_app_states`               | One-time manifest-flow states (sha256 only), bound to the admin and session, 10-minute TTL. (0016)                                                                                                                                    |
|                                   | `work_links.checks_state` / `checks_at` (0016): combined CI state of a PR's head commit (`success · failure · pending`).                                                                                                              |

A built-in **Miscellaneous** area is created lazily per person (`system_key = "misc"`); non-area items created without a parent land there. It can't be archived or moved and always stays last among areas.

| Phase 4 (0017)                                  | What                                                                                                                                                                             |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `work_items.kind = conversation` + `session_id` | A conversation node: a Hermes or Claude-direct session placed in the tree (unique per owner and session). Hermes owns the content; Jarvis owns placement, lineage and lifecycle. |
| `work_items.settings`                           | Areas only: JSON `AreaSettings` (agent mode, instructions, default backend/model/provider, default repo, context sources, settle policy, quiet days).                            |

## Tree operations

- Create child, rename / edit summary, next action and dates, reorder (up/down among siblings), archive/unarchive (archiving hides the whole branch unless "Show archived").
- **Move**: any item under any other item you own; only areas may sit at the top. Cycles are refused (`wouldCreateCycle`). Records `moved_from` lineage. Moving never touches history.
- **Drag and drop** (`WorkTree`, pointer events: mouse, pen and touch): each row has a grip. Drop on the top or bottom quarter of a row to place before/after it (reorder or re-parent to that row's parent), on the middle to put it inside. Esc cancels; drops into the item's own subtree, notes, or non-areas at the top level are refused. `POST /api/work/items/:id/place {parentId, index}` re-checks everything (`planPlacement`, cycle-safe) and records `moved_from` when the parent changes. The keyboard equivalents stay: the item menu's **Move up**, **Move down** and **Move…**.
- **Fork**: a new sibling copying title/summary/next action and `source` links, with `forked_from`. Chat links are not copied: a fork is a new task and starts without a chat (the source keeps its own). To branch the conversation itself, fork it from the task's Chat tab.
- **Split**: a new child from a title + summary excerpt, `split_from`; the source is untouched.

### Undo (`server/work/undo-rules.ts`, pure and unit tested)

Move, reorder (buttons or drag), archive/unarchive and split/fork creation write a `work_ops` row and return `op`; the UI shows "Moved · Undo" for about 10 seconds. `POST /api/work/ops/:id/undo` checks (`undoCheck`) that the operation is the **latest** structural operation on that item, not already undone, and at most 10 minutes old (the server window is longer than the toast for slow networks); otherwise 409 with the reason.

- Move/reorder: back to the previous parent (recording a `moved_from` edge with note "Undo") and the previous sibling order.
- Archive/unarchive: flips it back.
- Split/fork: deletes the new item **only if untouched** (`isUntouched`: no edits, no events beyond its creation, no children, packets, validations, dependencies, items derived from it, or links beyond those copied by the fork); its creation lineage edge goes with it. Otherwise the item is archived instead, so nothing is lost.
- Every undo writes a `work_events` row (`undo`) and an audit entry (`work.undo`).

## Conversations

- **Linking** uses a searchable picker of your conversations (Hermes and Claude-direct, from `server/assistant` `listSessions`; never `integrations/hermes` from routes): `GET /api/work/conversations?q=`. A pasted `/chat` link is still accepted as a fallback. The same conversation can't be linked twice to one item. The item shows each linked conversation's title, last activity and an Open link.
- **Unfiled conversations** (panel on `/work`, and a dashboard widget): your recent, unarchived, own conversations that aren't linked to any of your work items (`GET /api/work/conversations/unfiled`, newest 20 plus the total). Each offers **File under <suggestion>**, **File under…** (destination picker) and **File in Miscellaneous** (`POST /api/work/conversations/file`, a `source` link). Suggestions are deterministic (`suggestFiling`): items whose title shares exact significant words with the conversation title (3+ letters, or short words with a digit like "v5"; stop words dropped), most shared words first, then the more specific title, then path. Closed items and Miscellaneous are never suggested. No model is called.
- If Hermes doesn't answer, the lists say so ("Hermes didn't answer") instead of looking empty.

### Continue in chat (handoff)

On a task, **Continue in chat** (the packet card, the page's primary action while a packet is ready, the ⋯ menu, `/handoff`, `?do=continue`) opens the task's own Chat tab with the handoff Markdown as a draft in its composer: **nothing is created or sent until the person presses Send**. A task that has no chat yet gets one with that first message (`POST /api/work/items/:id/chat {handoff: true}`), and the handoff is recorded on the task with it: a `source` link with `lineage = handoff_from` and the latest packet's id, and an event ("Continued in a new conversation (handoff from packet vN)"). A task that already has its chat records "Continued in its chat (…)" and makes no second one. The log lists these handoffs.

Areas and projects keep the dialog for now (**Continue in new conversation**, with the Hermes/Claude choice): `POST /api/work/items/:id/continue {backend}` starts a conversation filed under the node, on the profile that answers for it, with the handoff as its draft.

## Lifecycle (`server/work/lifecycle.ts`, pure and unit tested)

Statuses: `captured, exploring, ready, in_progress, in_review, awaiting_validation, settled, reopened, on_hold, superseded, abandoned`.

- `ready` and `in_progress` require a non-empty next action.
- **Start focused work** writes packet v(n+1) and moves the item to `ready` or `in_progress` (setting the start date if empty). Packets are never edited; "New revision" makes the next version. "Copy handoff" produces Markdown (objective, state, decisions, open questions, next action, validations, links) for Hermes/Discord.
- **PR merged** (a linked `github_pr` with role `implementation` whose state becomes `merged`, manually, via refresh, the poller or a webhook), `onImplementationMerged`:
  - the latest packet requires validation (**default when there is no packet**), or any validation is `pending` or `fail` → `awaiting_validation`;
  - otherwise → **`ready_to_settle`** ("Ready to settle"), and the item shows a **"PR merged — settle?"** prompt with **Settle now**. Today lists these too.
  - **Auto-settle: only where an area opted in** (phase 4 owner decision; phase 3 had removed it entirely). By default settling is the person's action (`settled_kind = manual`); an area with settle policy `auto_after_quiet` settles merged, passing, quiet work itself (`settled_kind = auto`, always undoable for 7 days — see [Settle policy](#settle-policy)). Auto-settled rows show an **Auto-settled** badge. We chose a dedicated status over "`in_review` + a prompt" because it is explicit in lanes, filters, Today and the KPI strip, and it is a normal open status (settle, reopen or move it like any other).
  - Closed items (settled/superseded/abandoned) are left alone; reference PRs never change state. A merged PR is final: a later (stale) GitHub readback never un-merges it, and a readback that finds the link changed meanwhile (webhook or manual mark) keeps the newer state.
- **Validation**: recording an observed value computes pass/fail with the comparator (`=` uses a tiny relative tolerance). A waiver needs a reason.
- **Settle** (`settleGate`): every validation is `pass` or `waived`, and if the latest packet requires validation there must be at least one. Failing validations offer "Reopen with failed evidence".
- **Reopen** needs a reason, clears settlement, and can create a follow-up child (`handoff_from`). Always available on settled work.
- Every status change writes a `work_events` row and an audit entry (`work.status`); other mutations audit as `work.*`.

Stricter than the brief, deliberately: a _failed_ validation also keeps merged work in `awaiting_validation`, and a packet that requires validation can't be settled with zero validations (otherwise "all validations pass" would be vacuously true).

### Validation default per area

New packets default `validation_required` from the item's **area** (`areaValidationDefault`, pure): the area's own `validation_default` if set; otherwise **Miscellaneous** and an area titled (or keyed) **Home** are `optional`, every other area `required`. Edit it in the area's Details ("Validation for new packets"). The packet form preselects it for the first packet (revisions keep the previous packet's choice) and pre-fills "Validation is optional in <area>" as the reason; you can always override. A packet posted without `validationRequired` gets the area default (reason "Validation is optional in <area> (area default)").

### Validation templates and overdue

- Templates are per person (`GET/POST /api/work/validation-templates`, `DELETE …/:id`): metric, comparator, threshold, unit and an optional due offset in days. **Add from template** (`POST /api/work/items/:id/validations/from-template`) adds a pending validation via `applyTemplate` (due date = today + offset). "Also save as a reusable template" on the add form stores the due date as an offset from today. Nothing is seeded.
- A validation is **overdue** (`isValidationOverdue`) when it's `pending` and its due date is before today. It's highlighted on the item (badge, red border, a banner and a "Validation overdue" chip in the header), marked with "!" on the timeline, counted by the **Validation overdue** dashboard widget, and puts a card on Home (below).

## GitHub (read-only)

Paste a PR or issue URL; Jarvis parses `owner/repo/number` (`parseGithubUrl`) and stores state `open`. "Mark merged" / "Mark closed" (PRs) and "Mark closed" / "Mark open" (issues) set it by hand. Jarvis never writes to GitHub and never registers webhooks.

### Connections (Settings → Connections → GitHub, admin only)

- **One token per GitHub owner** (your user, each org): label, owner, token, optional repository allowlist. The token is write-only: encrypted with `server/crypto.ts`, never returned or logged; the UI shows `•••• last4`. Replacing a token clears its last test.
- **Test** does read-only checks with the stored token: `GET /user` (login, `x-oauth-scopes`), then `GET /repos/{owner}/{repo}` for each allowlisted repo (your account's role on it when GitHub reports `permissions`), or `GET /orgs/{owner}` (falling back to `/users/{owner}`) and `GET /rate_limit`. Classic tokens, or any write/admin scope, show **"This token can write — Jarvis only needs read. Prefer a fine-grained read-only token."** The result is stored on the connection.
- Inline help links to the prefilled fine-grained token form: `https://github.com/settings/personal-access-tokens/new?name=Jarvis%20read-only&target_name=<owner>&expires_in=365&pull_requests=read&issues=read`.
- Every add/edit/remove/test, the webhook secret and the poll interval are audited (`github.*`) without secrets. Tests assert tokens never appear in API responses or the audit log.

**Token resolution** (`resolveGithubToken`, async): first an allowlisted, unsuspended **GitHub App installation** on the repo owner that covers the repo (all repositories, or the repo is in its selection); then the connection whose owner matches the repo owner (case-insensitive) and whose allowlist (if any) contains the repo; then `JARVIS_GITHUB_TOKEN` (backward compatible); otherwise none. If minting an installation token fails, it falls through to the next. Every read (Refresh, view/dashboard refresh, poller) uses it. The API base is `JARVIS_GITHUB_API_URL` (default `https://api.github.com`; tests and e2e point it at the mock).

**Rate limits**: a 429, or a 403 with `x-ratelimit-remaining: 0`/`retry-after`, puts that token in backoff until `retry-after` / `x-ratelimit-reset` (else 1, 2, 4… minutes, capped at an hour), process-wide (`server/singleton.ts`). Requests during backoff aren't sent.

### Refresh on view, scheduled poll, webhooks

- **On view** (phase 2, unchanged rules): viewing an item or the dashboard calls `POST /api/work/github/refresh` (≤ 1 read per link per 5 min, ≤ 10 per request, ≤ 4 in flight, claimed with a conditional update).
- **Scheduled poll** (`server/work/github-poller.ts`): a small scheduler started from `instrumentation.ts` (and re-armed when a connection or the interval is saved). It is **not** the general worker, which stays disabled in production (`JARVIS_DISABLE_WORKER=true`). It runs only while a GitHub connection (or `JARVIS_GITHUB_TOKEN`) exists and `work.github.poll_minutes` (Settings, default 10, 0 = off) is above 0; one per process. Each tick: at most **50** due links (per-link minimum 5 minutes, merged PRs never re-read, claimed first), **4** in flight, through the same idempotent readback (events `source = github`, actor `github`); then each connection's assigned issues. "Check now" in Settings runs one tick.
- **Webhooks** (`POST /api/work/github/webhook`, public, no session, no CSRF): verifies `X-Hub-Signature-256` (HMAC-SHA256 of the raw body, constant-time compare) with the **GitHub App's webhook secret or** the legacy webhook secret; no secret configured → everything is refused. App events: `installation` / `installation_repositories` (trusted only with the App secret) keep the installation list current; `check_suite` / `workflow_run` set `checks_state` on linked PRs — the combined state of the head commit read with GETs (`…/commits/{sha}/check-suites` + `…/status`; suites with no runs ignored) when a token covers the repo, else the event's own result; `pull_request_review` updates PR state like `pull_request`. Deliveries for accounts outside the App allowlist are ignored. PR readback (Refresh, view, poller) also records the head commit's combined checks; linked PRs show **merged** plus **checks green / red / running**. 401 on a bad signature, 413 over 1 MB, 400 without delivery/event headers. Each `X-GitHub-Delivery` is handled once. `pull_request` and `issues` events update only PRs/issues already linked to Work items, plus assigned-issue intake; `ping` answers 200; anything else is ignored (202). Settings shows the payload URL and generates the secret server-side, shown **once** (Regenerate replaces it). You add the webhook in GitHub yourself (content type JSON, events "Pull requests" and "Issues").

### GitHub App (Settings → Connections → GitHub → GitHub App; owner how-to: docs/github-app.md)

Admin only, audited (`github.app_*`), read-only toward GitHub. Code: `server/work/github-app.ts` (I/O), `server/work/github-app-rules.ts` (pure).

- **Create GitHub App** (manifest flow). `POST /api/github/app/manifest {name ≤ 34, target user|org, org?}` builds the manifest. It contains: `url` = public origin (`JARVIS_PUBLIC_ORIGIN`, else the forwarded host); `public: true`; `redirect_url` = `<origin>/api/github/app/callback`; `setup_url` = `/settings/connections?github_app=installed`; `hook_attributes {url: <origin>/api/work/github/webhook, active: true}`; all six permissions `read` (metadata, pull_requests, issues, checks, statuses, actions); events `pull_request, pull_request_review, issues, check_suite, workflow_run`. The route also stores a random state (sha256 only, 10 min, bound to the admin and the sha256 of their session cookie, or `proxy:<user>` in proxy mode; phones are refused). It returns `https://github.com/settings/apps/new?state=…` (or `/organizations/<org>/settings/apps/new`). The browser builds a form and POSTs `manifest` there. The CSP's `form-action` allows `https://github.com` for this.
- **Callback** `GET /api/github/app/callback?code&state` (public route; it checks the session itself). The state must exist, be unexpired, and belong to this admin and this session; it's deleted on first use. The code (format-checked) is then exchanged with `POST {JARVIS_GITHUB_API_URL}/app-manifests/{code}/conversions`. Id, slug, owner and client id are stored; client secret, PEM and webhook secret are stored encrypted. The browser only gets a 303 to `/settings/connections?github_app=<outcome>#github` (`created`, `state`, `forbidden`, `exists`, `missing_code`, `conversion`, `unreachable`), and Settings shows the message. One App at a time (409).
- **Connect existing App** `POST /api/github/app/connect {appId, pem, webhookSecret?}`. All fields are write-only. Jarvis verifies them with the App JWT (`GET /app` must return that id) before storing, then reads the installations. `PATCH /api/github/app {webhookSecret}` replaces the webhook secret. `scripts/import-github-app.mjs <json>` is the one-shot container import of the conversion JSON (docs/github-app.md); it prints no secrets.
- **App JWT**: RS256 with `node:crypto` (`iat` = now − 60 s, `exp` = now + 9 min, `iss` = App id). **Refresh installations** (`POST /api/github/app/installations/refresh`) calls `GET /app/installations`, then `GET /installation/repositories` for each allowlisted, active installation. Gone installations are deleted.
- **Installation tokens**: `POST /app/installations/{id}/access_tokens`, cached per installation (`server/singleton.ts`) until expiry − 5 min, dropped on installation webhooks, allowlist changes and Forget. This POST and the manifest conversion are the only non-GET calls Jarvis makes to GitHub.
- **Account allowlist** (`PATCH /api/github/app {allowlist | null}`). The default is the owners of the token connections plus the App owner. Installations on other accounts are listed as **Ignored** and never get a token; their webhook deliveries are dropped (202 `installation_not_allowed`, audited as `rejected`).
- **Forget this App** (`DELETE /api/github/app`) removes the credentials, installations and allowlist locally. Deleting the App on GitHub is the owner's step.

### Assigned issues → Inbox

Per connection, the poller reads `GET /issues?filter=assigned&state=open` (open issues, not PRs, in that owner's repos and allowlist) and upserts them into the inbox of the person who added the connection (deduped by issue node id). Webhook `issues` events do the same for the token's login (learned by Test). Issues closed or unassigned leave the inbox. Accepting creates a thread (default Miscellaneous, or the destination you pick) linked to the issue as `reference` or `implementation`; dismissing hides it for good.

## Today and the Inbox (`/work`)

`/work` opens on **Today** (`GET /api/work/today`, `server/work/today.ts`, local data only): a KPI strip (in progress, awaiting validation, overdue, inbox count, merged-not-settled), **Continue** (1–3 items: in progress first, then ready/in review/reopened, most recently touched), **Proof due** (awaiting validation, earliest due first, "Record result" focuses the observed-value field), **PR merged — settle?** and **Overdue**. Primary navigation is the left rail: **Today**, **Inbox** (with its count) and the area tree. Status lanes exist only as dashboard widgets/filters.

The **Inbox** (`?view=inbox`, `GET /api/work/inbox`) holds assigned GitHub issues, quick captures (`POST /api/work/inbox`, also from the command dock) and your unfiled conversations (phase 2 data, with File under… / File in Miscellaneous / Dismiss). Every row says where it came from and why it's there, with File/Accept, Dismiss and Open. Deterministic only: no AI triage. Dismissing a conversation stores only its id (Hermes owns conversations; Jarvis renders and links them, nothing else is copied).

Desktop is a full-width workbench (Direction C): a left pane (Today, Inbox, area tree with status dots), the centre (Today, Inbox or the item workspace) and a read-only **context rail** (Today: due soon, on hold, keys; an item: validation, PRs, lineage, dates, conversations; actions stay in the workspace). The context rail (288 px) is rendered only when the centre keeps at least 640 px beside it (measured on the content column, so an expanded app rail drops it instead of squeezing the workspace); below 1600 px the app shell shows Work with the icon rail by default (an explicit toggle there is remembered separately). Density lives in `components/work/work.css` (scoped to `.work-ui`): compact rows/controls only for fine pointers, 44 px targets on touch; the item's Details are a property sheet (label column, summary grows from two lines). On phones the order is Today/Inbox switch → content → tree; on an item the tree folds behind the header's **Areas** toggle, Validation and the packet come first, and Details, Dependencies and Links are disclosures (Dependencies opens itself when blocked; a section opens when something is added to it). `?item=<id>&do=packet|continue|settle|validate` (used by the palette and Today) opens that action on the item.

## Command dock and palette

An orb in the app shell that never covers content: the middle item of the phone bottom bar, and on desktop the foot of the app rail ("Commands Ctrl ." row; just the orb when the rail is collapsed). On desktop the radial map is re-centred inwards so every petal fits; the orb itself stays a cancel zone. **Tap** → the global search, which is also the command palette: Go to Today/Inbox/Timeline/Dashboard/Map/Home/Hermes/Alerts, Capture to Inbox, Start focused work, Record validation, Continue in conversation (the item commands act on the open item, otherwise they take you to Today). **Press and hold** (~320 ms) → the radial action map (Search, Capture, Go to, Hand off, Validate, Inbox); slide onto a petal, pause ~⅓ s for its sub-menu, release to run; release on the orb cancels. **⌘/Ctrl+.** opens the map from the keyboard: arrows choose, Tab/Enter opens a sub-menu, Enter runs, Esc closes. Every map action is a palette command, so the gesture is never the only path. Pointer events, no dependencies; Work actions only appear with `work.use` (conversation ones also need `hermes.chat`). Code: `components/navigation/CommandDock.tsx`, `commands.ts`.

## Timeline (`/work/timeline`)

Rows are a chosen area/project (or all areas), depth-indented. Bars run start → target in the status colour (a diamond when only one date exists); markers show when work actually started (first `in_progress`), PR merges and settlement, all from `work_events`. A red line marks today; overdue items (target passed, not closed) get a red outline; overdue validations get a "!" marker. Zoom weeks/months; "Show as table" is the accessible equivalent. Rows link to the item.

- **Editing**: drag a bar to move it, or drag either end to change that date (pointer events, snapped to whole days, never past the other end: `shiftDates`). The table's **Edit dates** opens a form (the keyboard alternative); the item's Details form works too. Every date change writes a `dates` event ("Dates: start A → B, target C → D").
- **Dependencies** (`POST /api/work/items/:id/dependencies {dependsOnId}`, `DELETE /api/work/dependencies/:id`): "this item depends on that one". Self-dependencies and loops are refused (`wouldCreateDependencyCycle`). They're drawn as connectors from the blocker's end to the dependent's start (dashed when the dependent starts before the blocker ends). The item shows **Blocked by** / **Blocks** with statuses and a "Blocked" chip while a blocker isn't closed; the table shows "Blocked".

## Map (`/work/map`, read-only, P2)

An optional orientation view (a Map tab; the tree stays the default and the only place to edit). `GET /api/work/map?root=` (`server/work/map.ts`) returns up to 300 visible items of an area/project (or everything) and their edges: containment, lineage (`forked_from`, `split_from`, `handoff_from`; moves are placement history and aren't drawn) and dependencies. `lib/work-map.ts` lays it out deterministically (`layoutMap`: depth = row, leaves take consecutive columns in depth-first sort order, parents centred over their children; the same graph always gets the same picture whatever order it arrives in). Pure SVG: drag the background to pan, zoom with the buttons or the wheel, **Fit** to see everything. Filters: relation types and status. Selecting a node opens the item. **Show as list** is the accessible alternative (nested list with each item's cross-links).

## Dashboard (`/work/dashboard`)

Native widgets are computed server-side from work data only (`server/work/dashboard.ts`): **Pulse** (the KPI strip: in progress, awaiting proof, overdue, in review, ready to settle), **Status lanes** (lanes Exploring → Settled with counts and up to 6 items each; the lane chips filter the widget — lanes are an overview, never navigation), Priorities (ready/in progress by target date), Next actions, Awaiting validation (pending/failed/overdue counts), Recently settled (legacy auto-settled badge), Timeline slice, Project map (read-only outline of an area/project), Metric (manual value/label/target + optional http(s) or Jarvis link), **Validation overdue** (count and the items), **Unfiled conversations** (loaded by the widget from the conversations API; needs `hermes.chat`), **Map snapshot** (a small fitted map of an area/project linking to `/work/map`).

Edit mode adds, configures and removes widgets, resizes them (S/M/L buttons) and reorders them by dragging the grip (`PATCH … {position}`) or with the ↑/↓ buttons (the keyboard way). With a GitHub connection (or `JARVIS_GITHUB_TOKEN`), loading the dashboard also triggers the throttled GitHub refresh. Defaults for new dashboards are unchanged; add Pulse and Status lanes from "Add widget".

### Custom HTML widget security model

Unchanged in phase 2.

- Rendered **only** as `<iframe sandbox="allow-scripts" srcdoc="…">` (`CustomHtmlWidget`). Never `allow-same-origin`, never `dangerouslySetInnerHTML` in the app document. The frame has an opaque origin: no Jarvis cookies, no storage, no same-origin API access, no top navigation, popups or forms.
- `buildCustomWidgetSrcdoc` puts this CSP meta first in `<head>`, before any author markup (later policies can only tighten it):
  `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:` — so no network at all (fetch/XHR/WebSocket, remote images, fonts, frames).
- HTML is limited to 100 KB (validated in the API and in the builder).
- Optional data: when "Send this widget a read-only snapshot" is on, the parent posts `{ type: "jarvis.work.snapshot", data }` to the frame after load. `data` holds only titles, kinds, statuses, depth, dates and next actions of the chosen area — no links, URLs, tokens or finance. The parent never listens to messages from the frame, so the widget can't call Jarvis.
- The widget is labelled "Custom HTML (sandboxed)".

E2E (`e2e/work.spec.ts`) proves the attributes, the CSP, that `parent.document`, cookies, storage and `fetch` are blocked inside the frame, and that the snapshot arrives.

## Home

People with `work.use` get Work cards in Home attention (`server/work/home-rules.ts`, pure; wired in `server/sources.ts` `homeSelection`). Work isn't an integration adapter: it's computed per person from local data on every Home request (cached or live), so it's never stale and never shared.

- **Validate: <item>**: an `awaiting_validation` item with at least one overdue validation; due on the earliest overdue validation's date.
- **<item>**: an `in_progress` item whose target date is today ("Target date is today") or earlier ("Past its target date").

They're ordinary date-only `NextAction`s (`source: "work"`, id `work:validation:<id>` / `work:target:<id>`, opening `/work?item=<id>`), so the existing deterministic ranking places them (today, overdue since yesterday, or long overdue) and the Now ≤ 3 / Today ≤ 5 budget is unchanged. Feedback works as for other sources (`source:work` category). `ActionSource` now includes `work`; `AdapterSource` is the adapter-backed subset.

## Search

A `work` provider in `server/search.ts` matches title, summary and next action and links to `/work?item=<id>`.

## Mobile

Phones are first-class for capture (dock → Capture, or the inbox form), triage (inbox rows with 44 px actions), approving/settling, recording validation (numeric keypad, "Record result" focuses the field) and continuing a conversation. Dialog footers are sticky on phones so the primary action stays reachable; Today, Inbox and dialogs are checked for no horizontal scrolling at 320 px. Planning (timeline drag, map) stays desktop-first.

## Not yet

AI triage/summaries, GitHub writes, sharing, packet accept/reject, redo, editing from the map, a custom-HTML widget gallery (future), context-aware dock petals, Android screens (the Android app is untouched: `work` search results and Home cards there have no native route, and the Android source label map has no "Work" entry, so the label is omitted).

Rollback: remove the `work.use` capability; the tables are additive and nothing existing is rewritten. GitHub: delete the connections (Settings) and set the poll interval to 0; without a webhook secret every delivery is refused.

## Areas (phase 4)

### Task chats (task threads, step 1)

A task (a work item that is not an area or a conversation; a note has no children, so no chat) has **one primary chat**. Its session id is stored on the task (`work_items.primary_session_id`, unique per owner; `lib/task-chat.ts`), and everything that needs "the task's chat" reads that pointer: the agent-run read (`ItemAgentInfo.sessionId`), the item work list, decisions, sub-agent mirroring and its reconcile watch list, and the area defaults of a run in that chat.

- **Created with the first message**, never on page load: `POST /api/work/items/:id/chat` (`server/work/primary-chat.ts ensureTaskChat`) starts a conversation filed under the task, on the profile that answers for its area (`startConversation`), and records it as primary. Two sends racing for the first message end in one chat.
- **Other chats**: conversations filed under the task or linked to it that are not primary. **Make primary** (`POST /api/work/items/:id/chat/primary {sessionId}`, confirm + Undo, undo kind `primary_chat`) swaps them; a linked chat is filed under the task as part of it. A chat that also served other work (another task's primary, filed under another item, linked elsewhere, or named by an agent run on another item) is refused: it is never one task's primary chat.
- **Fork** of the primary chat is filed under the same task as another chat; the original stays primary.
- **The page** (`app/(shell)/areas/WorkView.tsx`): the title, then ONE tab bar (`Overview · Chat`, `?tab=chat`; the old `?tab=chats` still opens Chat and `?tab=activity` opens Overview with the log open). On phones a tap or a sideways swipe moves between the panes; with 600px of content they sit side by side and the bar is left out (`SplitPane`). Only the pane that shows is mounted, so only an open chat holds a live connection.
- **Overview** reads top to bottom: fields; Next (what needs you, then the written next step); Timeline; Agents and sub-tasks; Decisions (open and made); Made and linked (the task's links, then what its chat made or linked, read under the chat panel's own query keys); Done when; Plan; and one Log line that opens in place. A status bar at the bottom says what is happening; a tap opens Chat.
- **Chat** is the shared thread (`components/chat/ChatThread.tsx`, the chat page's own thread in an embedded frame): the same messages, tool steps, composer, status bar and "In this chat" sheet as any chat.
- **Backfill** (migration `0047_primary_chat.sql`, pointer only): a chat is promoted only where it served one task, counting every item it is filed under (Miscellaneous counts as unfiled), linked to, or named by an agent run. Per task: a chat filed under it, then a linked one, then a run's chat (only if Jarvis knows the session); newest first. Projects, notes and areas get none. Nothing is moved, linked or created.

Owner decisions (binding): **one tree** for everything (Momentum Bets, Home, General Dev, Finance…) holding work items _and_ conversations; **misc chats stay effortless** (zero filing); **`@` for every reference**, `#` for GitHub PRs/issues, `/` for commands, no `!`.

### Task state and the task list (task threads, step 3)

**One state per task**, worked out by one rule (`lib/task-state.ts taskState`, pure and unit tested) from its status, the runs registered on it, its open questions and its chat. Every list and page asks this rule, so two screens cannot disagree. In list order:

| State            | When                                                                                                          | Reason shown                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Needs you        | an open question, a run paused on the owner, or a chat run waiting on an approval                             | the question (or "Waiting for your approval")                    |
| Failed           | the newest top-level run on it failed (a failure that was retried is history)                                 | the error in one line                                            |
| Stalled          | a run was stopped, or is running with no report and no activity in its chat for 30 minutes                    | what would move it, else "no word since" with the time or date   |
| Working          | a run reported, or its chat was active, inside 30 minutes, or a turn is in flight there                       | none: age and who has it                                         |
| Ready for review | its newest run finished or its chat ended, or its status is In review, Awaiting validation or Ready to settle | the result in one line                                           |
| Not started      | nothing has worked on it                                                                                      | where it stands ("captured 3d ago", "on hold") and its next step |
| Done             | the owner closed it (settled, superseded, abandoned). A finished run never makes a task Done                  | none                                                             |

A task marked In progress that no agent has touched reads "Not started · in progress, no agent on it": the state is about work Jarvis can see. It is listed under All, never under In flight.

**Honest state (step 4).** "Working" is checked against the chat: the ended-chat check (`server/work/session-end.ts`, every 5 minutes, 10 chats a pass) records when each open run's chat was last active (`agent_runs.chat_active_at`), and a run that reports little stays Working while its chat is active. A run whose chat ended is interrupted with "Session ended (…)" and makes its task **Ready for review**, never Working, Stalled or Done. **Check in** on a stalled task with a chat (`POST /api/work/items/:id/check-in`, the owner's tap only) asks its agent for a status in the task's chat (asked first: a sent message can't be taken back): guidance for the turn in flight, else the next message. An AI action running on the task keeps it Working too, and every stalled check (the task page's escalation, the agents' own read, the stalled-runs job) uses the chat's activity.

**Key moments.** Each timeline line has a kind: Started, Found, Made, Asked you, Decided, Blocked, Handed off, Resumed, Stopped, Chat ended, Failed, Done (plus CI, release and lock lines). Agents name the four they know (`jarvis_run_event` with `type: "progress"`, `moment: found | made | blocked | handed_off`, one line of at most 140 characters); Jarvis writes the rest from what happens. The brief `jarvis_start_task` writes asks for them. A task's Overview reads the same timeline its row opens in place (`GET /api/work/items/:id/timeline`).

**Answers reach the agent (step 5).** Answering a question (from a row, the task's Overview, its chat, the queue or a push) records it at once and marks it for delivery to the task's chat, else to the chat of the run that asked (`decisions.delivery_*`, migration 0049). Once the 10-second Undo window has passed, a dispatcher pass (`server/work/answer-delivery.ts`, every 10 s) posts "Answer to D-n (question): answer" there: guidance for the turn in flight, else the next message; a turn paused on an approval is waited for. Before choosing, it asks Hermes for the turn's state (Jarvis's record can lag when no chat is open). It reads **Delivered** only once the chat confirms it: the message read back in the conversation (compared as sent, after masking), or the turn it was given to as guidance ending without handing it back (`pending_steer`; then it is posted as the next message, `decisions.delivery_run`, migration 0051). A message not seen within 3 minutes reads "not delivered", and a failed post is retried for 30 minutes. Undo inside the window posts nothing; an answer given in the chat itself is not posted back. The receipt says "Sending" until the server reads it back, then "Delivered" or "Not delivered" (`GET /api/work/decisions/:ref/delivery`); the timeline's "Decided" line says sending, delivered or not delivered. The task's open questions are answered at the end of its chat, right above the composer, and its header shows **Stop** while it works (asks first) and **Resume** / **Retry** once it stopped or failed (opens the chat with the words ready). A question open for seven days is not yet raised again by its coordinator: that needs the agent side.

**One read** (`GET /api/work/tasks?scope=all|<areaId>|<projectId>&view=flight|all|review`, `server/work/tasks.ts`, shape and builder in `lib/task-list.ts`) and **one component** (`components/tasks/TaskList.tsx`) serve In flight, a project's Tasks section and the review queue. It reads Jarvis's own records only (items, registered runs and their events, open decisions, pull request links), so lists poll every 15 seconds and never open a connection to the assistant.

- **One row per task.** Runs, questions and chats are never rows: a run is how the task got its state, a question is why it needs you, a chat is where it opens. Run numbers (R-n) are not shown; a question keeps its D-n as a chip.
- **A row** is three lines: the state with its reason and who has it; the title (opens the task on Overview); the latest activity fading into the one before (opens the timeline in place: `GET /api/work/items/:id/timeline`, newest first, each line with its type and time). Icon actions in a fixed order: Steer, then Stop or Retry. Steer, Retry and Resume open the task's chat with the composer ready (`?tab=chat&compose=1`, `&draft=retry|resume`); nothing is sent from a list. Stop asks in place, then `POST /api/work/items/:id/stop` marks the task's open runs "stopped by you" and asks the assistant to stop the turn in its chat. A question with one or two short, safe choices is answered from the row (the shared answer flow, with its 10-second Undo); anything else is "Answer", which opens the task at the question. Only "Working" moves.
- **In flight** (`/resume`, `view=flight`): tasks that need you, failed, are stalled or working, flat, by channel (area). Channels with something needing you come first; inside one: Needs you, Failed, Stalled, Working, then most recent first. Finished and unreviewed work is one row with a count and the oldest age; what closed since the last visit is one row. **All** (`?view=all`): every open task by channel, then project; a project row rolls up what is inside ("3 of 10 done · 2 need you") and opens two levels in place. At 600px and wider, picking a row shows its chat beside the list (`?task=<id>`).
- **Add a task** creates the task in the chosen channel and starts its chat with what was typed (the channel's bot gets it as the first message). Without chat access the task is created and opened, nothing is sent.
- **The navigation badge** on In flight is the number of tasks that need you, nothing else (the same number as its Needs you rows).
- **Review queue** (`/resume/review`, `view=review`): finished and unreviewed tasks grouped by project, each with its result line and pull request state. Several can be marked reviewed behind one confirm (`POST /api/work/tasks/review {ids}`); each close is its own undoable edit and Undo reopens them all. A task that cannot be closed yet (a validation to record) is left open and named. "Send back" opens the task's chat with the composer ready. Nothing is closed without the owner's tap.
- **A bot chat has two tabs, Chat and Tasks** (`components/coordinator/GlobalCoordinator.tsx`, `components/agents/CoordinatorPane.tsx`). Tasks is In flight scoped to the bot: every channel for the Chief of staff, its own channel for an area coordinator. Under Tasks also sit the things that are not task rows: the answer card of a decision that was opened (from a D-n chip, the tray, a `?coord=needs&d=D-n` link or a row's Answer), approvals that are not on a task, "Resume all" for interrupted work, and what the Chief of staff changed, with Undo. Old `?coord=needs|running|changes` links land on Tasks.
- **One continuous chat.** A bot's earlier threads are the top of its chat, not a list: above the current thread (once all of it is shown) is one grey "Earlier" divider; tapping it draws the thread before there, greyed and read-only, behind a hairline with its date, and the divider moves up to load the next. Nothing folds and nothing else is offered on the history. New thread asks first and has Undo; the thread you leave stays above it.
- **Words.** The interface says "task", and "project" for a task with tasks inside ("+ Task", "Add sub-task", "Open task", "New task in …"; the palette still understands "new item in"). A run's number (R-n) is not shown on lists or pages: where several runs worked on one task, a timeline line names the run by its title. R-n still appears where an agent wrote it in a chat reply, and on the run rows drawn under that reply. Nothing is renamed in data, routes or prompts.
- **A project** (a task with tasks inside) uses the task page: Overview and Chat, the chat being with the bot that answers for it. Its Overview adds the roll-up, the tasks that need you (answered there), Tasks in three views switched in place (List, Board, Graph; each opens full screen), the agents working anywhere inside it and a timeline across its tasks. Board, Activity and Graph are views, not swipe tabs: the bar names one only while it is open.

### Navigation

- The app rail and phone bar show **Areas** (`/areas`) instead of Work + Hermes for people with `work.use`; people who only chat keep **Hermes** (`/chat`). `/home-control` is labelled **House** (no second "Home"); Workouts has its own dumbbell icon.
- **One rail state everywhere** (design review D3): collapsed (icons) up to 1440 px, expanded above; the person's toggle (`localStorage jarvis:rail`) wins on every route. Work no longer collapses it.
- **One secondary nav row** (`AreasNav`, nav `Areas sections`): Today · Inbox · Areas │ Timeline · Dashboard · Map, plus one **+ New ▾** menu (chat, item, project, area, capture to Inbox) that creates in the open area/project. Chats are in the tree and in **+ New → Chat**; `/chat` keeps its own list. The same tree sits beside every conversation on desktop (`/chat/*`, `components/areas/AreasSidebar.tsx`).

### Areas structure (node types and building the tree)

- **Containers vs work** (`isContainer` in `lib/work.ts`): areas (top level) and projects are containers; threads ("items"), investigations, notes and conversations are work. Container pages show progress (`rollup`: projects, open, active, proof due; projects count done/total of their work), children as dense rows with an inline **+ Add** row, recently updated descendants, details and (areas) **Area settings** behind a disclosure. They never show validation, packets or PR links unless the project already has a packet/validation (legacy leaf use).
- **Work pages** keep the workspace but show one context-aware primary action (`primaryAction`: Start focused work → Continue → Record result → Settle… → Reopen; Open conversation for chats) and a ⋯ menu for everything else (sub-item, link PR/conversation/URL, rename, move, convert to project, fork, split, AI actions, Board and Graph, archive). A task's page is two panes, **Overview** and **Chat** (see [Task chats](#task-chats-task-threads-step-1)); sub-tasks appear in Overview.
- **Quick add with paths** (`POST /api/work/items/path`, `createPathSchema`): "Momentum bets / V5 evaluator / hydration fix" reuses existing levels by title (case-insensitive, unarchived, not conversations), creates missing ones as projects (a missing first level without a parent as an area) and the last as the chosen kind (default from the parent: area → project, otherwise thread). Only " / " with spaces separates levels, so "CI/CD" stays whole. One transaction; notes can't hold items; only areas sit at the top.
- **Tree editing** (`components/work/WorkTree.tsx`): an "Add to …" row ends every open area/project (Enter keeps adding), "New area" ends the tree; F2/double-click renames; Alt+→/← indent/outdent, Alt+↑/↓ reorder (all via `place`, so undo and `moved_from` lineage apply); M opens **Move to…**; Ctrl/⌘/Shift-click or **Select** picks several rows for a bulk Move to…/Archive. Collapsed rows persist in `localStorage jarvis.areas.collapsed`.
- **Move to… / File to…** share one searchable picker (`DestinationPicker`: combobox + listbox, suggested first, excludes the moving subtree, notes and conversations). The Areas section (`/areas?view=tree`) lists every area with progress (desktop) and **Unfiled conversations** with bulk select → **Accept suggestions** (keyword suggestions) or **File to…**.

### Conversations in the tree

- **Nodes**: `kind = conversation` rows with the session id. They nest (children allowed, never inside a note), move, drag/drop, undo, settle and reopen like any item. The item form can't create them (`CREATABLE_KINDS`), and a node can't change kind. Forking the _item_ is refused ("fork the conversation itself"): forking the conversation (`POST /api/hermes/sessions/:id/fork`) places the fork **next to its parent** with `forked_from` lineage.
- **Linked conversations** (`work_links` of kind `chat_session`) show as read-only child rows of their item (`GET /api/work/items` → `linkedConversations`). Selecting any conversation row opens `/chat/<id>`. On a task they are listed under **Other chats** on its Chat tab.
- **New chat from anywhere** (palette's first command — so a dock tap then Enter —, Areas' **New chat**, an item's **New chat here**, `/chat`, Home's **Ask Hermes**): `POST /api/hermes/sessions {areaId?}` (`server/areas.ts startConversation`) creates the session and its node at once — in **Miscellaneous**, or under the area/item it was started from. Placement never blocks the chat (if it fails the chat is simply unfiled). Node titles follow the assistant's titles whenever conversations are listed (`syncConversationTitles`).
- **Unfiled** = not in the tree, or only directly in Miscellaneous. `/chat` for Areas people is the **conversations view** of the same data (`GET /api/work/conversations?view=all|unfiled`): grouped Today / This week / Older, backend, last activity, a placement chip, and for unfiled ones a one-tap **File under <suggestion>** plus **File…**. The **Inbox** only lists conversations that aren't in the tree at all (chats that land in Miscellaneous never nag).
- **Filing** (`POST /api/work/conversations/file`) creates or moves the node (an undoable Move). It first reads the conversation through `server/assistant` as the access check and **refuses (503) if the assistant doesn't answer**, instead of trusting the id.
- Conversation header (`components/chat/Conversation.tsx`): an **area chip** (path or "Not in Areas", opens _File under…_), up to two suggestion chips, **Properties** (the node in `/areas`), and an explicit **Shared with household · Stop sharing** chip.

### Composer: `@`, `#`, `/`

- `@` opens a picker with typed sections — Areas, Work, Conversations, People, Devices, Files & links (URL links on your items) — and `type:` filters (`@chat:`, `@area:`, `@item:`/`@work:`, `@person:`, `@device:`, `@file:`), keyboard-driven from the textarea (↑/↓, Enter/Tab, Esc; `aria-activedescendant`). `GET /api/references?q=` (`server/references.ts`). AI-excluded areas and their subtrees are never offered; Finance is eligible like any area.
- `#` lists PRs/issues: ones linked to your work (local, no token) plus a read-only GitHub issue search in the **repo chip**'s repo (the area's default repo; click to change), with the normal token resolution (App installation → connection → env). `GET /api/references/github?repo=&q=`.
- `/` commands: `/model`, `/mode` (new conversation with the other assistant, same area), `/file`, `/handoff`, `/fork`, `/settle`, `/share`, `/new`, `/context`. Each is also reachable from a menu or the header.
- Picked references are written as tokens `@[Label](type:id)` / `#[Label](gh:owner/repo#n)` (`lib/references.ts`), rendered as chips in the timeline. On send the server resolves them (`resolveReferences`) into a "Referenced:" snapshot appended under _Context from Jarvis_ — only what the sender may see (other people's items, unknown types and AI-excluded subtrees resolve to nothing). Credentials are blocked and account numbers are masked to last 4. The timeline folds that context into a disclosure.

### Model selector

`GET /api/assistant/models?backend=hermes|claude`: Hermes' `/v1/models` plus models its providers report via `/api/model/options` (and Hermes' default), or the Claude-direct list. The composer's **Model** chip (and `/model`) opens a searchable list; the choice is remembered per conversation (browser), and "Also make it the default for <area>" saves the area's default. A run uses: the message's override → the area's default model/provider → the household preference.

### Per-area settings

Area → **Area settings** (`PATCH /api/work/items/:id {settings}`, areas only, merged, audited `work.area_settings`): agent mode (e.g. a Hermes profile name such as `momentumchief`) and instructions — sent as Hermes run `instructions` ("Jarvis area: X. Agent mode: Y. …"; Claude-direct ignores them) —, the assistant new conversations use, the default model, the **default repo** (scopes `#`), context sources attached to every message (Today overview, Skylight, Home Assistant, Todos, Daily Compass, Paperclip; filtered by what the sender may see), the settle policy and quiet days, and (in Details) the validation default.

### Settle policy

`server/work/settle-rules.ts` (pure, unit tested). Deterministic signals: a linked implementation PR is **merged**, the **settle gate passes** (validations pass/waived; a packet that requires validation has one), and **no activity** (events, edits) for the area's quiet days (default 3).

- `manual`: nothing.
- `suggest` (default): Today lists **Ready to settle?** (items not already prompting as _Ready to settle_).
- `auto_after_quiet` (opt-in per area): computed when Today loads (`settleReview`), the item is settled with `settled_kind = auto`, an event ("Settled automatically: PR merged, validations pass, quiet for N days (Area policy)"), an audit entry (actor `jarvis`) and a `settle` undo op. Today shows **Settled automatically** with **Undo** for 7 days (`AUTO_SETTLE_UNDO_MS`): undo reopens it to its previous status.
- A cheap model check could refine suggestions later but needs model-spend approval: `settleModelCheck` is the hook and has no opinion today.

### Capture

Home's box is the one capture primitive (design review D1): **Enter captures to the Inbox**; **Ask Hermes** (button, or ⌘/Ctrl+Enter) starts a conversation instead. The PWA share target opens the Inbox capture sheet prefilled (`/areas?view=inbox&capture=…`) with **Ask Hermes instead** on the sheet; without `work.use` both still go to Hermes. AI triage of the Inbox is phase 5.

### Sharing

Sharing stays read-only for the household. Share/unshare writes `conversation.share` / `conversation.unshare` audit entries (`server/areas.ts patchConversation`); Settings lists **Shared conversations** (`GET /api/hermes/sessions/shared`) with Stop sharing.

### Not yet

Real Hermes profile routing (the API takes `instructions`, not a profile), syncing archive state from Hermes into nodes, a resizable tree pane, phone-specific composer sheet, workflow-run validations, AI triage (phase 5).

## Portfolio (replaces the portfolio map board)

`/areas?tab=portfolio` (landing only, `components/areas/PortfolioTab.tsx`, rows from `lib/portfolio-view.ts`): one row per project across areas (Finance left out) with its open work in status lanes (Blocked on you · In flight · Next · Live · Backlog; Done as a count), board/PR link chips, a Group filter over item tags, Needs you, and the running release (`GET /api/work/portfolio`: `JARVIS_VERSION`, process start, migrations; local reads only).

Import: `POST /api/work/import/portfolio` `{ map, apply?, aliases? }` takes the published `portfolio-map.json` (`lib/portfolio-import.ts` plans, `server/work/portfolio-import.ts` applies). Dry run by default. Board projects map to containers by title path (`DEFAULT_TARGETS`), unknown ones become projects under the Portfolio area; nodes become items (group → lane tag, links https only, Live/Done → ready to settle, never a final status), owner-blocked asks become Portfolio items with an owner decision. Matching (normalised title, word-boundary prefix ≥ 12 chars, or `aliases`) makes a re-run a no-op; matched items only gain missing links and tags. One transaction and one Undo (`work_ops` kind `import`, item id `portfolio-import`, `server/work/portfolio-undo.ts`). Agents report status by linking boards/PRs onto items (`jarvis_link`), not by editing the board.

## AI actions, reports and capture (phase 5)

Jarvis runs background AI work through Hermes and keeps the validated result as a **report** on the item.
Everything here needs the `work.ai` capability (admin only by default; grant it per person in Settings → People)
and Settings → AI → Enabled (off until the owner turns it on).

- **Task actions** (item header "✦ Get started", the item's ⋯ menu, palette "Research this / Make a plan / Suggest a time / Draft…"):
  - _Research it_ and _Draft it_ → report with sources and next actions; the research conversation is filed under the item (`chat_session`, role `evidence`, lineage `ai_action`) and can be continued.
  - _Make a plan_ → 3–12 steps; **Create N child items** is one undoable operation (`ai_plan_create`: untouched children are deleted, changed ones archived).
  - _Suggest a time_ → a fast model estimates duration/windows; Jarvis finds 3 free slots in Home Assistant + Skylight calendars on the server (calendar data never goes to AI). **Set dates** writes start/target dates. Calendar writes are off (owner decision).
- **Jobs** (`ai_jobs`): queued → running → succeeded/failed/cancelled, with `waiting_approval`, `cancelling` (ends `cancelled` only after Hermes confirms) and `budget_blocked`. The runner (`server/ai/runner.ts`) is separate from the general worker, leases jobs, and after a restart adopts a started run by its run id instead of starting another.
- **Budget**: $5/day household budget; per-job caps triage $0.03, standard $0.75, deep $2.50. Over budget a job waits (`budget_blocked`) until the next local day or **Run anyway** (audited `ai.budget_override`). Usage: Settings → AI (CSV/JSON export).
- **Capture** (`POST /api/capture`, capture sheet, `/capture`, PWA share with images, HTTP Shortcuts with a capture token): lands in the Inbox, then (with `work.ai`) a cheap **triage** (clean title, kind, suggested area with confidence) and, when worthwhile (confidence ≥ 0.6), an **investigation** report. Inbox rows offer **File under <area> · 82%**, **✦ Report ready**, Investigate. Offline captures wait on the phone and are sent exactly once.
- **AI policy applies to every area, Finance included** (owner-approved 2026-11-07): coordinator/catch-me-up, smart/dynamic cards, Summarize and other actions, schedules/autonomy, MCP, search/context, chat Add context, capture and workflow drafts treat Finance like any area. `settings.aiPolicy` (`allowed` / `triage_only` / `excluded`, "Exclude from AI") still excludes an area and its subtree from every AI path. Credentials/API tokens/passwords remain hard-blocked; full account/card numbers are masked to last 4 before model text leaves. Finance text needs no "Send anyway" confirmation.
- **Report ready** pushes (`ai_report`, on by default, batched above 3 per 10 minutes) are delivered by the standalone push dispatcher even with `JARVIS_DISABLE_WORKER=true`.
- **File it** on an Inbox "Report ready" push files the capture under its triage suggestion without opening Jarvis (`POST /api/work/inbox/:id/file-suggestion`, `work.use`, CSRF header, session cookie; idempotent: a second tap answers "Already filed"; audited `work.inbox_file_suggestion`). The service worker confirms with a "Filed → <area>" notification that opens the new item. Signed out, offline, dismissed, or no live suggestion (409 `no_suggestion`): the tap opens the Inbox entry instead.
- **Remove location from captured photos** (Settings → AI → Captures, off by default): GPS coordinates are removed from JPEG/PNG/WebP metadata before the file is saved (`server/capture/exif.ts`, no re-encode; audit `capture.create` notes `locationStripped`). See [privacy](privacy.md).
- **Retention**: dismissed captures are deleted 30 days after dismissal, with their attachment files and inbox reports, and their AI job parameters are cleared (`server/capture/purge.ts`, run hourly by the standalone dispatcher in batches of 100; audited `capture.purge_dismissed` per entry). Filed captures live on with their item.
