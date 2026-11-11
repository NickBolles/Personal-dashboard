# Changelog

## 2026-11-10 — Chief of staff and chat clarity pass

What changed for the owner (details in the PR):

- **One honest status.** The phone tray is one button with one sentence ("Checkout smoke tests stalled · 21 need you · 2 working") instead of "Failing · Chief of staff" plus `!23` / `↻14` badges. A run that got stuck _after_ you last opened Activity turns it red; once you have looked it is still counted ("3 stuck") but no longer shouts, and failures older than three days fold under "Older failures". Rules: `lib/coordinator/status.ts`.
- **Three tabs, not five.** Chat · Needs you · Activity. Activity is what agents are doing (Stuck, Working, Finished since you looked) plus what the Chief of staff changed (grouped by item, with Undo). The Context tab is now the page chip in the composer (Ask about this page · remove · share again).
- **Needs you reads like a list of questions.** The question is the headline, the D-n ref is a quiet handle, an item title that only repeats the question is dropped, paragraph-long agent "questions" get a short heading and the rest as body text, raw statuses (`ready_to_settle`) read as words, run approvals lead the list, and stalled runs are no longer listed here a second time (they are in Activity). No more sideways overflow.
- **Sleeker controls.** Inside the panel, actions are quiet text or small icons at every width (tap areas stay generous through hit-slop); decision answers are compact, aligned option cards with the risk stated before the second tap.
- **Coordinator composer parity.** The Chief of staff composer has the full chat’s add menu (photo or file, camera, context) and paste-to-attach, and its replies render smart (`jarvis-ui`) blocks through the same renderer as full chat.
- **Full chat.** An idle conversation no longer carries a status tray of zeros; your messages show your words (page context becomes a caption, one-tap decisions a receipt); the conversation list gives titles the row.

Optimised for a Galaxy Z Fold 6 at normal zoom, closed and unfolded (`scripts/ux-shots.mjs` has both sizes). Demo data for all of this: `node scripts/demo-seed-coordinator.mjs`.

- **Run cards.** Every run in Activity, and every piece of background work in Chat, is one card that reads
  without opening anything: a tinted state chip ("Stuck · no update for 47 min", "Waiting on you", "Failed",
  "Working", "Done"), the title, who is on it, pipeline stage pills, and a real timeline (newest first, a
  coloured node and type chip per event: Progress, Notice, CI, Lock, Staged, Live, Failed…, in the tones the
  item pages use for PR / checks / deploy). The first few runs that need you arrive open with their last three
  events; "Show N earlier" loads the rest. Steer / Retry / Ask / Pull request / Open item / Stop live in one
  quiet icon-and-word bar at the card's bottom edge.
