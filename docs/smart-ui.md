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

Streaming partial render of a block (the block shows "Preparing an interactive reply…" until the fence closes). Keyboard map (j/k/x/d/w/s). `smart.applyMode = instant`. Form, ChoiceChips, Timeline, FanOut, ReviewList. Export of surfaces. Android renderer (PR 2, skipped for now). Catalog v1.1 ideas (WeekPlan, PRCard, Gantt, metric gauges): see the phase 6 spec §12a.
