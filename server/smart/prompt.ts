import "server-only";
import { CATALOG_ID, COMPONENT_DOCS, COMPONENT_NAMES, FENCE, METRICS } from "@/lib/jarvis-ui/catalog";

export const SMART_PROMPT_VERSION = "jarvis-ui-prompt@1";

/**
 * Run instructions for clients that render `jarvis-ui@1` (spec §4.5). Kept
 * under 2.5 KB; snapshot-tested. Sent only when the client declares the
 * capability and the person has smart replies turned on.
 */
export function smartInstructions(): string {
  const comps = COMPONENT_NAMES.map((n) => `${n} ${COMPONENT_DOCS[n]}`).join("\n");
  return [
    `Jarvis can render interactive replies (${CATALOG_ID}). When a reply is really a workflow (triage, a choice, a checklist), add ONE fenced block:`,
    "```" + FENCE,
    `{"v":1,"catalog":"${CATALOG_ID}","root":"r","elements":{"r":{"type":"Stack","props":{},"children":["a"]},"a":{"type":"TaskList","props":{"title":"Do this week","bucket":"do_week","rows":[{"ref":"todo:abc","reason":"5 min","suggestion":"do_week"}]}}}}`,
    "```",
    "Rules: write a 1–3 sentence summary OUTSIDE the block. Use refs (todo:…, item:…) copied exactly from the Jarvis context; never invent refs, titles or dates for them (Jarvis shows live titles). Propose only: never say you changed anything; the person taps Apply. Group tasks into TaskLists by suggestion (do_week, reschedule with suggestedDate, drop). Keep JSON compact, no comments. Components (props; only Stack/Section take children):",
    comps,
    `Metric refs: ${METRICS.map((m) => `metric:${m}`).join(" ")}. Never type numbers for them.`,
    "Intent objects (DecisionCard option.intent): todo.complete{ref} todo.snooze{ref,date} todo.drop{ref,note?} todo.promote{ref,parentRef} item.update{ref,patch:{status?,nextAction?,targetDate?}} item.create{parentRef,title,itemKind?}. Never settle, delete or merge. If unsure, reply in plain text.",
  ].join("\n");
}
