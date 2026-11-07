# Smart replies (`jarvis-ui@1`)

Phase 6, slice 1. Hermes replies that are really workflows (triage, a choice, a checklist) carry a fenced ` ```jarvis-ui ` JSON block. Jarvis renders it as interactive UI with [json-render](https://github.com/vercel-labs/json-render) on the web. Nothing is written until you tap **Apply N changes**, and every applied change has **Undo**.

Off by default, per person: **Settings → Smart replies**. When it's off, or in clients without the renderer (Discord, the current Android app), only the text outside the block is shown.

## Pieces

| Where                                                                                    | What                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/jarvis-ui/catalog.ts`                                                               | The closed catalog (zod, strict props): Stack, Section, Text, Callout, Divider, TaskList, DecisionCard, Checklist, Gauge, Table, ItemRef. Limits (64 KB block, 200 elements, depth 8, 3 blocks/message, 100 rows) |
| `lib/jarvis-ui/parser.ts`                                                                | Splits assistant text into markdown + blocks. Never throws on a cut-off stream                                                                                                                                    |
| `lib/jarvis-ui/validator.ts`                                                             | Validates a block, drops unknown/invalid elements, returns the canonical spec. Unreachable elements are removed                                                                                                   |
| `lib/jarvis-ui/intents.ts`                                                               | Action allowlist + `intentInSpec` (server binding check)                                                                                                                                                          |
| `server/smart/*`                                                                         | Settings flag, hydration, surface store (`ui_surfaces`, migration 0021), apply/undo, `@ctx:` context refs, the run instructions (`prompt.ts`, ≤ 2.5 KB, snapshot-tested)                                          |
| `components/smart/*`                                                                     | `AssistantText` (used by the chat timeline and live run), `SmartSurface` (hydrate, change tray, apply, undo), `registry.tsx` (catalog → React)                                                                    |
| `/api/smart/settings` · `hydrate` · `surfaces` · `surfaces/:id/state` · `apply` · `undo` | All `api()` routes with CSRF, capability checks and audit on writes                                                                                                                                               |

## Flow

1. The web client declares `capabilities: ["jarvis-ui@1"]` on every run. If the person has smart replies on, the runs route appends `smartInstructions()` to the run's `instructions` (next to the area instructions).
2. The model copies refs from the context (`todo:<id>`, `item:<id>`) and never restates titles. `@ctx:overdue_todos` in the attached context is resolved server-side at send time to **all** overdue todos (cap 100, ≤ 8 000 chars, titles shortened before rows are dropped). This replaced the old pasted list that stopped at "…and N more".
3. On render, the client validates the block, `PUT /api/smart/surfaces` stores the canonical spec (keyed by its sha256, so the live stream and the transcript share one surface), and `POST /api/smart/hydrate` returns live titles, due dates and status. Unknown, foreign and Finance refs come back `unavailable` and get no actions.
4. Row actions and decision options **stage** intents in the surface's tray. **Apply** sends them in one `POST /api/smart/apply` (idempotency key per tray version). Results are per intent; failures stay staged with the error.
5. Applied entries (with what undo needs) are stored on the surface, so reopening the conversation shows the applied state on any device. **Undo** reopens or re-snoozes a todo, reverts an item patch, or archives an item the surface created.

## Intents (slice 1)

| Intent                                                      | Write                                                                            | Undo                                 |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------ |
| `todo.complete {ref}`                                       | adapter complete, readback                                                       | reopen (readback)                    |
| `todo.snooze {ref, date}` — date within today…+365 d        | adapter snooze, readback                                                         | snooze back to the previous due date |
| `todo.drop {ref, note?}`                                    | complete + audited `todos.drop` (local todos get a "Dropped" note). Never delete | reopen                               |
| `todo.promote {ref, parentRef}`                             | create a work item under the parent                                              | archive it                           |
| `item.update {ref, patch: status?/nextAction?/targetDate?}` | `updateItem` (status can never be `settled`/`ready_to_settle`)                   | restore previous values              |
| `item.create {parentRef, title, …}` (≤ 20 per apply)        | `createItem`                                                                     | archive it                           |

There is no delete, settle or merge intent.

## Server checks on apply (all before any write)

- The intent parses against the allowlist schema.
- The person has the capability (`todos.edit` for todos, `work.use` for items).
- `intentInSpec`: the **stored** spec offers this exact intent, or one within its declared bounds (row action, suggestion or decision option). A forged intent → **400 `not_offered`** for the whole batch.
- Every ref hydrates for this person. Finance (or `aiPolicy=excluded`) items → **403 `finance_excluded`**.
- Rate limit: 120 applies per hour per person.

## Not in slice 1

Streaming partial render of a block (the block shows "Preparing an interactive reply…" until the fence closes). Keyboard map (j/k/x/d/w/s). `smart.applyMode = instant`. ChoiceChips, FanOut, ReviewList. Export of surfaces. Android renderer (PR 2, skipped for now).

## Smart UI v2

The web renderer uses the flat v2 board chrome: one hairline, 12px radius, mono component tag, bold label, muted metadata and a bottom change tray. Shared styles live in `components/smart/smart.css` inside `@layer components`. Existing chat, brief, plan and coordinator surfaces share the same renderer and safety pipeline.

New strict catalog components (all reject unknown props, URLs, HTML and styles):

