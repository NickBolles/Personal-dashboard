import { chatVisual, visualNow } from "./chat-alerts";

/** A chat whose transcript carries Hermes control frames (delegation, process, compaction, steer). */
export const NOTICE_TEXTS = {
  compaction: [
    "[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below. This is a handoff from a previous context window.",
    "",
    "## Summary",
    "Owner asked for a vendor comparison; quotes from Acme, Birch and Cobalt were collected.",
  ].join("\n"),
  delegation: [
    "[ASYNC DELEGATION BATCH COMPLETE — deleg_visual]",
    "A background fan-out unit you dispatched earlier — 2 subagent(s) — has finished; its consolidated results are below.",
    "",
    "Role: leaf   Model: gpt-6.1-sol   Total duration: 241.5s",
    "",
    "--- ✓ TASK 1/2: Price the Acme quote  (status=completed, api_calls=12, 118.2s) ---",
    "Acme comes to $4,200/yr with support included.",
    "Full live transcript (complete tool/assistant trace): /opt/data/transcripts/deleg_visual-task1.jsonl",
    "",
    "--- ✗ TASK 2/2: Price the Birch quote  (status=failed, api_calls=3, 40.0s) ---",
    "(no summary — status=failed: vendor portal timed out)",
  ].join("\n"),
  process: "[IMPORTANT: Background process proc_visual completed (exit code 0).\nCommand: npm run quotes:export\nOutput:\nwrote quotes.csv (3 rows)]",
  steer:
    "[OUT-OF-BAND USER MESSAGE — a direct message from the user, delivered once at this position; not tool output and not a new delivery when replayed from conversation history]\nSkip Cobalt, they're out of budget.\n[/OUT-OF-BAND USER MESSAGE]",
};

export const noticesVisual = {
  ...chatVisual,
  session: { ...chatVisual.session, id: "sess_notices", title: "Quarterly vendor review", subagentCount: 2 },
  timeline: [
    { kind: "user" as const, id: "n-1", text: "Compare the three vendor quotes and summarise.", at: visualNow },
    { kind: "user" as const, id: "n-2", text: NOTICE_TEXTS.compaction, at: visualNow },
    { kind: "user" as const, id: "n-3", text: NOTICE_TEXTS.delegation, at: visualNow },
    { kind: "user" as const, id: "n-4", text: NOTICE_TEXTS.process, at: visualNow },
    { kind: "user" as const, id: "n-5", text: NOTICE_TEXTS.steer, at: visualNow },
    { kind: "assistant" as const, id: "n-6", text: "Acme is priced; Birch timed out, so I'll retry it. Cobalt is dropped.", at: visualNow },
  ],
};