- **Kept current in place.** Activity polls every 10 s while it is on screen and says so ("Live · checked just
  now"); background work in Chat polls every 5 s while anything runs, 15 s otherwise. If a refresh fails the
  line says exactly that, with the age of what is shown and "Try again", instead of "may be out of date".
  Background-work cards show the step in progress, the outcome or the error, progress when the source
  reports it, and their links, ordered failed → waiting → working → done.
- **Item and project cards.** Wherever the Chief of staff lists what it changed (Activity → Changes, and under
  a reply in Chat), each item or project is a card in the same family as the run cards: one state chip for
  what matters now ("Needs you" when a decision is open on it, "Run failed", "Run stuck", "Working", else its
  own status), where it sits, the next step and a due chip ("Due Nov 22", "Overdue 3 d"), who is on it when
  someone is working, progress, pull requests with their state / checks / deploy pills, and chips that jump
  straight to the open decision (D-n) or run (R-n). A project gathers the decisions and runs under it. The
  changes are a timeline with a chip per kind (Created, Edit, Status, Dates, Tags, Link, Decision, Run) and
  only the words the chip cannot say ("Target Nov 22", not "Dates: start — → —, target — → 2026-11-22");
  every change keeps its own Undo. Opening a card adds its summary, the last agent report, Open item, Ask
  and the agent's conversation. Cards read the same live queries as the rest of the app.
- **Life.** The cards move where it means something, in the app's own motion vocabulary. Work in flight has
  light travelling round the card's outline in the theme's agent colour (an indeterminate "still going"), the
  agent's mark turning inside the "Working" chip, and a pulsing newest event; work that has gone quiet is still. An event that arrives while you watch slides in
  and glows once; a run that finishes pops with a few sparks; each sync blinks the dot. A thin strip on every
  run shows when it reported from its start to now, so a steady run and one that went silent look different at
  a glance. Item cards have their chip timeline back (the chip is the verb, in the colour of its kind), three
  changes showing. Everything stops under "reduce motion".
- **Times against now.** Run timelines say "12 min ago", "3 h ago", "2 d ago" (the exact time is the tooltip),
  the same way item timelines do.
- **Right-click or long-press a card.** Every run, item, project and background-work card opens a menu of
  everything it can do in its current state, without opening the card first: Steer / Reply, Retry, "Resume
  without replying", Ask in chat, open the item or pull request, jump to its decisions and runs, copy the ref
  or link, Ask to stop (still behind its confirmation). A long press on the phone tray goes straight to Chat,
  Needs you or Activity. The Menu key and Shift+F10 open the same menu from the keyboard.
- **Nothing lost in the redesign.** An audit against `main` found no removed capability; what had become
  harder to reach or stopped being shown is back: a sub-agent that outlives its tracked run can still be
  steered and stopped (from the menu), a run says how many steps it has reported, an item that is no longer
  listed offers "Try opening it", and a background-work source that could not be read is said even when there
  is nothing to list.
- **Council round 7 (the whole change, before merge).** What all three reviewers agreed on: the tray uses the
  cards' words ("2 runs went quiet", "2 runs failed", "3 runs need a look"; silence is never called stuck);
  the time beside "Working" is the time of the newest report, in the timeline's own format, so the two cannot
  disagree; only a report under two minutes old pulses; the reporting strip is labelled ("Reports … now"); work
  in flight keeps its order when one run reports; a catch-up chip lands on the section it was about and marks
  it for a moment; a waiting run's reply button is Resume while the field is empty and Send once there is an answer; a sub-agent that outlives
  its run keeps Steer and Stop on its card; menu entries name what a D-n or R-n is; ages dim while refreshes
  fail. Nothing a card can do is menu-only any more (the tray's long-press jump is the one accelerator).
- **Catch-up card.** "Since 8:39 AM · 2 h" is a small card whose chips say what moved and jump to it:
  "1 failed", "2 new decisions", "1 waiting on you", "1 stuck", "2 finished", "2 runs updated".

## 2026-11-07 — Home Assistant control + Finance in AI (owner-approved policy changes)

Both changes were explicitly approved by the owner on 2026-11-07:

- "Yes Jarvis should be able to modify garage door and home assistant devices."
- "[We should] remove the restriction on AI in finance data — we should be able to do that, that muddies the water of features and stuff."

**Home Assistant control.** The default allowed controls now cover lights, switches, input booleans, fans, climate, media players, scenes, scripts, vacuums, covers (including garage Open and Close, which are each other's Undo — #219), locks and alarm panels. Every write is confirmed and read back, with Undo where an inverse exists. Locks, alarm panels and opening a garage are high-risk: an explicit confirm naming the device and its state, a per-person rate limit, household tablets limited to garage open/close, lock/unlock and arming (never disarm; owner decision 2026-11-07: "Yes shared tablet should be able to control garages and doors."), and never executed by agents or scheduled jobs — they can only propose a change, which becomes a Needs-you decision. A stored "Allowed controls" value still overrides the default. Details: docs/home-control.md.

**Finance in AI.** The hard-coded "Finance is never sent to AI" exclusion is gone: Finance areas and data work like any other area in the coordinator, catch-me-up, smart cards, Summarize, scheduled jobs (default "Propose only"), MCP agent tools and search/context. The per-area **Exclude from AI** toggle still works for every area, Finance included. Credentials and API tokens are never sent, and full account/card numbers are masked to the last 4 digits before any prompt (`lib/ai-redact.ts`).
