# Work hub

A private place to organize AI-assisted work: where a conversation belongs, what was handed off, which PR implements it, and whether the outcome was actually achieved. Background: the conversation-platform PRD (P0 tree/lifecycle/handoff/validation, P1 timeline and dashboard, P2 map). Single owner per row, no AI calls, GitHub read-only. Phase 1 was the vertical slice; phase 2 added conversation filing, handoff into a new conversation, automatic PR/issue refresh, drag-and-drop, undo, timeline editing and dependencies, validation templates, the map, Home cards and dashboard upgrades.

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
- **PR merged** (a linked `github_pr` with role `implementation` whose state becomes `merged`, manually or via refresh), `onImplementationMerged`:
  - the latest packet requires validation (**default when there is no packet**), or any validation is `pending` or `fail` → `awaiting_validation`;
  - otherwise → `settled` with `settled_kind = auto` and reason "PR #n merged; no validation required", shown with an **Auto-settled** badge and a one-click Reopen.
  - Closed items (settled/superseded/abandoned) are left alone; reference PRs never change state.
- **Validation**: recording an observed value computes pass/fail with the comparator (`=` uses a tiny relative tolerance). A waiver needs a reason.
- **Settle** (`settleGate`): every validation is `pass` or `waived`, and if the latest packet requires validation there must be at least one. Failing validations offer "Reopen with failed evidence".
- **Reopen** needs a reason, clears settlement, and can create a follow-up child (`handoff_from`). Always available on settled work.
- Every status change writes a `work_events` row and an audit entry (`work.status`); other mutations audit as `work.*`.

Stricter than the brief, deliberately: a _failed_ validation also blocks auto-settle, and a packet that requires validation can't be settled with zero validations (otherwise "all validations pass" would be vacuously true).

### Validation templates and overdue

- Templates are per person (`GET/POST /api/work/validation-templates`, `DELETE …/:id`): metric, comparator, threshold, unit and an optional due offset in days. **Add from template** (`POST /api/work/items/:id/validations/from-template`) adds a pending validation via `applyTemplate` (due date = today + offset). "Also save as a reusable template" on the add form stores the due date as an offset from today. Nothing is seeded.
- A validation is **overdue** (`isValidationOverdue`) when it's `pending` and its due date is before today. It's highlighted on the item (badge, red border, a banner and a "Validation overdue" chip in the header), marked with "!" on the timeline, counted by the **Validation overdue** dashboard widget, and puts a card on Home (below).

## GitHub (read-only)

Paste a PR or issue URL; Jarvis parses `owner/repo/number` (`parseGithubUrl`) and stores state `open`. "Mark merged" / "Mark closed" (PRs) and "Mark closed" / "Mark open" (issues) set it by hand.

If `JARVIS_GITHUB_TOKEN` is set on the server:

- **Refresh** on a link does one `GET https://api.github.com/repos/{o}/{r}/pulls/{n}` (or `/issues/{n}`; 6 s timeout).
- **Automatic refresh** happens when an item is viewed and when the dashboard loads (`POST /api/work/github/refresh {itemId?}`; the worker is not involved and stays disabled). Rules (`server/work/refresh-rules.ts`, pure): only GitHub PR/issue links with a URL; a merged PR is final and never re-read; at most once per link per 5 minutes; at most 10 links per request, oldest check first; at most 4 requests in flight (`boundedAll`). Each due link is claimed first with a conditional update on `checked_at`, so concurrent requests never read the same link twice.
- Results go through `setLinkState`, which ignores an unchanged state, so the merge lifecycle rule applies **exactly once** per transition. Events from a readback have `source = github` (shown with a GitHub badge in Activity). A failed readback is stored on the link ("GitHub check failed …") and doesn't block anything.

The token never reaches the browser and Jarvis never writes to GitHub. Without a token, nothing automatic happens: the Refresh button is hidden, a hint is shown, and the manual controls work as before.

## Timeline (`/work/timeline`)

Rows are a chosen area/project (or all areas), depth-indented. Bars run start → target in the status colour (a diamond when only one date exists); markers show when work actually started (first `in_progress`), PR merges and settlement, all from `work_events`. A red line marks today; overdue items (target passed, not closed) get a red outline; overdue validations get a "!" marker. Zoom weeks/months; "Show as table" is the accessible equivalent. Rows link to the item.

- **Editing**: drag a bar to move it, or drag either end to change that date (pointer events, snapped to whole days, never past the other end: `shiftDates`). The table's **Edit dates** opens a form (the keyboard alternative); the item's Details form works too. Every date change writes a `dates` event ("Dates: start A → B, target C → D").
- **Dependencies** (`POST /api/work/items/:id/dependencies {dependsOnId}`, `DELETE /api/work/dependencies/:id`): "this item depends on that one". Self-dependencies and loops are refused (`wouldCreateDependencyCycle`). They're drawn as connectors from the blocker's end to the dependent's start (dashed when the dependent starts before the blocker ends). The item shows **Blocked by** / **Blocks** with statuses and a "Blocked" chip while a blocker isn't closed; the table shows "Blocked".

## Map (`/work/map`, read-only, P2)

An optional orientation view (a Map tab; the tree stays the default and the only place to edit). `GET /api/work/map?root=` (`server/work/map.ts`) returns up to 300 visible items of an area/project (or everything) and their edges: containment, lineage (`forked_from`, `split_from`, `handoff_from`; moves are placement history and aren't drawn) and dependencies. `lib/work-map.ts` lays it out deterministically (`layoutMap`: depth = row, leaves take consecutive columns in depth-first sort order, parents centred over their children; the same graph always gets the same picture whatever order it arrives in). Pure SVG: drag the background to pan, zoom with the buttons or the wheel, **Fit** to see everything. Filters: relation types and status. Selecting a node opens the item. **Show as list** is the accessible alternative (nested list with each item's cross-links).

## Dashboard (`/work/dashboard`)

Native widgets are computed server-side from work data only (`server/work/dashboard.ts`): Priorities (ready/in progress by target date), Next actions, Awaiting validation (pending/failed/overdue counts), Recently settled (auto-settled badge), Timeline slice, Project map (read-only outline of an area/project), Metric (manual value/label/target + optional http(s) or Jarvis link), **Validation overdue** (count and the items), **Unfiled conversations** (loaded by the widget from the conversations API; needs `hermes.chat`), **Map snapshot** (a small fitted map of an area/project linking to `/work/map`).

Edit mode adds, configures and removes widgets, resizes them (S/M/L buttons) and reorders them by dragging the grip (`PATCH … {position}`) or with the ↑/↓ buttons (the keyboard way). With `JARVIS_GITHUB_TOKEN`, loading the dashboard also triggers the throttled GitHub refresh.

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

## Not yet

AI triage/summaries, inbound GitHub webhooks, GitHub writes, sharing, packet accept/reject, redo, editing from the map, Android screens (the Android app is untouched: `work` search results and Home cards there have no native route, and the Android source label map has no "Work" entry, so the label is omitted).

Rollback: remove the `work.use` capability; the tables are additive and nothing existing is rewritten.
