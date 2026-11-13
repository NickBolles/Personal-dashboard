# Capture AI triage

Owner request (2026-11-12): every capture is looked at by AI to see whether Jarvis can resolve it.

## Pipeline

1. **Capture** (`POST /api/capture`, palette/tray/widget/phone/share) is saved immediately and never blocked.
2. **Triage job** (`ai_jobs` kind `triage`, prompt `triage@2`) runs in the background on the existing AI runner
   (Hermes connection budget, subscription meter, per-area agent routing — no new provider keys). The prompt gets
   the destinations, the owner's Skylight lists (`id — label (kind)`, from the cached snapshot) and today's date.
   The output keeps the filing suggestion and adds an `action` block (`lib/capture-triage.ts triageActionSchema`).
3. The runner stores the **validated** action in `capture_triage` (one row per capture, unique `inbox_id`)
   and wakes the applier (`server/hooks.ts`; the dispatcher task `capture_triage_apply` every 15 s is the fallback).
4. The **applier** (`server/capture/triage.ts`) gates it with the pure `decideTriage`:

| Outcome            | When                                                                                                                                                  | What happens                                                                                                                                                                                                                                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Done (auto)        | low-risk + reversible + confidence ≥ 0.75 + allowed: Skylight list add, Skylight calendar event (date AND time, or all-day), Jarvis to-do             | Done through the existing write paths (`runSkylightWrite` + `recordWrite` = same audit/Undo as UI writes, 12 writes/min; `createItem`/`updateItem`), inside `withVia("agent:<profile>")`. The capture becomes a **ready_to_settle** item "Done: added “X” to Groceries on Skylight" with Undo (24 h) and Correct. Never settled. |
| Needs you          | something essential is missing (an appointment without a date/time)                                                                                   | The capture becomes an item with ONE D-n decision (choices: add it to a Skylight to-do list, keep it as a Jarvis to-do; never a guessed date). Answering a choice runs it (owner consent).                                                                                                                                       |
| Suggested          | risky or outside the allowlist: devices (HA), messages, purchases, finance, deletes; or triage-only mode / allowlist off / low confidence / back-fill | Shown on the inbox row only; nothing is done. Low-risk suggestions get "Do it" (owner confirm); risky ones never.                                                                                                                                                                                                                |
| (left as captured) | a note/idea, or auto-handle off                                                                                                                       | The existing one-tap filing suggestion stays.                                                                                                                                                                                                                                                                                    |

Every outcome that changes something registers an agent run (R-n, `delegationId capture:<inboxId>`), so it shows in
Activity and Chief of staff Running/Changes. Failures leave the capture as captured with "Triage failed · Retry".

## Owner controls

Settings → AI → Captures: **Auto-handle captures** (default on), **Triage only, never act**, allowlist chips
(Skylight list items, Skylight calendar events, Jarvis to-dos). Stored in `ai.settings.capture.actions`
(absent = defaults). Per-area **Exclude from AI** is honoured (excluded areas are never destinations and captures
filed into them are skipped); credential-looking captures are never sent; HA rules unchanged.

## Back-fill

Once (`settings` key `capture_triage:backfill:v1`): open captures of the last 14 days are triaged again. Back-filled
captures are only acted on when they name the target system ("… on Skylight"); everything else becomes a suggestion.

## API

- `GET /api/capture/triage?item=<id>` → `{ triage }` (item page card)
- `POST /api/capture/triage/<id>/undo` · `/retry` (id = triage row or inbox entry) · `/apply` ("Do it")
- Inbox entries carry `capture.triage` (`CaptureTriageView`).
