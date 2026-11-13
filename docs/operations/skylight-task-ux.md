# Skylight task UX: provider evidence and acceptance

## Native Skip, not a local substitute

Read-only inspection on 2026-11-10 of Skylight's current public web bundle:
`https://ourskylight.com/_expo/static/js/web/index-4fd04024c1b984317fd4e053d6b411b4.js`.

The `updateTaskStatus` client calls `PUT /frames/${frameId}/chores/${seriesId}/completions` with flat fields `status`, `instance_date`, `instance_time`, `category_id`, `completed_on`. Its detail-screen Skip action transitions pending → skipped, skipped → pending, complete → skipped. Its caller includes occurrence date for recurring tasks, instance time from taskUtils, and only supplies category for up-for-grabs complete/pending (not skipped). The mutation function derives series id from the occurrence id before calling this endpoint. Thus native Skip is supported; Undo is pending on the same occurrence, not a series update. `completed_on` is included by the native client for both complete and skipped: that field alone never proves completion.

Cross-check: chrischall/skylight-mcp `CLAUDE.md` live-verifies PUT completions, flat status complete/pending, and omitting category on assigned chores (422 otherwise). The local reusable Skylight skill's `scripts/skylight-lib.mjs` uses one version header, JSON Accept and Bearer authorization. Jarvis keeps its existing version rather than changing integration config for this UX batch. Current web client advertises 2026-10-15; this is evidence, not permission to change deployed config.

## Scope

- Intentional user completion / Skip clicks execute immediately with Undo; no additional modal for these two actions. No automated provider writes.
- Skipped remains distinct from complete through source snapshots, filters, counts and While you were away.
- Hide only future DAILY recurrence in presentation, with an explicit reveal. Keep source rows, today's chores, overdue chores and future non-daily work.
- Recurring writes and Undo target the same date/time instance with correct category handling.
- Strict mock tests must reject invalid method/path/body and distinguish pending, complete and skipped even when completed_on is present.

## Read-only live shape check

A fresh read-only provider inspection returned 82 chore rows: 79 pending, 3 complete. Recurrence data was `recurrence_set: array` on 56 rows; **no `rrule` attribute was present**. Frequencies in those arrays: 33 DAILY, 13 WEEKLY, 9 MONTHLY, 1 YEARLY. Therefore daily filtering must parse `recurrence_set` (optionally support `rrule` as compatibility), not only `rrule`. Scheduled `start` was a string on all 82; `start_time` a string on 42. No titles, personal item text, credentials or tokens were printed. No chore mutations were performed.

## Verification limits

No real Skylight mutation is authorized for tests. Native client inspection proves request semantics, not an end-to-end owner-account write smoke. Report owner completion/Skip/Undo smoke as unverified until deliberately performed by the owner.
