import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { isClosed, isValidationOverdue, type TodayCard, type TodayResponse, type WorkStatus } from "@/lib/work";
import { itemsWithValidations } from "./store";

/**
 * Today, the /work front door (owner decision: /work opens on Today /
 * Continue). Computed per person from local data only: KPIs, 1–3 things to
 * continue, proof due, merged-but-not-settled work and overdue work.
 */

const CONTINUE_STATUSES = new Set<WorkStatus>(["in_progress", "ready", "reopened", "in_review"]);

export function today(userId: string): TodayResponse {
  const { rows, vals, today: t } = itemsWithValidations(userId);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const path = (id: string) => {
    const parts: string[] = [];
    for (let c = byId.get(byId.get(id)?.parentId ?? ""); c && parts.length < 6; c = c.parentId ? byId.get(c.parentId) : undefined) parts.unshift(c.title);
    return parts.join(" › ");
  };
  const card = (r: (typeof rows)[number], extra: Partial<TodayCard> = {}): TodayCard => ({
    id: r.id,
    title: r.title,
    path: path(r.id),
    status: r.status as WorkStatus,
    nextAction: r.nextAction,
    ...extra,
  });
  const work = rows.filter((r) => r.kind !== "area");
  const ids = work.map((r) => r.id);
  const merged = ids.length
    ? new Set(
        getDb()
          .select({ itemId: schema.workLinks.itemId })
          .from(schema.workLinks)
          .where(
            and(
              inArray(schema.workLinks.itemId, ids),
              eq(schema.workLinks.kind, "github_pr"),
              eq(schema.workLinks.role, "implementation"),
              eq(schema.workLinks.externalState, "merged"),
            ),
          )
          .all()
          .map((l) => l.itemId),
      )
    : new Set<string>();
  const overdueVal = new Set(vals.filter((v) => isValidationOverdue(v, t)).map((v) => v.itemId));
  const overdueRows = work.filter((r) => !isClosed(r.status) && ((!!r.targetDate && r.targetDate < t) || overdueVal.has(r.id)));

  const proofDue = work
    .filter((r) => r.status === "awaiting_validation")
    .map((r) => {
      const pending = vals.filter((v) => v.itemId === r.id && (v.status === "pending" || v.status === "fail"));
      const due =
        pending
          .map((v) => v.dueDate)
          .filter((d): d is string => !!d)
          .sort()[0] ?? null;
      const detail = pending.length
        ? pending
            .slice(0, 2)
            .map((v) => `${v.metric} ${v.comparator} ${v.threshold}${v.unit ? ` ${v.unit}` : ""}`)
            .join(" · ")
        : "Add a validation";
      return card(r, { due, detail });
    })
    .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.title.localeCompare(b.title));

  const cont = work
    .filter((r) => CONTINUE_STATUSES.has(r.status as WorkStatus))
    .sort(
      (a, b) =>
        (a.status === "in_progress" ? 0 : 1) - (b.status === "in_progress" ? 0 : 1) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
    )
    .slice(0, 3)
    .map((r) => card(r));

  return {
    today: t,
    kpis: {
      inProgress: work.filter((r) => r.status === "in_progress").length,
      awaitingValidation: work.filter((r) => r.status === "awaiting_validation").length,
      overdue: overdueRows.length,
      mergedNotSettled: work.filter((r) => merged.has(r.id) && !isClosed(r.status)).length,
    },
    continue: cont,
    proofDue: proofDue.slice(0, 5),
    readyToSettle: work
      .filter((r) => r.status === "ready_to_settle")
      .slice(0, 5)
      .map((r) => card(r, { detail: "PR merged — settle?" })),
    overdue: overdueRows.slice(0, 5).map((r) => card(r, { due: r.targetDate, detail: overdueVal.has(r.id) ? "Validation overdue" : "Past its target date" })),
  };
}
