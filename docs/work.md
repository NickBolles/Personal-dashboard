# Work hub

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

## Tree operations

- Create child, rename / edit summary, next action and dates, reorder (up/down among siblings), archive/unarchive (archiving hides the whole branch unless "Show archived").
- **Move**: any item under any other item you own; only areas may sit at the top. Cycles are refused (`wouldCreateCycle`). Records `moved_from` lineage. Moving never touches history.
- **Drag and drop** (`WorkTree`, pointer events: mouse, pen and touch): each row has a grip. Drop on the top or bottom quarter of a row to place before/after it (reorder or re-parent to that row's parent), on the middle to put it inside. Esc cancels; drops into the item's own subtree, notes, or non-areas at the top level are refused. `POST /api/work/items/:id/place {parentId, index}` re-checks everything (`planPlacement`, cycle-safe) and records `moved_from` when the parent changes. The keyboard equivalents stay: the item menu's **Move up**, **Move down** and **Move…**.
- **Fork**: a new sibling copying title/summary/next action and `source` links, with `forked_from`. If the item has a linked conversation the dialog offers "Open conversation to fork there"; Jarvis never forks the Hermes session itself.
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

### Continue in a new conversation

From the packet card, **Continue in new conversation** opens a dialog with the handoff preview and the same Hermes/Claude choice as the new-chat UI (`useAssistantChoice` / `BackendSwitch`). `POST /api/work/items/:id/continue {backend}` creates the conversation through `server/assistant` `createSession`, links it as a `source` with `lineage = handoff_from` and the latest packet's id, and writes an event ("Continued in a new conversation (handoff from packet vN)"). The browser stores the handoff Markdown as that conversation's composer draft (`draft:<id>`, the composer's own draft store) and opens it: **nothing is sent until the person presses Send**. The Activity tab lists these handoffs.

## Lifecycle (`server/work/lifecycle.ts`, pure and unit tested)

Statuses: `captured, exploring, ready, in_progress, in_review, awaiting_validation, settled, reopened, on_hold, superseded, abandoned`.

- `ready` and `in_progress` require a non-empty next action.
- **Start focused work** writes packet v(n+1) and moves the item to `ready` or `in_progress` (setting the start date if empty). Packets are never edited; "New revision" makes the next version. "Copy handoff" produces Markdown (objective, state, decisions, open questions, next action, validations, links) for Hermes/Discord.
- **PR merged** (a linked `github_pr` with role `implementation` whose state becomes `merged`, manually, via refresh, the poller or a webhook), `onImplementationMerged`:
  - the latest packet requires validation (**default when there is no packet**), or any validation is `pending` or `fail` → `awaiting_validation`;
  - otherwise → **`ready_to_settle`** ("Ready to settle"), and the item shows a **"PR merged — settle?"** prompt with **Settle now**. Today lists these too.
  - **Auto-settle: never** (owner decision). No code path writes `settled_kind = auto` any more; settling is always the person's action and records `settled_kind = manual`. Rows auto-settled before phase 3 stay readable with an **Auto-settled (legacy)** badge. We chose a dedicated status over "`in_review` + a prompt" because it is explicit in lanes, filters, Today and the KPI strip, and it is a normal open status (settle, reopen or move it like any other).
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
