# Scheduled coordinator jobs

Scheduled jobs live in Jarvis, not Hermes cron. The standalone notification dispatcher checks due slots every 30 seconds, even when the general worker is disabled. A process-wide guard starts work asynchronously without blocking push dispatch. Each job uses its own reusable Hermes conversation, filed under its area and routed to that area's coordinator profile (the default Hermes profile when routing is off). Area model/provider defaults take precedence over household defaults.

## Enable a job

Open Settings → Agents → Scheduled jobs. Review its area, prompt, local time and overnight option, then enable it. All new jobs, suggested templates and imports arrive disabled. Templates seed once per owner. Missing/deleted areas need a new selection. Finance and AI-excluded areas cannot run, including Run now.

Schedules use the household timezone when created. Daily, weekdays and weekly schedules are supported; DST follows the shared schedule contract. A slot has a 30-minute grace window. Missed windows are not replayed. A unique `(job_id, slot)` database claim prevents duplicate execution. Run now requires `{ "confirm": true }`, uses a separate minute-scoped slot and ignores quiet hours, but still enforces policy, daily cap and one active run per job. An area cannot be changed and a job cannot be deleted while a run is active.

## Limits

- At most 12 jobs, including disabled jobs.
- Default daily cap: 6 non-skipped runs, by household local date. Internal setting: `away_max_runs_per_day`, positive integer.
- At most 2 starts per dispatcher pass.
- At most 10 proposals from a report; invalid/excess proposals are reported as refused.
- Runs time out after 2 hours. Five consecutive failures switch a job off; the owner can re-enable it.
- Quiet-hour slots are recorded as skipped unless Overnight is enabled. Decision/failure notifications are deferred until quiet hours end. Silent reports never notify.

## Autonomy

| Intent                                                | Propose only               | Act on low-risk                                                             |
| ----------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------- |
| Create note/thread, update next action, file to Inbox | Needs-you decision         | Applied locally, attributed to the agent, undoable from Activity for 7 days |
| Status/assignee, project/link, decision               | Needs-you decision         | Needs-you decision                                                          |
| Settle, abandon, supersede, archive, move             | Owner-only change proposal | Owner-only change proposal                                                  |
| Merge, deploy, spend, send externally                 | Refused                    | Refused                                                                     |
| Any intent in Finance/AI-excluded area                | AI off                     | AI off                                                                      |

The run is instructed to propose, never write with tools. The server validates every proposal target against the owner's live area subtree before writing. It rechecks autonomy when applying the result. Lifecycle changes are never performed. Existing decisions are never overwritten: use the area as fallback, otherwise record a refusal. Inbox captures never trigger recursive AI work, and have Activity undo that dismisses only an unchanged, unfiled capture. Agent tools cannot edit area settings, including autonomy.

## Digest and API

Owner-only JSON endpoints: `/api/agents/schedules` (CRUD), `/:id/run`, `/export`, `/import`, `/api/agents/away` and `/api/agents/away/dismiss`. Schedule endpoints require admin capability in addition to ownership. Exports download as `jarvis-schedules.json`; imports match area titles case-insensitively, dedupe title+area, enforce the cap and never enable a job. Finance/excluded matches import unassigned; missing matches import unassigned with an `area not found` warning.

The digest reconciles active runs (throttled to once per 10 seconds), reads at most 20 non-skipped runs since dismissal (24 hours initially), and counts decisions that are still open. It excludes areas currently unavailable to AI. `NOTHING_NEW` is a silent completion. Reports are capped at 8,000 characters and plain summaries at 600. Runs and policy changes commit together so reconciliation retries do not duplicate writes. Agent-panel rows use the existing registered-run store and heartbeat while reconciling.

Migration: `drizzle/0039_scheduled_jobs.sql` adds `scheduled_jobs` and `scheduled_job_runs` only. No environment, secrets, Hermes configuration or upstream cron changes.