| Component      | Props and bounds                                                                                                                                                                               | Behaviour                                                                                                                                                                                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DecisionMatrix | `{title, ref: item:…, criteria:[{id,label,weight:1–3}], options:[{id,label,consequence?,scores:{criterionId:1–5}}]}`; 2–6 unique criteria, 2–4 unique options, exactly one score per criterion | Totals/recommendations recompute locally. Scores are labelled model estimates. Weights stay local. Choosing an option stages exactly `item.update{ref,patch:{nextAction:"Decided: <label>"}}`; server binding rejects any other patch.                                          |
| Gantt          | `{title,rows:[{ref:item:…,start?:YYYY-MM-DD,milestone?:boolean}],from?,to?}`; 1–30 rows                                                                                                        | Hydrated title/status/target/created date only. Start defaults to created date, then target minus seven days. Done/late/milestone/today markers; labelled date inputs are the keyboard/touch rescheduling alternative. Dates must fit the displayed bounds AND today…+365 days. |
| BarChart       | `{metric:metric:…,label?}`                                                                                                                                                                     | Same Jarvis-only series as Sparkline: `ai_spend_7d`, `items_done_14d`. Day labels, accessible summary and expandable values table. Missing/non-series metrics say Unavailable; no Finance series.                                                                               |
| ApprovalQueue  | `{title?}`                                                                                                                                                                                     | Server hydration of `approvals:pending`: owner's open decisions, pending Hermes approvals and durable staged surfaces, with Finance excluded. Navigation only; approve/deny/answer stays in the existing flows.                                                                 |
| Form           | `{title,fields:[{id,label,kind,options?,required?,proposed?}],submit:{label,creates?,updates?}}`; 1–12 unique fields                                                                           | Kinds: text, textarea, scale (1–5), choice (`options:[{value,label}]`), toggle. Proposed values show dashed provenance. Submit stages, never writes. Apply opens a confirmation, then supports Undo.                                                                            |

Form `creates` is an array (at most three) of bounded templates:

    {parentRef:"item:…", titleField:"field_id", splitLines?:true, maxItems?:1|2|3}

For an owner-selected destination, replace `parentRef` with `parentField:"choice_field_id", parentRefs:["item:…"]`. The selected parent must be in that stored list. Only declared text/textarea fields can supply titles. Newline splitting strips optional numbered-list prefixes. Titles are plain text, nonempty and at most 200 characters. `updates` contains at most twelve exact inline `item.update` intents, never settle/delete/merge. Apply enforces the aggregate declared create limit as well as the existing global limit, capability, ownership and Finance guards. Field renderers use the same `inputCls`/label/provenance conventions as run forms (whose private renderers use a different binding contract).

Staged intents are saved as surface UI state, validated again when restored, and exposed as navigation-only pending rows. Applied history remains server-owned. After Apply, a 10-second inline Undo acts on the latest applied batch; Ctrl/⌘+Z invokes it only outside text fields/contenteditable and only for the most recent surface. Per-row Undo remains available after that window.

## Jarvis-built dynamic tray cards

`GET /api/smart/dynamic` requires `work.use` and the instance owner's identity. Smart replies off returns no cards. It uses fixed templates and configured cached source data: no model, code execution, Finance or new external write paths. Specs are validated and stored via the existing surface store; each period's stored spec is immutable. The response is `{today,cards:[{id,kind,line:{tone,dot,icon,label,text},spec,sessionId,blockIndex,action,footer?,garage?}]}`.

Ranking: garage → calendar overlap → weekly review → chores. Failing runs and Needs you always win over dynamic cards; otherwise the top non-snoozed card replaces idle/running/done. The phone tray retains the accessible name Chief of staff and opens inside its native coordinator sheet; desktop opens in the coordinator rail. Not now snoozes that card id for the household day in browser storage.

- Weekly review: Friday noon through Sunday, household/frame-local timezone. ISO week is keyed by its Monday, including year boundaries. Wins use completed work-item titles only. Overdue items populate What slipped. The owner chooses a destination and supplies up to three newline-delimited next-week items. Successful Apply persists completion in settings KV; Undo reopens the review. No migration.
- Chores: configured Skylight normalized chore actions, today's completed rows and open up-for-grabs rows. Read-only; Open Skylight navigates to the existing module.
- Calendar conflict: overlapping timed events today/tomorrow from the existing Skylight/HA read snapshots. The timeline and choice stage only call-task creates, due tomorrow. No calendar writes.
- Garage: configured HA `cover.*garage*` exceptions, open for at least thirty minutes or after 21:00. Close appears only when `close_cover` is allowlisted and the user has door-control capability. It fetches current control/stateToken, asks for explicit confirmation, and uses the existing `/api/home-assistant/control` readback path. Reopen Undo is offered only when `open_cover` is also allowlisted, with its own confirmation; otherwise the UI says no Undo is available. The allowlist is never changed.

Absent/unconfigured source data produces no card, not invented values. HA controls require a fresh source snapshot. Weekly review is skipped when there is no eligible non-Finance destination. E2E specs which turn Smart on stub the default dynamic response empty; dedicated v2 fixtures opt into cards so unrelated tray baselines remain unchanged.

Today mounts the same `/api/smart/workflows` brief inline when Smart replies are on, lazy-loaded and collapsed to the first section on phones with Show all. Plan the week remains a compact link. Smart-off Today is unchanged.
