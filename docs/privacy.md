# Privacy: captures and AI

What Jarvis keeps from quick captures, what leaves the box, and for how long. Owner decisions 2026-10-25.

## What's stored

- Captures (text, link, up to 4 files) live in SQLite (`work_inbox`) and files under `${JARVIS_DATA_DIR}/captures/<user>/<random id>` (0600, owner-only download). Jarvis never fetches captured URLs.
- **Photo location**: by default photos are kept exactly as sent, including any GPS position in their metadata. **Settings → AI → Captures → Remove location from captured photos** (off by default) removes GPS coordinates (the EXIF GPS block and XMP GPS fields of JPEG, PNG and WebP) before the file is written. Pixels and other metadata are untouched; GIF has no location metadata. It applies to new captures only.

## Retention

- **Dismissed captures are deleted 30 days after you dismiss them**, together with their attachment files, the AI reports written for them and the alerts that point at them. This runs hourly in the background (also when the general worker is off) and is audited (`capture.purge_dismissed`, ids only). The AI spend ledger (`ai_jobs`: kind, cost, tokens, timestamps) stays, with its capture-derived parameters (such as the investigation brief) cleared. An investigation conversation filed in Hermes is Hermes' to keep or delete (Jarvis doesn't copy it).
- Filed captures become Work items; their attachments and reports stay with the item until you delete them.
- Backups (`scripts/backup.mjs`) keep whatever existed when they were taken.

## What goes to AI (Hermes)

- Only with Settings → AI → Enabled and the `work.ai` capability. Captures are triaged with a fast model and, when worthwhile, investigated; the text of the capture and its destination list are sent to Hermes.
- Finance follows the same per-area AI policy as every area (owner-approved 2026-11-07). Excluded areas and their subtrees stay out; credentials/tokens/passwords are hard-blocked, and full account/card numbers are masked to last 4 before any model text leaves (see [work.md](work.md#ai-actions-reports-and-capture-phase-5)).
- Images are listed to the model as "not analysed" until image input is wired into the runner.
- **Daily brief** (docs/brief.md): off until a person turns it on for themselves. A build sends their open item titles and due times, today's and tomorrow's calendar, their Daily Compass check-in journal, the notes they taught it and their feedback on recent briefs. Finance and AI-excluded areas are never sent; each source can be switched off in Settings → Brief, and what earlier briefs said about a source (past picks, feedback on them) stops being sent once it is switched off or the work moves into an AI-excluded area. Jarvis stores only the validated brief (60 days), never the prompt or the raw answer. "Improve" on the brief sends only the sentence you typed (and the item it was filed as) to the Hermes agent of the area you chose, as a normal chat message; a request containing a credential is refused. The sparkle on a row of the brief sends that one task (its title, where it lives and when it is due) to the Hermes agent of the area it is filed in, as a normal chat message that asks for research only; it is never offered on Finance, AI-excluded work, a source you switched off for the brief, or a title that looks like a credential.
