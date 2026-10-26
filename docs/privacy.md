# Privacy: captures and AI

What Jarvis keeps from quick captures, what leaves the box, and for how long. Owner decisions 2026-10-25.

## What's stored

- Captures (text, link, up to 4 files) live in SQLite (`work_inbox`) and files under `${JARVIS_DATA_DIR}/captures/<user>/<random id>` (0600, owner-only download). Jarvis never fetches captured URLs.
- **Photo location**: by default photos are kept exactly as sent, including any GPS position in their metadata. **Settings → AI → Captures → Remove location from captured photos** (off by default) removes GPS coordinates (the EXIF GPS block and XMP GPS fields of JPEG, PNG and WebP) before the file is written. Pixels and other metadata are untouched; GIF has no location metadata. It applies to new captures only.

## Retention

- **Dismissed captures are deleted 30 days after you dismiss them**, together with their attachment files and the AI reports written for them. This runs hourly in the background (also when the general worker is off) and is audited (`capture.purge_dismissed`, ids only). The AI spend ledger (`ai_jobs`: kind, cost, tokens, timestamps, no content) stays.
- Filed captures become Work items; their attachments and reports stay with the item until you delete them.
- Backups (`scripts/backup.mjs`) keep whatever existed when they were taken.

## What goes to AI (Hermes)

- Only with Settings → AI → Enabled and the `work.ai` capability. Captures are triaged with a fast model and, when worthwhile, investigated; the text of the capture and its destination list are sent to Hermes.
- Finance areas and finance- or credential-looking text are never sent (see [work.md](work.md#ai-actions-reports-and-capture-phase-5)).
- Images are listed to the model as "not analysed" until image input is wired into the runner.
