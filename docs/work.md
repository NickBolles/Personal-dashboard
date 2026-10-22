# Work hub

A private place to organize AI-assisted work: where a conversation belongs, what was handed off, which PR implements it, and whether the outcome was actually achieved. Background: the conversation-platform PRD (P0 tree/lifecycle/handoff/validation, P1 timeline and dashboard). V1 is a vertical slice: single owner per row, no AI calls, GitHub read-only.

Access: capability `work.use` (adults by default; admins have everything). Pages call `requirePage("work.use")`, every route passes `cap: "work.use"`, and every query is scoped to the signed-in person: other people's rows are "not found".

## Model (`server/db/schema.ts`, migration `drizzle/0008_work_hub.sql`)

| Table                             | What                                                                                                                                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `work_items`                      | Tree node. `parent_id` null = top-level **Area**; kinds `area · project · thread · investigation · note`. Title, summary, next action, status, order, planned start/target, settlement fields, archived. |
| `work_links`                      | `chat_session` (Hermes or Claude-direct id, opens `/chat/<id>`), `github_pr`, `github_issue`, `url`; role `source · implementation · evidence · reference`; `external_state` `open · merged · closed`.   |
| `work_lineage`                    | Append-only `forked_from · split_from · moved_from · handoff_from` edges (moves record from/to parent).                                                                                                  |
| `work_packets`                    | Immutable, versioned handoff snapshots (objective, scope, acceptance criteria, decisions, open questions, context, validation required or a reason it isn't).                                            |
| `work_validations`                | Metric, comparator (`<= >= < > =`), threshold, unit, baseline, observed, evidence link/notes, status `pending · pass · fail · waived`, waiver reason, due date.                                          |
| `work_events`                     | Append-only activity: status transitions (from → to, reason, actor, time), merges, links, packets, validations. Feeds Activity and the Gantt "actual" markers.                                           |
| `dashboards`, `dashboard_widgets` | One dashboard per person; ordered widgets with kind, title, size (`sm · md · lg`) and JSON config.                                                                                                       |

A built-in **Miscellaneous** area is created lazily per person (`system_key = "misc"`); non-area items created without a parent land there. It can't be archived or moved.

## Tree operations

- Create child, rename / edit summary, next action and dates, reorder (up/down among siblings), archive/unarchive (archiving hides the whole branch unless "Show archived").
- **Move**: any item under any other item you own; only areas may sit at the top. Cycles are refused (`wouldCreateCycle`). Records `moved_from` lineage. Moving never touches history.
- **Fork**: a new sibling copying title/summary/next action and `source` links, with `forked_from`. If the item has a linked conversation the dialog offers "Open conversation to fork there"; Jarvis never forks the Hermes session itself.
- **Split**: a new child from a title + summary excerpt, `split_from`; the source is untouched.

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

## GitHub (read-only)

Paste a PR URL; Jarvis parses `owner/repo/number` (`parseGithubUrl`) and stores state `open`. "Mark merged" / "Mark closed" set it by hand. If `JARVIS_GITHUB_TOKEN` is set on the server, a **Refresh** button does a single `GET https://api.github.com/repos/{o}/{r}/pulls/{n}` (6 s timeout) and applies the result through the same merge rules. The token never reaches the browser and Jarvis never writes to GitHub. Without a token the button is hidden and a hint is shown.

## Timeline (`/work/timeline`)

Rows are a chosen area/project (or all areas), depth-indented. Bars run start → target in the status colour (a diamond when only one date exists); markers show when work actually started (first `in_progress`), PR merges and settlement, all from `work_events`. A red line marks today; overdue items (target passed, not closed) get a red outline; pending validations past their due date get a "!" marker. Zoom weeks/months; "Show as table" is the accessible equivalent. Rows link to the item.

## Dashboard (`/work/dashboard`)

Native widgets are computed server-side from work data only (`server/work/dashboard.ts`): Priorities (ready/in progress by target date), Next actions, Awaiting validation (pending/failed/overdue counts), Recently settled (auto-settled badge), Timeline slice, Project map (read-only outline of an area/project), Metric (manual value/label/target + optional http(s) or Jarvis link). Edit mode adds, configures, reorders and removes widgets.

### Custom HTML widget security model

- Rendered **only** as `<iframe sandbox="allow-scripts" srcdoc="…">` (`CustomHtmlWidget`). Never `allow-same-origin`, never `dangerouslySetInnerHTML` in the app document. The frame has an opaque origin: no Jarvis cookies, no storage, no same-origin API access, no top navigation, popups or forms.
- `buildCustomWidgetSrcdoc` puts this CSP meta first in `<head>`, before any author markup (later policies can only tighten it):
  `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:` — so no network at all (fetch/XHR/WebSocket, remote images, fonts, frames).
- HTML is limited to 100 KB (validated in the API and in the builder).
- Optional data: when "Send this widget a read-only snapshot" is on, the parent posts `{ type: "jarvis.work.snapshot", data }` to the frame after load. `data` holds only titles, kinds, statuses, depth, dates and next actions of the chosen area — no links, URLs, tokens or finance. The parent never listens to messages from the frame, so the widget can't call Jarvis.
- The widget is labelled "Custom HTML (sandboxed)".

E2E (`e2e/work.spec.ts`) proves the attributes, the CSP, that `parent.document`, cookies, storage and `fetch` are blocked inside the frame, and that the snapshot arrives.

## Search

A `work` provider in `server/search.ts` matches title, summary and next action and links to `/work?item=<id>`.

## Not in V1

AI triage/summaries, inbound GitHub webhooks, sharing, packet accept/reject, dependencies, drag-and-drop, undo for structural operations, Android screens (the Android app is untouched; `work` search results there have no native route).

Rollback: remove the `work.use` capability; the tables are additive and nothing existing is rewritten.
