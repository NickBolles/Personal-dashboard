import type { AwayDigest } from "../../lib/away";
import type { NextAction } from "../../lib/contracts";
import { addDays, localDate } from "../../lib/time";
import { skylightGroupingVisual } from "./skylight";

// Both sides of DST have explicit instants; browser, response freshness and seed dates share this clock.
export const TASK_UX_CLOCKS = ["2026-11-01T07:30:00.000Z", "2026-03-08T08:30:00.000Z"] as const;
export function skylightTaskUxFixture(instant: string = TASK_UX_CLOCKS[0]) {
  const now = new Date(instant);
  const day = localDate(now, "America/Chicago");
  const source = skylightGroupingVisual(now);
  const base = source.data.actions[0];
  const row = (id: string, title: string, date: string, frequency: string): NextAction => ({
    ...base,
    id: `skylight:${id}`,
    sourceId: id,
    title,
    status: "open",
    dueAt: undefined,
    skylight: { kind: "chore", choreId: id, categoryId: "13600771", recurring: true, instanceDate: date, startDate: date, recurrenceFrequency: frequency },
  });
  source.data.actions.push(
    row("daily-future", "Daily tomorrow hidden", addDays(day, 1), "DAILY"),
    row("weekly-future", "Weekly tomorrow visible", addDays(day, 1), "WEEKLY"),
    row("daily-today", "Daily today visible", day, "DAILY"),
    row("daily-overdue", "Daily overdue visible", addDays(day, -1), "DAILY"),
    {
      ...row("skipped", "Skipped routine, not completed", day, "DAILY"),
      status: "skipped",
      primaryAction: undefined,
      skylight: { kind: "chore", choreId: "skipped", categoryId: "13600771", startDate: day, skippedOn: day },
    },
  );
  const away: AwayDigest = {
    runs: [],
    since: `${day}T00:00:00.000Z`,
    line: "While you were away: 1 chore completed · 1 chore skipped",
    counts: { ran: 0, failed: 0, changes: 0, needsYou: 0, running: 0, waiting: 0 },
    chores: [
      { id: "done-recap", title: "Completed kitchen routine", status: "completed", at: instant },
      { id: "skip-recap", title: "Skipped routine, not completed", status: "skipped", at: instant },
    ],
  };
  return { source, away, now, day };
}
