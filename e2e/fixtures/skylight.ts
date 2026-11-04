import type { NextAction } from "../../lib/contracts";

/**
 * /api/sources/skylight for visual tests: two open chores and one done today (fixture text only).
 * Built at test time so freshness (fetchedAt/staleAfter) is real: a fixed past time would show
 * "Last updated N hours ago" on every card.
 */
export function skylightVisual(now = new Date()) {
  const at = now.toISOString();
  const staleAfter = new Date(now.getTime() + 60 * 60_000).toISOString();
  const base = { source: "skylight" as const, fetchedAt: at, staleAfter, href: "https://app.ourskylight.com/", external: true, updatedAt: at };
  const actions: NextAction[] = [
    {
      ...base,
      id: "skylight:vis-1",
      sourceId: "vis-1",
      title: "🪴 Visualsky water the ferns",
      detail: "Skylight chore · Nick",
      sourceLabel: "Skylight · Chores",
      assignee: { kind: "mine", name: "Nick" },
      status: "open",
      priorityReason: "today",
      primaryAction: { kind: "open", label: "Open Skylight" },
    },
    {
      ...base,
      id: "skylight:vis-2",
      sourceId: "vis-2",
      title: "🧺 Visualsky fold the towels",
      detail: "Skylight chore · up for grabs",
      sourceLabel: "Skylight · Up for grabs",
      assignee: { kind: "up_for_grabs" },
      status: "open",
      priorityReason: "today",
      primaryAction: { kind: "open", label: "Open Skylight" },
    },
    {
      ...base,
      id: "skylight:vis-3",
      sourceId: "vis-3",
      title: "🧽 Visualsky wipe the stovetop",
      detail: "Skylight chore · Nick",
      sourceLabel: "Skylight · Chores",
      assignee: { kind: "mine", name: "Nick" },
      status: "completed",
      priorityReason: "today",
    },
  ];
  return {
    status: { source: "skylight", label: "Skylight", state: "ok", fetchedAt: at, staleAfter },
    data: { actions, events: [], extra: { via: "direct", counts: { mine: 1, upForGrabs: 1, others: 0, hidden: 0, completedToday: 1 }, needsMember: false } },
  };
}
