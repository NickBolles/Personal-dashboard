# Home priorities

Home answers "what should I look at first?" without hiding anything. It runs on
the server (`server/ranking/attention.ts`, `server/ranking/assists.ts`), so the
web app and the phone get the same answer. It is deterministic: the same data,
time and settings always give the same order.

## The attention budget

| Section        | Shows                           | Limit                         |
| -------------- | ------------------------------- | ----------------------------- |
| Now            | what needs you first            | 3, plus every safety alert    |
| Later today    | the next things for today       | 5                             |
| Next two weeks | dated items in the next 14 days | preview of 3, "See all N"     |
| Backlog        | everything else that's open     | counted, paged at `/home/all` |

Cards come from the integration sources and, for people with `work.use`, from
the Work hub: overdue validations and in-progress work due today or earlier
(docs/work.md). Work cards are plain dated cards, so the rules below apply to
them unchanged.

Totals are counted after scoping (what this person may see), dedupe (same
source record) and snoozes, before paging. `now + today + upcoming + backlog =
open`. Nothing is ever completed, rescheduled or deleted by the ranking. Source
outages keep the last-known items (labelled stale or error), so a failing source
never looks like an empty one.

## How items are ordered

Each open item gets one tier. The first that applies wins:

1. **critical**: safety alerts (Home Assistant). Never budgeted away, snoozed, demoted or muted.
2. **awaiting_user**: approvals, reviews and questions waiting on you.
3. **pinned**: pinned by you.
4. **compass**: matches one of today's Daily Compass priorities. All the
   significant words of the priority appear in the title; matching is never fuzzy.
5. **overdue_recent**: due today (time passed) or yesterday, in your timezone.
6. **due_soon**: due within 4 hours.
7. **checkin_window**: a check-in window is open.
8. **today**: due today.
9. **overdue_stale**: two or more days late. At most two fill spare room in Later
   today (most recently due first). The rest go to the backlog, and the overdue
   suggestion offers help.
10. **upcoming**: due within 14 days, or not available yet.
11. **someday**: undated, or further out.

Within a tier: your category weight → due date → most recently changed → id.
Time-based reasons are recomputed from the due date on every request, so a
cached snapshot never shows yesterday's "due today". Date-only due dates use
your local calendar day.

Every item carries `why` (shown under "Why this?" on the web and as "Why: …" on
the phone), e.g. "Due yesterday", "Matches Daily Compass focus “taxes”",
"Shown later: you asked for fewer Todos", "Over the Today limit (5)".

## Daily Compass focus

The Daily Compass status answer may include `priorities` (≤ 5, each ≤ 120
characters; docs/integration-contracts.md). Home reports what it knows in
`attention.compass.state`:

- `focus`: today's priorities, used for ranking.
- `no_focus`: Daily Compass answered, but recorded no priorities.
- `outdated`: the answer isn't for today.
- `unavailable`: no Daily Compass data could be read.

Only people with `daily_compass.use` see any of this; it's the owner's private
check-in. Jarvis never makes up priorities.

## Feedback

Every Home card has controls. All of them are per person, stored in Jarvis only,
and reversible in **Settings → Home priorities**.

| Feedback         | Effect on ranking                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Not now          | hides that card until the time picked (≤ 90 days). Safety alerts are never hidden.                                               |
| Less like this   | category weight −1 (to −2). At −2 the category's non-urgent items leave Now/Today; its suggestions stop.                         |
| Helpful          | category weight +1 (max +1): ranks a bit earlier within its tier.                                                                |
| Not helpful      | that suggestion doesn't come back for 14 days.                                                                                   |
| Wrong assumption | records your correction. Suggestion: hidden until its data changes. Action: kept out of Now until its due date or title changes. |

Categories are `source:<source>` for items and `assist:<kind>` for suggestions.
"Protected" tiers (critical, awaiting_user, pinned, due_soon) aren't moved out
by a −2 weight.

Each feedback row stores compact provenance: version, fingerprint, the reasons
shown and the sources. A fingerprint changes when the item's due date or title
changes, or when the suggestion's underlying data does (e.g. the overdue count
moves to another band). That's how "until it changes" works. Rows are immutable;
you can forget one or reset everything. Requests are idempotent per
`idempotencyKey`, size-limited, CSRF-protected, and only accepted for items whose
source you can see.

Jarvis doesn't claim it has "learned" anything. The only effects are the ones in
this table, and every one shows up in `why`.

## Suggestions

At most two, after Now. They're built only from:

- **Overdue triage**: 3+ overdue tasks you can see. "Review & reschedule" lists
  the reschedulable todos; you tick tasks, pick a date and confirm. Each one then
  goes through `POST /api/actions` (snooze), which only reports success after the
  todo provider reads the new date back. Nothing is preselected.
- **Plan ahead**: dates you saved (Settings → Home priorities → Saved dates,
  private to you), within their lead time. Also birthday or anniversary events
  already on a calendar you can see. Jarvis never guesses a birthday or date.
- **Seasonal**: Christmas gift planning, Nov 1–Dec 20, labelled "Seasonal idea,
  not from your calendar".

"Help me triage" / "Brainstorm ideas" opens a new chat with a draft and a
bounded context block (≤ 1500 characters, never finance). The draft says it's
read-only planning. Nothing runs until you press send. Home never waits on a
model, and there's no background inference or schedule.

## For Hermes: reading and tuning feedback

Hermes doesn't call Jarvis, and it never edits Jarvis code or settings. The
authorized path is the person's own chat:

1. In Settings → Home priorities, **Tune with Hermes** opens a chat with a
   summary attached: budget, tiers, category weights (finance excluded),
   snooze/saved-date counts and up to 10 recent corrections.
2. Hermes reads it and suggests concrete changes ("set Skylight to −1", "save
   Mar 3 as Cassidy's birthday, 45 days ahead").
3. The person applies them in Settings → Home priorities.

Corrections are the person's own notes. They are only sent when that person
opens the chat. A person's feedback and saved dates are never shown to anyone
else in the household.

## API

| Route                                                              | What                                                             |
| ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `GET /api/home`                                                    | payload with `attention` (budget, totals, compass) and `assists` |
| `GET /api/home/items?bucket=&offset=&limit=`                       | one bucket, ranked, paged (limit ≤ 100)                          |
| `POST /api/home/feedback`                                          | feedback (see above)                                             |
| `DELETE /api/home/feedback/:id`                                    | forget one of your feedback rows                                 |
| `GET/PUT/DELETE /api/home/tuning`                                  | your weights, hidden items, recent feedback; set a weight; reset |
| `GET/POST /api/home/milestones`, `DELETE /api/home/milestones/:id` | saved dates                                                      |
