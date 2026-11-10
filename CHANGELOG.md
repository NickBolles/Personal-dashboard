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
- **Catch-up card.** "Since 8:39 AM · 2 h" is a small card whose chips say what moved and jump to it:
  "1 failed", "2 new decisions", "1 waiting on you", "1 stuck", "2 finished", "2 runs updated".

## 2026-11-07 — Home Assistant control + Finance in AI (owner-approved policy changes)

Both changes were explicitly approved by the owner on 2026-11-07:

- "Yes Jarvis should be able to modify garage door and home assistant devices."
- "[We should] remove the restriction on AI in finance data — we should be able to do that, that muddies the water of features and stuff."

**Home Assistant control.** The default allowed controls now cover lights, switches, input booleans, fans, climate, media players, scenes, scripts, vacuums, covers (including garage Open and Close, which are each other's Undo — #219), locks and alarm panels. Every write is confirmed and read back, with Undo where an inverse exists. Locks, alarm panels and opening a garage are high-risk: an explicit confirm naming the device and its state, a per-person rate limit, household tablets limited to garage open/close, lock/unlock and arming (never disarm; owner decision 2026-11-07: "Yes shared tablet should be able to control garages and doors."), and never executed by agents or scheduled jobs — they can only propose a change, which becomes a Needs-you decision. A stored "Allowed controls" value still overrides the default. Details: docs/home-control.md.

**Finance in AI.** The hard-coded "Finance is never sent to AI" exclusion is gone: Finance areas and data work like any other area in the coordinator, catch-me-up, smart cards, Summarize, scheduled jobs (default "Propose only"), MCP agent tools and search/context. The per-area **Exclude from AI** toggle still works for every area, Finance included. Credentials and API tokens are never sent, and full account/card numbers are masked to the last 4 digits before any prompt (`lib/ai-redact.ts`).
