import type { NextAction } from "../../lib/contracts";
import { addDays, localDate, localTimeToInstant } from "../../lib/time";

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

/** Writable source, entirely fixture-owned: no live lists/events leak into screenshots. */
export function skylightWriteVisual(now = new Date()) {
  const fixture = skylightVisual(now);
  const today = localDate(now, "America/Chicago");
  const tomorrow = addDays(today, 1);
  const actions: NextAction[] = fixture.data.actions.map((action, index) => ({
    ...action,
    dueAt: today,
    dueIsDate: true,
    skylight: { kind: "chore", choreId: `vis-${index + 1}`, categoryId: index === 1 ? null : "13600771", recurring: false },
  }));
  const lists = [
    { id: "7001", label: "Visualsky Groceries", kind: "grocery" },
    { id: "7002", label: "Visualsky House projects", kind: "task" },
  ];
  const listItems: NextAction[] = [
    { list: lists[0], itemId: "vis-oat", title: "Visualsky oat milk", status: "open" as const },
    { list: lists[0], itemId: "vis-coffee", title: "Visualsky coffee beans", status: "open" as const },
    { list: lists[0], itemId: "vis-paper", title: "Visualsky paper towels", status: "completed" as const },
    { list: lists[1], itemId: "vis-filter", title: "Visualsky replace furnace filter", status: "open" as const },
  ].map(({ list, itemId, title, status }) => ({
    ...actions[0],
    id: `skylight:list:${itemId}`,
    sourceId: itemId,
    title,
    status,
    sourceLabel: `Skylight · ${list.label}`,
    detail: list.label,
    assignee: undefined,
    primaryAction: undefined,
    skylight: { kind: "list_item", listId: list.id, itemId, listLabel: list.label },
  }));
  return {
    ...fixture,
    data: {
      actions,
      events: [
        {
          id: "skylight:vis-event",
          title: "Visualsky family walk",
          source: "skylight",
          allDay: false,
          startsAt: localTimeToInstant(tomorrow, "16:00", "America/Chicago").toISOString(),
          endsAt: localTimeToInstant(tomorrow, "17:00", "America/Chicago").toISOString(),
          location: "Visualsky park",
          skylight: { eventId: "vis-event", description: "Visualsky afternoon outside", editable: true },
        },
      ],
      extra: {
        ...fixture.data.extra,
        writable: true,
        window: { from: addDays(today, -7), to: addDays(today, 7) },
        lists,
        listItems,
        members: [{ id: "13600771", name: "Nick" }],
        health: { ok: true, failed: [] },
      },
    },
  };
}
