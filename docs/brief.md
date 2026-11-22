# Daily brief

`/brief` is one page that says what matters most today and what to start with. Home (docs/home-priorities.md) stays the structured, deterministic list of what needs you. The brief is the opinionated read on top of it: it weighs what you said in your check-ins and your notes against what is merely due.

Owner request 2026-11-19. Private to each person (`brief.use`, admin only by default). Off by default: until you turn the AI brief on, the page is built by rules and nothing is sent anywhere.

## What you see

| Part            | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sky             | The top of the page follows the time of day (dawn, day, dusk, night; stars at night), read from the browser clock in the household timezone. An arc from 6 AM to 10 PM shows where the day stands, with today's calendar marked on it. On a phone it runs edge to edge; from the tablet tier it is a panel.                                                                                                                                                                                                                                                                                                      |
| Headline + lead | The day in one line, and why. The headline arrives a word at a time, once per brief.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Right now       | A few facts under the lead, recomputed each minute from Jarvis' own data, never by a model: the meeting you are in or the next one ("Dentist in 36 min"), how long you are clear, and how many picks are done.                                                                                                                                                                                                                                                                                                                                                                                                   |
| Safety          | Open safety alerts the picks left out. Always shown, whatever the model chose.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Today           | The picks as one numbered path. The first one still open is the one to be on now: it opens up with its reason, the smallest first step and the page's one primary action. When it is done it is checked and the next pick opens; when all are done the heading says so. Up to five picks.                                                                                                                                                                                                                                                                                                                        |
| Next up         | A row of two cards: **Urgent** (the big rocks you named for today in your check-in, then the rest of now, later today and overdue that is not a pick; five shown) and **Decisions** (waiting on you). Each card shows its first few and how many there are, and links to the rest.                                                                                                                                                                                                                                                                                                                               |
| Insights        | A carousel written by the model: Noticed (an insight), Idea, Honest take (a call-out), in that order, then anything a build proposed to remember about you (a value, principle, driver or pattern: keep it or say it isn't true; dashed teal until kept). Cards carry their tone as a wash of light and say what they rest on ("From your workouts"). Cards keep their own height and the row is as tall as the ones showing, easing to the new height as you swipe. Small things to do (up to three) sit behind a fold ("3 steps") and can be ticked off. A question is one row that opens a chat to answer it. |
| Initiatives     | A row of two cards: **Habits** (workouts this week, the daily check-in and its streak) and **In progress** (projects and investigations under way, with their next action).                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Coming up       | A row of two cards: **On the calendar** (tomorrow and the rest of the week, and saved dates within 30 days; one that falls today leads the card; no page holds these, so "N more" unfolds the rest in place) and **Low priority** (the backlog, as ranked).                                                                                                                                                                                                                                                                                                                                                      |
| Your day        | Written cards about the day (Focus, Watch, Nudge, Not today, Momentum, Tonight) and the widgets. In the evening Tonight and the check-in lead.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Widgets         | Filled by Jarvis from its own data: Your day (today's calendar), Training (workouts per week), Trend (14 days added vs completed), Household (exceptions), Coming up (saved dates), Daily Compass. The model only places them.                                                                                                                                                                                                                                                                                                                                                                                   |

Home shows a one-line door to the brief (headline and what to start with) once the AI brief is on. Reading the brief or Home never calls a model.

## The brief is Home

Owner decision 2026-11-21. Once you turn the AI brief on, `/home` (the Today tab) is the brief. Until then, and at `/home?view=list`, Home is the ranked list, which keeps everything it could do (completing in place, overdue triage, suggestions, counts); the brief links to it ("List view", "All of Home") and the list carries a door back. `/brief` shows the same page either way.

As Home, the brief also does what Home did for its sources: the same live read refreshes them each minute, a stale, failing or signed-out source is named in a banner (never shown as empty), and "While you were away" and "Pick up where you left off" sit under the cards.

Rows are carousels: one card wide on the cover screen with the next one peeking in, two across when unfolded; swipe, use the arrow keys, or the arrows where there is a mouse. Pips and arrows show only when there is somewhere to go. Insights can move on by itself (Settings → Brief → Home → "Cycle through the cards", off by default): every seven seconds while it is on screen, paused under the pointer or focus, stopped for good once you touch it, and never under reduced motion.

## Improve

Owner request 2026-11-21: "click a button on the brief to improve or refine it and kick off an agent to do it."

The wand in the brief's header opens one field ("What should change?") and a "Goes to" picker. **Start agent** then does three things, in `server/brief/improve.ts`:

1. Files the request as an item (a thread, titled by its first sentence, your words as its summary) under an area: the one you picked last time, else an area called "Jarvis", else the portfolio coordinator's area, else Miscellaneous. AI-excluded areas are not offered and are refused.
2. Opens a Hermes conversation under that item, on the profile routed for that area (Settings → Agents).
3. Sends the request as the first message, with the same area instructions and filed-chat context a message typed in that chat would carry.

From there it is an ordinary agent conversation: the agent has the tools, approvals and limits it already had, and nothing here gives it more. What it can actually change (code, a pull request, Hermes' own skills) depends on how that agent is set up in Hermes, not on Jarvis.

The brief lists open requests under **In the works** (at most three): the title, and Working, Needs you, Replied or Stopped, read from Jarvis' own run records (no upstream call on read). A row opens the conversation. A request leaves the list when its item is settled, abandoned, superseded or archived.

**Undo** (eight seconds, on the toast) stops the run if it is still going and archives the item and its conversation. It cannot reverse what the agent already did elsewhere.

Rules that hold:

- Only your words and the item they were filed as are sent. No brief content, check-ins or notes ride along.
- A request that contains a credential is refused before anything is created.
- It needs `brief.use`, `hermes.chat` and `work.use` together, and Hermes connected; otherwise there is no button.
- A retry (same `clientKey`) returns the same request; if the conversation or the run cannot be started, the item is archived again and nothing is listed.

## The sparkle: look into this one

Owner request 2026-11-22: "quick actions and suggestions inline on some things like schedule vet appt… an AI sparkle button to click to start researching when and who to call or if it can be scheduled online. And generate next steps."

On some rows of Urgent, In progress and Low priority there is a quiet teal action under the title. Which rows, and what it says, is a rule on the title (`assistIntent` in `lib/brief.ts`), never a model's choice:

| Title has                                     | The action          |
| --------------------------------------------- | ------------------- |
| schedule, book, reserve, appointment          | Find how to book    |
| fix, repair, replace, install, service        | Find who can help   |
| call, phone, contact, email                   | Find who to call    |
| buy, order, quote, compare, choose            | Compare options     |
| renew, cancel, return, register, apply        | Find the steps      |
| plan, organize, arrange                       | Draft a plan        |
| research, look into, find, figure out         | Look into it        |
| an initiative in progress with no next action | Work out next steps |

One tap starts it (`server/brief/assist.ts`), with Undo on the toast:

1. The task is read again on the server (nothing about it is taken from the browser). A task from Areas is looked into where it already lives; anything else (Skylight, Google Tasks) is filed as an item with the same title under the portfolio coordinator's area, else Miscellaneous.
2. A Hermes conversation is opened under that item, on the profile routed for it.
3. The first message is the one task (title, where it lives, when it is due), what to find out, and a request for the next steps, five at most. It says plainly that this is research only: do not book, buy, send, call or change anything, and do not mark the task done.

What comes back is read from Jarvis' own records, never from Hermes on read: the row says the action is under way ("Finding how to book"), then **Needs you**, **Stopped**, or **Next** with the next action the agent left on the item, and "3 more steps" from a note it left there called "Next steps". The line opens the conversation. If the agent has no Jarvis tools the row says **Replied** and the answer is in the conversation. Open requests also show under **In the works**. A row keeps saying so for three days, or until its conversation is archived.

Rules that hold:

- Never offered on, and refused for: Finance, work in an AI-excluded area, a source switched off under Settings → Brief → Shared with the model (for an initiative that is "Areas and initiatives"), and a title that looks like a credential.
- Only that one task is sent. No other row, no brief content, check-ins or notes ride along. On an initiative that means the initiative itself: the first message says where it is filed, and leaves out the snapshot of open items under it that a message typed in that chat would carry (child tasks, their next actions, notes).
- A second tap on a row that is already being looked into returns the same request: one agent per row.
- **Undo** stops the run and archives the conversation, and the item too if Jarvis made it for this. It cannot reverse what the agent already did elsewhere.
- It needs the same three capabilities as Improve, and Hermes connected.

## Two ways it is built

**Rules** (`server/brief/compose.ts` `rulesBrief`): Home's ranked Now and Later today, in order, with Home's own reasons, plus every widget that has data. Computed on read, never stored. This is what you get with AI off, before the first build of the day, and when a build fails.

**AI** (`server/brief/*`, job kind `brief`): one job on the normal AI runner (docs/work.md, AI actions), so the daily budget, the subscription meter, retries, cancel and the spend ledger all apply. Standard tier, hidden Hermes session, no report, no tools. Builds start when you ask (the rewrite button), or once a day in the background after your "Ready by" time when you turned that on (`brief_auto` dispatcher task; stopped by the meter like any background job). At most 4 builds a day per person. A build can wait (in the queue, or held by the budget until the next day), so it is asked again when it runs and when it is stored: if you switched the AI brief off since, or the day it was for is over, it is skipped before any context is built and nothing is sent or saved. Switching the AI brief off also cancels builds that are waiting and asks a running one to stop.

The model never supplies facts. It gets a table of opaque refs (`a` + 6 hex of the action id) and copies them; Jarvis shows the live title, due time and place for each. Its text is narrative only, rendered as plain text (markup and links are stripped, long text is clipped). A ref it was not given, an unknown card kind or a widget with no data is dropped on its own. A card about you (Noticed, Honest take) must cite something Jarvis actually sent, or memory when that is allowed; with nothing behind it, it is dropped. An answer with no headline fails the build (`bad_output`) and the rules brief stays.

A pick that is completed later shows as done; one that is no longer open shows as such. Completions seen that day are recorded on the brief (`outcomes`) and feed the next builds.

## What the model is given

Built when the job runs (`server/brief/context.ts`), from cached Home data already scoped to what you may see. At most 12,000 characters; every untrusted line is flattened to one line inside a `<data>` block.

- Up to 40 open items: Now, Later today, overdue, the next two weeks, waiting, pinned backlog. Ref, bucket, where, title, due, Home's reason.
- Today's and tomorrow's calendar (time and title).
- Daily Compass: today's focus and the last 14 days of the check-in journal.
- Your standing notes.
- Your feedback on briefs from the last 14 days (up to 20), with what each was about and your note.
- What happened to the picks of the last five briefs (done that day or not).
- What you finished in the last seven days (title and where).
- Completed workouts: sessions per week for four weeks, each session of the last 28 days (date and title), and the count for the 28 days before.
- The calendar for the rest of the week.
- Household exceptions and saved dates within 30 days.
- Whether Hermes may draw on its own memory of you. Jarvis sends nothing extra for this; it is one line that allows or forbids it.
- Counts of what is open.

**Never sent:** Finance cards or data; work in AI-excluded areas; anything that looks like a credential (masked per line); full account or card numbers (masked to the last 4). **Your choice** (Settings → Brief → Shared with the model): todos, areas and initiatives, calendar, household, check-ins, workouts, finished work, and Hermes' memory of you. Switching one off hides it from the model only; you still see it on the page.

The runner's import guard (`test/ai-rules.test.ts`) lists `@/server/brief` as a reviewed boundary for this reason: it is the one place AI job code reads source data, and `test/brief.test.ts` pins the exclusions above.

## How it learns

Nothing is learned silently. There are five inputs. Notes and feedback are listed and removable; check-ins can be switched off for the model; pick outcomes live on each stored brief and expire with it (60 days).

A stored brief is shown only while you may still see everything it points at. If access to a source is taken away after today's brief was written, its picks, cards and words may name tasks from that source, so none of it is shown: the page is the rules brief, built from what you may see now, until the next build.

What an earlier brief said is quoted to the next build only under today's rules, not the rules of the day it was written. A past pick, the feedback given on it, and a card with its small steps are left out once their source is switched off, you no longer have access to that source, or the work has moved into an AI-excluded area, and so is a reference Jarvis can no longer place. Feedback on a brief as a whole keeps the verdict and your note; its headline is quoted only while every pick of that brief still may be.

1. **Notes** ("Deep work before 10", "Family dinner is not movable"). Up to 40, used from the next build. They come from proposals you keep and from an import; there is deliberately no "teach it" form on the page or in settings (the owner had it removed, 2026-11-21). `POST /api/brief/notes` still accepts one.
2. **Thumbs on a pick, a card or the whole brief.** "Wrong call" asks what was off; that sentence is quoted to the next builds for 14 days. One reaction per target; tap again to remove; every change offers Undo.
3. **Check-ins.** Jarvis used to hold only today's Daily Compass answer. Each day's validated answer (summary, priorities, and the new optional `tomorrow`: the one thing the check-in named for the next day) is now copied to a journal (`compass_entries`) when it is read, so the brief can look back. Only what the check-in recorded; nothing is invented. The summary is kept once the check-in is complete (before that it is only a status line). The journal has no screen of its own yet and "Forget everything" does not clear it.
4. **What you actually did.** Whether each recent pick was done that day, and how many of the small things on earlier cards you ticked off. A tick is stored on that brief only (no task is created) and unticking is its undo.
5. **Hermes' own memory of you** (on by default, switchable). The check-in conversations, how you talk and how you said you felt live in Hermes, not Jarvis. With this on, the prompt allows Hermes to draw on what it remembers and to cite it ("From what Hermes remembers of you"). Jarvis cannot check those statements, which is why they are labelled, kept out of the picks, and never used for titles, times or counts.

From these the model may propose at most three lasting notes per build, each with a kind (value, principle, driver, pattern) ("Prefers one deep block before noon", with its evidence). A proposal is dashed teal and is **not used until you keep it**. "Not true" dismisses it and it is never proposed again. At most six wait at a time. The prompt forbids proposals about money or other people's private matters, and anything from a single data point.

Settings → Brief lists everything it knows, with import, export (`jarvis-brief-profile.json`) and "Forget everything". Every change here offers Undo, and asks first where it removes or brings in something: forgetting one note, Keep, Not true, an import and "Forget everything". An import adds what is missing and makes a dismissed or proposed note active again; Undo removes what it wrote and sets the ones it revived back as they were. After "Forget everything" the removed notes, proposals and feedback are held in memory only (never written anywhere) for one minute so Undo can put them back; after that, or after a restart, they are gone. The same minute applies to an import.

## Storage

Migration `drizzle/0046_daily_brief.sql` (additive): `briefs` (validated document per build, with pick outcomes and ticked steps; 60 days kept), `brief_feedback`, `brief_notes`, `brief_improvements` (which item and conversation an Improve request or a sparkle became, and for a sparkle which row and what was asked; the text lives on the item), and four journal columns on `compass_entries`. Settings are per person in the settings KV (`brief:user:<id>`).

## API

All routes need `brief.use` (the Improve and sparkle routes also `hermes.chat` and `work.use`), go through `api()` (auth, CSRF, zod) and only ever touch the caller's own rows.

| Route                                                            | What                                                                                      |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `GET /api/brief`                                                 | today's brief (AI build or rules), today's calendar, the deck, build state, feedback      |
| `POST /api/brief/build`                                          | queue an AI build (`clientKey`, `budgetOverride?`); idempotent while one runs             |
| `POST /api/brief/feedback`                                       | `{briefId, targetKey, verdict: up/down/null, note?}`; returns the previous value for Undo |
| `POST /api/brief/steps`                                          | `{briefId, blockId, index, done}`: tick or untick a small step on a card                  |
| `GET/POST /api/brief/notes`, `PATCH/DELETE /api/brief/notes/:id` | notes and proposals                                                                       |
| `GET/PUT /api/brief/settings`                                    | AI on/off, scheduled build, deck cycling, what is shared                                  |
| `POST /api/brief/improve`                                        | `{text, areaId?, clientKey}`: file the request, open the agent's conversation, send it    |
| `POST /api/brief/assist`                                         | `{target: {kind: action or item, id}, clientKey}`: the sparkle on one row                 |
| `DELETE /api/brief/improve/:id`                                  | undo an Improve request or a sparkle: stop the run, archive what was made for it          |
| `GET/POST/DELETE /api/brief/profile`                             | export, import (adds only), forget everything                                             |
| `POST /api/brief/profile/restore`                                | Undo of forget everything or of an import (its `token`; once, within a minute)            |

## Not yet

- Android: the phone app does not show the brief yet (no Kotlin models or screen).
- A "your brief is ready" notification after the scheduled build.
- Briefs written for other times of day (midday, evening). One brief per day, rewritten on request; only the sky, the "right now" line, the open pick and the evening card order follow the clock.
- Steps are ticks, not tasks: nothing turns a step into a todo.
- Improve from a single card ("change this one"): the button is for the whole brief; name the card in your words.
- The sparkle on a big rock or a calendar event: big rocks are free text from the check-in and events are not tasks, so neither can be looked up again on the server yet.
- Choosing where a sparkle is filed: it goes to the portfolio coordinator's area (or where the task already lives); there is no picker.
- Improve has no screen of its own: past requests live in Areas, under the area they were filed in.
- The older Jarvis-built "Morning brief" surface (`/areas/brief`, Smart replies) is unchanged and separate.
