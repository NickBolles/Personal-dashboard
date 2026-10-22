import type { NextAction } from "@/lib/contracts";
import { isValidationOverdue } from "@/lib/work";
import { baseAction, classifyDateOnly } from "@/integrations/actions";
import type { AdapterContext } from "@/integrations/types";

/**
 * Work cards for Home attention (docs/home-priorities.md, docs/work.md). Pure
 * and deterministic: the attention selector ranks them like any other
 * date-only card, inside the same Now ≤ 3 budget.
 *
 * - Awaiting validation with an overdue validation → "Validate: …", due on
 *   the earliest overdue validation's date (so it ranks as overdue).
 * - In progress with a target date today or earlier → due on the target date.
 */
export const WORK_STALE_MS = 15 * 60_000;

type Row = { id: string; title: string; status: string; nextAction: string; targetDate: string | null; updatedAt: string };
type Val = { itemId: string; metric: string; status: string; dueDate: string | null };

export function workHomeActions(rows: Row[], vals: Val[], ctx: AdapterContext): NextAction[] {
  const out: NextAction[] = [];
  for (const r of rows) {
    const href = `/work?item=${encodeURIComponent(r.id)}`;
    if (r.status === "awaiting_validation") {
      const late = vals.filter((v) => v.itemId === r.id && isValidationOverdue(v, ctx.today));
      if (late.length) {
        const first = late.map((v) => v.dueDate!).sort()[0]!;
        const due = classifyDateOnly(first, ctx);
        out.push(
          baseAction("work", `validation:${r.id}`, ctx, WORK_STALE_MS, {
            title: `Validate: ${r.title}`,
            detail: `${late.length} validation${late.length === 1 ? "" : "s"} overdue: ${late
              .map((v) => v.metric)
              .sort()
              .join(", ")}`,
            status: "open",
            priorityReason: due.reason,
            dueAt: due.dueAt,
            dueIsDate: true,
            updatedAt: r.updatedAt,
            href,
            primaryAction: { kind: "open", label: "Record evidence" },
          }),
        );
      }
    }
    if (r.status === "in_progress" && r.targetDate && r.targetDate <= ctx.today) {
      const due = classifyDateOnly(r.targetDate, ctx);
      out.push(
        baseAction("work", `target:${r.id}`, ctx, WORK_STALE_MS, {
          title: r.title,
          detail: [r.targetDate === ctx.today ? "Target date is today" : "Past its target date", r.nextAction ? `Next: ${r.nextAction}` : ""]
            .filter(Boolean)
            .join(" · "),
          status: "open",
          priorityReason: due.reason,
          dueAt: due.dueAt,
          dueIsDate: true,
          updatedAt: r.updatedAt,
          href,
          primaryAction: { kind: "open", label: "Open" },
        }),
      );
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
