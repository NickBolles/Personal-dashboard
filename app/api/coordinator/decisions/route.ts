import { api } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { DECISION_STATES, sortByUrgency, type DecisionState } from "@/lib/cw-decisions";
import { listDecisionRows } from "@/server/work/decision-store";
import { listItems } from "@/server/work/store";
import { areaIndex } from "@/lib/map-rollup";
import { runRefsById } from "@/server/work/decisions";

/**
 * CW-2 decisions (D-n) for the coordinator Needs-you tab: open ones in urgency order
 * (ageing → risk → soonest default → newest), or ?state=answered|defaulted|superseded|deferred|withdrawn|all.
 */
export const GET = api(
  ({ user, req }) => {
    const raw = req.nextUrl.searchParams.get("state") ?? "open";
    if (raw !== "all" && !(DECISION_STATES as readonly string[]).includes(raw)) throw new HttpError(400, "state", "Unknown state");
    const items = listItems(user.id);
    const live = new Map(items.filter((i) => !i.archived).map((i) => [i.id, i]));
    const areaOf = areaIndex(items);
    const found = listDecisionRows(user.id, raw === "all" ? {} : { states: [raw as DecisionState] }).filter((d) => live.has(d.itemId));
    // "blocks R-n": the run each decision pauses, by its display number.
    const runRefs = runRefsById(
      user.id,
      found.map((d) => d.runId),
    );
    const rows = found.map((d) => ({
      ...d,
      itemTitle: live.get(d.itemId)!.title,
      areaTitle: live.get(areaOf.get(d.itemId) ?? "")?.title,
      ...(d.runId && runRefs.has(d.runId) ? { runRef: runRefs.get(d.runId) } : {}),
    }));
    const decisions = raw === "open" ? sortByUrgency(rows) : rows;
    const counts = { open: 0, deferred: 0 };
    for (const d of listDecisionRows(user.id, { states: ["open", "deferred"] })) if (live.has(d.itemId)) counts[d.state as "open" | "deferred"]++;
    return { decisions: decisions.slice(0, 200), counts };
  },
  { cap: "work.use" },
);
