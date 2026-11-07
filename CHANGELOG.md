# Changelog

## 2026-11-07 — Home Assistant control + Finance in AI (owner-approved policy changes)

Both changes were explicitly approved by the owner on 2026-11-07:

- "Yes Jarvis should be able to modify garage door and home assistant devices."
- "[We should] remove the restriction on AI in finance data — we should be able to do that, that muddies the water of features and stuff."

**Home Assistant control.** The default allowed controls now cover lights, switches, input booleans, fans, climate, media players, scenes, scripts, vacuums, covers (including garage Open and Close, which are each other's Undo — #219), locks and alarm panels. Every write is confirmed and read back, with Undo where an inverse exists. Locks, alarm panels and opening a garage are high-risk: an explicit confirm naming the device and its state, a per-person rate limit, the safe direction only on household tablets, and never executed by agents or scheduled jobs — they can only propose a change, which becomes a Needs-you decision. A stored "Allowed controls" value still overrides the default. Details: docs/home-control.md.

**Finance in AI.** The hard-coded "Finance is never sent to AI" exclusion is gone: Finance areas and data work like any other area in the coordinator, catch-me-up, smart cards, Summarize, scheduled jobs (default "Propose only"), MCP agent tools and search/context. The per-area **Exclude from AI** toggle still works for every area, Finance included. Credentials and API tokens are never sent, and full account/card numbers are masked to the last 4 digits before any prompt (`lib/ai-redact.ts`).
